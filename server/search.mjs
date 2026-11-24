// server/search.mjs — 免 key 的网页搜索（只在本地 Node 里跑，浏览器不直接碰搜索引擎）
//
// 为什么放在 dev-server 这一侧：浏览器直接 fetch 搜索站点全被 CORS 挡死
// （html/lite.duckduckgo.com、searx 各实例都是 TypeError: Failed to fetch；mojeek 403；
// s.jina.ai 401），而 Node 里同样的请求都通。所以浏览器只调同源 /search。
//
// 引擎顺序 + 失败切换：ddg-html → bing → ddg-lite。
// 解析正则抄自本机 dsh-free-search 插件的 lib/engines/*（只抄正则与判据，不引依赖）。
//
// 输出归一：{ results: [{ title, url, snippet }], engine }。全挂时抛 code=search_failed。

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";

/** 每个引擎的硬超时（AbortSignal.timeout） */
const ENGINE_TIMEOUT_MS = 8000;

/** recency → DDG 的 df 档位（DDG 只认固定档） */
const RECENCY_DF = { day: "d", week: "w", month: "m" };

// ---------------------------------------------------------------- 纯函数（抄 shared.js）
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** DDG 把外链包成 //duckduckgo.com/l/?uddg=<encodeURIComponent(url)>，取出真地址 */
function extractDdgUrl(rel) {
  if (!rel) return null;
  const m = rel.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  if (rel.startsWith("//")) return "https:" + rel;
  return rel;
}

/** Bing 把外链包成 bing.com/ck/a?u=a1<base64url>，解出真地址 */
function extractBingUrl(href) {
  if (!href) return href;
  const url = decodeEntities(href);
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return url;
  try {
    const u = new URL(url).searchParams.get("u");
    if (!u) return url;
    const b64 = u.startsWith("a1") ? u.slice(2) : u;
    const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** 查询的相关性 token：CJK 取二元组（单字太泛），拉丁/数字取长度 >= 2 的词 */
function queryOverlapTokens(query) {
  const tokens = new Set();
  for (const run of String(query).match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 2) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const word of String(query).toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return [...tokens];
}

/**
 * 这一批结果和查询有没有共同词汇。
 * 必抄：Bing 在「查询无结果」时会返回一张完全无关的缓存 SERP（b_algo 照样存在，
 * 内容是别的查询），不判就会把垃圾喂给模型。
 */
function looksRelevant(query, sources) {
  const tokens = queryOverlapTokens(query);
  if (tokens.length === 0) return true; // 纯符号/单字查询判不了，放过
  const strong = tokens.filter((t) => !/^\d+$/.test(t));
  const usable = strong.length > 0 ? strong : tokens;
  // 短 ASCII 词（gt/max）常是模型后缀不是主题；标题命中要求 CJK 二元组或长度 >= 4 的词
  const titleStrong = strong.filter((t) => /[\u4e00-\u9fff]/.test(t) || t.length >= 4);
  const titleTokens = titleStrong.length > 0 ? titleStrong : usable;
  const matched = new Set();
  const titleMatched = new Set();
  let relevant = 0;
  for (const source of sources) {
    const title = String(source.title ?? "").toLowerCase();
    const hay = (title + " " + (source.snippet ?? "") + " " + (source.url ?? "")).toLowerCase();
    const hits = usable.filter((t) => hay.includes(t.toLowerCase()));
    if (hits.length > 0) {
      relevant += 1;
      for (const hit of hits) matched.add(hit);
      for (const hit of titleTokens) {
        if (title.includes(hit.toLowerCase())) titleMatched.add(hit);
      }
    }
  }
  const enoughSources = relevant >= Math.max(1, Math.ceil(sources.length / 3));
  const enoughTokens = matched.size >= Math.min(2, usable.length) || matched.size / usable.length >= 0.5;
  return enoughSources && enoughTokens && titleMatched.size > 0;
}

/** 去重的归一化：去掉 #片段 与 utm_* 参数 */
function normalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/** 按规范化 URL 去重 + 截断字段长度 */
function uniqueSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const url = normalizeUrl(s && s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(s.title || "").trim().slice(0, 200),
      url: url.slice(0, 600),
      snippet: String(s.snippet || "").trim().slice(0, 400),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- 请求
function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

/** Bing 必须按查询语言切换 Accept-Language：带 en 的中文查询会返回 0 条 b_algo */
function acceptLanguageFor(query) {
  return hasCjk(query) ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9";
}

/** DDG 反爬页的重试次数与间隔（挑战页回得很快，重试一次成本很低） */
const CHALLENGE_RETRIES = 2;
const CHALLENGE_RETRY_DELAY_MS = 1200;

async function fetchHtml(url, query, signal) {
  const signals = [AbortSignal.timeout(ENGINE_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": acceptLanguageFor(query),
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  // 202 + 反爬页：DDG 在限流时会回一张 anomaly/challenge 页面（状态码仍是 2xx），
  // 解析它只会得到 0 条，所以这里直接判成失败，让回退链继续。
  if (res.status === 202 && /anomaly|challenge/i.test(html)) {
    const e = new Error("anti-bot challenge (HTTP 202)");
    e.code = "challenge";
    throw e;
  }
  return html;
}

/** DDG 限流是暂时的：挑战页重试一次多半就好（Bing 不重试，它超时就 8s，重试会顶穿工具超时） */
async function fetchHtmlRetry(url, query, signal) {
  let lastError;
  for (let attempt = 1; attempt <= CHALLENGE_RETRIES; attempt++) {
    try {
      return await fetchHtml(url, query, signal);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      lastError = err;
      if (!err || err.code !== "challenge") break;
      if (attempt < CHALLENGE_RETRIES) {
        await new Promise((r) => setTimeout(r, CHALLENGE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------- 引擎
/** ddg-html：result__a 取链接与标题，result__snippet 取摘要 */
async function searchDdgHtml(query, limit, recency, signal) {
  const params = new URLSearchParams({ q: query, adlt: "-1" });
  const df = RECENCY_DF[recency];
  if (df) params.set("df", df);
  const html = await fetchHtmlRetry(DDG_HTML_URL + "?" + params, query, signal);
  const blocks = html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) ?? [];
  const rows = [];
  for (const block of blocks) {
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/);
    const url = extractDdgUrl(urlMatch && urlMatch[1]);
    if (!url) continue;
    rows.push({
      url,
      title: titleMatch ? stripTags(titleMatch[1]) : "",
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
    });
  }
  return uniqueSources(rows, limit);
}

/** bing：b_algo 切块，h2 > a 取标题、p 取摘要；链接要解 ck/a 包装 */
async function searchBing(query, limit, recency, signal) {
  const params = new URLSearchParams({ q: query, setlang: hasCjk(query) ? "zh-CN" : "en-US" });
  const df = RECENCY_DF[recency];
  if (df) {
    // Bing 的时间过滤参数名与档位都和 DDG 不同
    params.set("filters", "ex1%3a%22ez" + (recency === "day" ? "1" : recency === "week" ? "2" : "3") + "%22");
  }
  const html = await fetchHtml(BING_URL + "?" + params, query, signal);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const rows = [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!hrefMatch) continue;
    rows.push({
      url: extractBingUrl(hrefMatch[1]),
      title: titleMatch ? stripTags(titleMatch[1]) : "",
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
    });
  }
  return uniqueSources(rows, limit);
}

/** ddg-lite：result-link 与 result-snippet 按 index 一一对应 */
async function searchDdgLite(query, limit, recency, signal) {
  const params = new URLSearchParams({ q: query, adlt: "-1" });
  const df = RECENCY_DF[recency];
  if (df) params.set("df", df);
  const html = await fetchHtmlRetry(DDG_LITE_URL + "?" + params, query, signal);
  const linkMatches = html.match(/<a[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/g) ?? [];
  const snippetMatches = html.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g) ?? [];
  const rows = [];
  for (let i = 0; i < linkMatches.length; i++) {
    const tag = linkMatches[i];
    const hrefMatch = tag.match(/href="([^"]*)"/);
    if (!hrefMatch) continue;
    const url = extractDdgUrl(hrefMatch[1]);
    if (!url) continue;
    const titleMatch = tag.match(/class=['"]result-link['"][^>]*>(.*?)<\/a>/);
    const snippetRaw = snippetMatches[i]
      ? (snippetMatches[i].match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/) || [])[1]
      : "";
    rows.push({
      url,
      title: titleMatch ? stripTags(titleMatch[1]) : "",
      snippet: snippetRaw ? stripTags(snippetRaw) : "",
    });
  }
  return uniqueSources(rows, limit);
}

// ---------------------------------------------------------------- 入口
const ENGINES = [
  { name: "ddg-html", run: searchDdgHtml },
  { name: "bing", run: searchBing },
  { name: "ddg-lite", run: searchDdgLite },
];

/**
 * 依次试三个引擎，第一个「有结果且通过相关性检查」的就返回。
 * @param {{query: string, limit?: number, recency?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{results: Array<{title:string,url:string,snippet:string}>, engine: string}>}
 */
export async function runSearch({ query, limit = 5, recency, signal } = {}) {
  const text = String(query || "").trim();
  if (!text) {
    const e = new Error("query 不能为空");
    e.code = "bad_args";
    throw e;
  }
  const want = Math.max(1, Math.min(20, Number(limit) || 5));
  const range = ["day", "week", "month"].includes(recency) ? recency : "";

  const failures = [];
  for (const engine of ENGINES) {
    try {
      const rows = await engine.run(text, want, range, signal);
      if (rows.length >= 1 && looksRelevant(text, rows)) {
        return { results: rows, engine: engine.name };
      }
      failures.push({
        engine: engine.name,
        reason: rows.length ? "looks_irrelevant" : "no_results",
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      failures.push({ engine: engine.name, reason: (err && err.message) || String(err) });
    }
  }

  const e = new Error(
    "所有搜索后端都没拿到结果（" + failures.map((f) => f.engine + ": " + f.reason).join("；") + "）"
  );
  e.code = "search_failed";
  e.detail = failures;
  throw e;
}

// 三个引擎单独导出：只给自测/排查用（runSearch 是唯一对外入口）
export { searchDdgHtml, searchBing, searchDdgLite, ENGINES };

export default runSearch;
