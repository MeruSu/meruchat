// js/core/tools/web-search.js — web_search 工具
// 只把 title / url / snippet 交回模型：正文永不进上下文（省 token，也让结果可复核）。
//
// 引擎顺序固定：tavily → firecrawl → exa → bing。前三个是免 key 且浏览器 CORS 已放行的
// 公开端点，直接 fetch；只有 bing 没有 CORS，要走原生通道或用户自配的 searchUrl。
// 每个引擎的结果都过一遍 looksRelevant()，不相关就换下一个，全都不相关才报 search_irrelevant。
"use strict";

/** 搜到几条默认值 / 上限（参数里可调） */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

/** 单引擎超时（tavily 免 key 实测 9.1s，最慢，给它 20s） */
const ENGINE_TIMEOUT_MS = { tavily: 20000, firecrawl: 15000, exa: 15000, bing: 15000 };
/** 四个引擎合计上限：前面的引擎慢死也不能把工具卡到天荒地老 */
const TOTAL_BUDGET_MS = 45000;

const TAVILY_URL = "https://api.tavily.com/search";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const BING_URL = "https://www.bing.com/search";

// ---------------------------------------------------------------- 原生通道（Capacitor App）
// 只有 bing 需要它：App 里 WebView 的 Origin 是 https://localhost，bing 不发 CORS 头，
// 浏览器 fetch 必然 Failed to fetch；而原生层没有同源策略。Capacitor 8 的 CapacitorHttp 用
// OkHttp / URLSession 发请求，这里**只手动调插件**。
// 注意：capacitor.config.json 里的 CapacitorHttp **全局补丁必须保持关闭**（不写
// plugins.CapacitorHttp.enabled: true）。一旦开启，它会劫持 window.fetch / XMLHttpRequest 到
// 原生层，逐字 SSE 流会被缓冲成一次性返回（js/core/sse.js 靠 res.body.getReader()），
// 模型的流式输出直接坏掉。
const NATIVE_CONNECT_TIMEOUT_MS = 8000;
const NATIVE_READ_TIMEOUT_MS = 30000;
/** 桌面 Chrome 的 UA（bing 对空 UA 更容易回挑战页） */
const NATIVE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 原生层（Capacitor App）里才存在；浏览器里是 undefined。
 * 插件由 Capacitor 注入的桥脚本预注册，不需要 import、不需要打包器。
 */
function nativeHttp() {
  const c = globalThis.Capacitor;
  if (!c || typeof c.isNativePlatform !== "function" || !c.isNativePlatform()) return null;
  const p = c.Plugins && c.Plugins.CapacitorHttp;
  if (p) return p;
  // 兜底：桥脚本没预注册时用桥自带的 registerPlugin 拿代理（native 上等价，web 上无效）
  if (typeof c.registerPlugin === "function") {
    try {
      return c.registerPlugin("CapacitorHttp") || null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 基础工具
function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

/** 原生插件没有 AbortSignal，用计时器兜住超时（原生请求本身无法取消，结果丢弃即可） */
function withTimeout(promise, ms, code, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(codeError(code, message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * fetch + 调用方 signal + 单引擎超时，统一返回 {status, text}。
 * HTTP 状态不在这里判：各引擎的失败语义不同（429 / 403 VPN / 202 挑战页）。
 */
async function requestText(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || ENGINE_TIMEOUT_MS.tavily;
  const what = o.what || "搜索请求";
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  const onAbort = () => ac.abort();
  if (o.signal) {
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: o.method || "GET",
      headers: o.headers || {},
      body: o.body == null ? undefined : o.body,
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    if (o.signal && o.signal.aborted) throw abortError();
    if (timedOut) throw codeError("search_timeout", what + "超时（" + timeoutMs + "ms）");
    throw codeError("search_network_error", what + "失败：" + (err && err.message ? err.message : err));
  } finally {
    clearTimeout(timer);
    if (o.signal) o.signal.removeEventListener("abort", onAbort);
  }
}

/** 原生插件返回的 data 可能是字符串，也可能已被解析成对象 */
function bodyText(res) {
  const d = res && res.data;
  if (typeof d === "string") return d;
  if (d == null) return "";
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

/** 秒级重试提示（tavily 429 会带 retry_after_seconds） */
function retryHint(text) {
  try {
    const parsed = JSON.parse(text);
    const sec = Number(parsed && parsed.error && parsed.error.retry_after_seconds);
    if (isFinite(sec) && sec > 0) return "（约 " + Math.round(sec) + " 秒后可再试）";
  } catch {
    /* 不是 JSON 就算了 */
  }
  return "";
}

// ---------------------------------------------------------------- 归一
function toRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || raw.name || raw.heading || "").trim();
  const url = String(raw.url || raw.link || raw.href || "").trim();
  const snippet = String(raw.snippet || raw.description || raw.summary || raw.text || "").trim();
  if (!url && !title) return null;
  return { title: title.slice(0, 200), url: url.slice(0, 600), snippet: snippet.slice(0, 400) };
}

/** 按 url 去重（保持原顺序），顺手丢掉没有 url 或 title 的行 */
function uniqueRows(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || !row.url) continue;
    const key = row.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** 后端可能给出的几种结果壳子，统一成数组（远端 searchUrl 后端用） */
function pickRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  const keys = ["results", "data", "items", "web", "pages", "hits"];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  if (data.data && typeof data.data === "object") return pickRows(data.data);
  return null;
}

/** 远端后端的失败体形如 {"ok":false,"error":"search_failed","detail":"..."}，取出可读原因 */
function localFailureDetail(body) {
  if (!body || body.charAt(0) !== "{") return "";
  try {
    const parsed = JSON.parse(body);
    if (!parsed || parsed.ok !== false) return "";
    const detail = typeof parsed.detail === "string" ? parsed.detail : "";
    const code = typeof parsed.error === "string" ? parsed.error : "";
    return [code, detail].filter(Boolean).join("：");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- 相关性判据（纯函数，可单测）
/**
 * 查询的相关性 token：CJK 取二元组（单字太泛），拉丁/数字取长度 >= 2 的词。
 * 与 dsh-free-search 插件的 engines/shared.js 同源实现（纯函数，零依赖）。
 */
export function queryOverlapTokens(query) {
  const tokens = new Set();
  for (const run of String(query).match(/[\u4e00-\u9fff]+/g) || []) {
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
 * 必抄：Bing 在「查询无结果 / 被限流」时会返回一张完全无关的缓存 SERP（b_algo 照样 10 条），
 * 不判就会把垃圾喂给模型。四个引擎都过这一关。
 * @param {string} query
 * @param {{title?:string,url?:string,snippet?:string}[]} sources
 */
export function looksRelevant(query, sources) {
  const list = sources || [];
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
  for (const source of list) {
    const title = String((source && source.title) || "").toLowerCase();
    const hay = (title + " " + ((source && source.snippet) || "") + " " + ((source && source.url) || "")).toLowerCase();
    const hits = usable.filter((t) => hay.includes(t.toLowerCase()));
    if (hits.length > 0) {
      relevant += 1;
      for (const hit of hits) matched.add(hit);
      for (const hit of titleTokens) {
        if (title.includes(hit.toLowerCase())) titleMatched.add(hit);
      }
    }
  }
  const enoughSources = relevant >= Math.max(1, Math.ceil(list.length / 3));
  const enoughTokens = matched.size >= Math.min(2, usable.length) || matched.size / usable.length >= 0.5;
  return enoughSources && enoughTokens && titleMatched.size > 0;
}

// ---------------------------------------------------------------- tavily
/**
 * tavily 响应 → rows
 * @param {any} data { results: [{ url, title, content }] }
 */
export function parseTavily(data) {
  const list = data && Array.isArray(data.results) ? data.results : [];
  return uniqueRows(
    list.map((r) => toRow({ url: r && r.url, title: r && r.title, snippet: r && r.content })).filter(Boolean)
  );
}

export async function searchTavily({ query, limit, key, signal, timeoutMs }) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  // 有 key 走 Bearer；没有 key 必须显式声明 keyless 档
  if (key) headers.authorization = "Bearer " + key;
  else headers["x-tavily-access-mode"] = "keyless";
  const { status, text } = await requestText(TAVILY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, max_results: Math.min(limit, 20), search_depth: "basic" }),
    signal,
    timeoutMs,
    what: "Tavily 请求",
  });
  if (status === 401 || status === 403) {
    throw codeError("tavily_key_invalid", "Tavily 拒绝了当前凭证（HTTP " + status + "），检查设置里的搜索 Key");
  }
  if (status === 429) {
    throw codeError(
      "tavily_rate_limited",
      "Tavily 免 key 档被限流（每天有配额）" + retryHint(text) + "，配一枚 key 可立即恢复"
    );
  }
  if (status >= 400) {
    throw codeError("tavily_failed", "Tavily HTTP " + status + "：" + String(text || "").slice(0, 160));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw codeError("tavily_bad_response", "Tavily 返回的不是 JSON：" + (err && err.message ? err.message : err));
  }
  return parseTavily(data);
}

// ---------------------------------------------------------------- firecrawl
/**
 * firecrawl 响应 → rows
 * @param {any} data { success, data: { web: [{ url, title, description }] } }
 */
export function parseFirecrawl(data) {
  const web = data && data.data && Array.isArray(data.data.web) ? data.data.web : [];
  return uniqueRows(
    web.map((r) => toRow({ url: r && r.url, title: r && r.title, snippet: r && r.description })).filter(Boolean)
  );
}

/** 免 key 档被「VPN/代理出口」拒掉时的正文特征 */
const FIRECRAWL_KEYLESS_BLOCKED = /vpn|proxy|without an api key|api key from here/i;

export async function searchFirecrawl({ query, limit, key, signal, timeoutMs }) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const { status, text } = await requestText(FIRECRAWL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, limit }),
    signal,
    timeoutMs,
    what: "Firecrawl 请求",
  });
  // 特例：403 + VPN/代理 文案 = 免 key 档被按出口 IP 拒了，不是普通失败
  if (status === 403 && FIRECRAWL_KEYLESS_BLOCKED.test(String(text || ""))) {
    throw codeError(
      "firecrawl_keyless_blocked",
      "Firecrawl 拒绝免 key 档：当前网络是 VPN/代理出口，换网络或配一枚 key"
    );
  }
  if (status === 401 || status === 403) {
    throw codeError("firecrawl_key_invalid", "Firecrawl 拒绝了当前凭证（HTTP " + status + "）");
  }
  if (status === 429) {
    throw codeError("firecrawl_rate_limited", "Firecrawl 被限流（HTTP 429），稍后再试或配一枚 key");
  }
  if (status >= 400) {
    throw codeError("firecrawl_failed", "Firecrawl HTTP " + status + "：" + String(text || "").slice(0, 160));
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw codeError("firecrawl_bad_response", "Firecrawl 返回的不是 JSON：" + (err && err.message ? err.message : err));
  }
  if (data && data.success === false) {
    throw codeError("firecrawl_failed", "Firecrawl 返回 success:false" + (data.error ? "：" + String(data.error).slice(0, 160) : ""));
  }
  return parseFirecrawl(data);
}

// ---------------------------------------------------------------- exa（官方 MCP 端点，SSE）
/**
 * exa MCP 的 SSE 文本 → rows
 * 响应是一串 `data: {"result":{"content":[{"type":"text","text":"..."}]}}`，
 * 那段 text 是 markdown 清单：每个结果一块，块之间用 `---` 分隔，
 * 块内是 `Title: … / URL: … / Published: … / Author: … / Highlights:` 加正文。
 * @param {string} text
 */
export function parseExaText(text) {
  const parts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.indexOf("data: ") !== 0) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      continue;
    }
    const content = msg && msg.result && Array.isArray(msg.result.content) ? msg.result.content : null;
    if (!content) continue;
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) parts.push(part.text);
    }
  }
  const merged = parts.join("\n\n");
  if (!merged.trim()) return [];
  const blocks = merged.split(/\n\s*-{3,}\s*\n/);
  const rows = [];
  for (const block of blocks) {
    const row = exaBlockToRow(block);
    if (row) rows.push(row);
  }
  return uniqueRows(rows);
}

function exaBlockToRow(block) {
  const lines = String(block || "").split(/\r?\n/);
  let title = "";
  let url = "";
  const body = [];
  let inBody = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBody) {
      const m = trimmed.match(/^(Title|URL|Published|Author):\s*(.*)$/);
      if (m) {
        const k = m[1];
        const v = m[2].trim();
        if (k === "URL") url = v;
        else if (k === "Title" && !title) title = v;
        continue;
      }
      if (/^Highlights:\s*$/i.test(trimmed)) {
        inBody = true;
        continue;
      }
      if (!trimmed) continue;
      // 没有 Highlights 头（或格式变了）时，剩下的行就是正文
      inBody = true;
    }
    if (trimmed) body.push(trimmed);
  }
  if (!url && !title) return null;
  return toRow({ url, title, snippet: body.join(" ") });
}

export async function searchExa({ query, limit, signal, timeoutMs }) {
  const { status, text } = await requestText(EXA_MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query, numResults: limit } },
    }),
    signal,
    timeoutMs,
    what: "Exa 请求",
  });
  if (status >= 400) {
    throw codeError("exa_failed", "Exa MCP HTTP " + status + "：" + String(text || "").slice(0, 160));
  }
  const rows = parseExaText(text);
  if (!rows.length) {
    // 没有 result.content 的情况多半是 JSON-RPC 报错（参数名或方法名变了）
    const errLine = String(text || "")
      .split(/\r?\n/)
      .find((l) => l.indexOf('"error"') >= 0);
    throw codeError(
      "exa_bad_response",
      "Exa 没有返回可解析的结果" + (errLine ? "：" + errLine.slice(0, 160) : "")
    );
  }
  return rows;
}

// ---------------------------------------------------------------- bing（唯一没有 CORS 的）
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

/** Bing 把外链包成 bing.com/ck/a?u=a1<base64url>，解出真地址（浏览器没有 Buffer，用 atob） */
export function extractBingUrl(href) {
  if (!href) return "";
  const url = decodeEntities(href);
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return url;
  try {
    const u = new URL(url).searchParams.get("u");
    if (!u) return url;
    const b64 = (u.startsWith("a1") ? u.slice(2) : u).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = typeof atob === "function" ? atob(padded) : "";
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/**
 * Bing 结果页 → [{url,title,snippet}]：b_algo 切块，h2 > a 取标题，b_caption p 取摘要
 * @param {string} html
 */
export function parseBingHtml(html) {
  const text = String(html || "");
  const blocks = text.match(/<li class="b_algo[^"]*"[\s\S]*?<\/li>/g) || [];
  const rows = [];
  for (const block of blocks) {
    const hrefMatch =
      block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/) || block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    if (!hrefMatch) continue;
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
    const captionMatch =
      block.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const url = extractBingUrl(hrefMatch[1]);
    if (!url) continue;
    rows.push({
      url,
      title: titleMatch ? stripTags(titleMatch[1]) : "",
      snippet: captionMatch ? stripTags(captionMatch[1]) : "",
    });
  }
  return uniqueRows(rows);
}

/** 反爬页识别：限流时 bing 会回挑战/验证页（状态码仍可能是 2xx） */
function looksBlocked(status, html) {
  if (status === 202 || status === 429) return true;
  return /anomaly-modal|challenge|captcha/i.test(String(html || ""));
}

/**
 * setlang 永远不能省：不带它 bing 会回 0 字节。
 * 含 CJK → 中文市场；否则 → 英文市场。
 */
function buildBingUrl(query) {
  const q = encodeURIComponent(query);
  return hasCjk(query)
    ? BING_URL + "?q=" + q + "&setlang=zh-CN&mkt=zh-CN"
    : BING_URL + "?q=" + q + "&setlang=en&cc=US";
}

function bingRowsFromHtml(query, status, html) {
  if (status >= 400) throw codeError("bing_failed", "Bing HTTP " + status);
  if (looksBlocked(status, html)) {
    throw codeError("bing_blocked", "Bing 要求人机验证（HTTP " + status + "），换个网络或稍后再试");
  }
  return parseBingHtml(html);
}

/**
 * bing 的三级通道：原生直连 → 用户自配 searchUrl → 跳过（返回 null，不报错）。
 * 浏览器里没有 CORS，硬 fetch 只会失败，所以干脆不试。
 */
async function searchBing({ query, limit, recency, settings, signal, timeoutMs }) {
  const native = nativeHttp();
  if (native) {
    const pending = native.request({
      url: buildBingUrl(query),
      method: "GET",
      headers: {
        "user-agent": NATIVE_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": hasCjk(query) ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
      },
      connectTimeout: NATIVE_CONNECT_TIMEOUT_MS,
      readTimeout: NATIVE_READ_TIMEOUT_MS,
    });
    const res = await withTimeout(
      Promise.resolve(pending),
      timeoutMs,
      "search_timeout",
      "Bing 原生请求超时（" + timeoutMs + "ms）"
    );
    return bingRowsFromHtml(query, Number(res && res.status) || 0, bodyText(res));
  }

  const rawUrl = String((settings && settings.searchUrl) || "").trim();
  if (!rawUrl) return null; // 没有通道：跳过，不算失败

  const isLocal = rawUrl.startsWith("/");
  const key = isLocal ? "" : String((settings && settings.searchKey) || "").trim();
  const { status, text } = await requestText(rawUrl, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", accept: "application/json" }, key ? { authorization: "Bearer " + key } : {}),
    body: JSON.stringify({ query, recency, limit }),
    signal,
    timeoutMs,
    what: "searchUrl 请求",
  });
  if (status >= 400) {
    const detail = localFailureDetail(text);
    throw codeError(
      "bing_failed",
      "searchUrl HTTP " + status + (detail ? "：" + detail : text ? "：" + String(text).slice(0, 160) : "")
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw codeError("bing_bad_response", "searchUrl 返回的不是 JSON：" + (err && err.message ? err.message : err));
  }
  const rawRows = pickRows(data);
  if (!rawRows) throw codeError("bing_bad_response", "searchUrl 返回的结构里找不到结果数组");
  return uniqueRows(rawRows.map(toRow).filter(Boolean));
}

// ---------------------------------------------------------------- 编排
/** 顺序固定：便宜且快的先问，bing 兜底 */
const ENGINE_ORDER = [
  { name: "tavily", run: searchTavily },
  { name: "firecrawl", run: searchFirecrawl },
  { name: "exa", run: searchExa },
  { name: "bing", run: searchBing },
];

/**
 * 依次问引擎，第一个「有结果且与查询相关」的就赢。
 * 全都不行才抛错；四家全部「不相关」时报 search_irrelevant（这才是缓存垃圾页的标志）。
 */
async function runEngines({ query, recency, limit, settings, key, signal, onUpdate }) {
  const failures = [];
  // 「给了结果」的引擎数（跳过与报错的都不算：它们没对内容下结论）
  let evaluated = 0;
  let irrelevant = 0;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const engine of ENGINE_ORDER) {
    if (signal && signal.aborted) throw abortError();
    const left = deadline - Date.now();
    if (left <= 0) {
      failures.push({ engine: engine.name, reason: "跳过：总时长预算用尽" });
      continue;
    }
    if (onUpdate) onUpdate({ stage: "requesting", engine: engine.name });
    try {
      const rows = await engine.run({
        query,
        recency,
        limit,
        settings,
        key,
        signal,
        timeoutMs: Math.min(ENGINE_TIMEOUT_MS[engine.name] || 15000, left),
      });
      if (rows === null) {
        // bing 没有通道（浏览器 + 没配 searchUrl）：按跳过处理
        failures.push({ engine: engine.name, reason: "跳过：浏览器无原生通道且未配 searchUrl" });
        continue;
      }
      if (!rows.length) {
        failures.push({ engine: engine.name, reason: "0 条结果" });
        continue;
      }
      // 先判相关性再截断：垃圾页常把无关结果放最前，先 slice 会把真结果截掉
      evaluated += 1;
      if (!looksRelevant(query, rows)) {
        irrelevant += 1;
        failures.push({ engine: engine.name, reason: "结果与查询无关（多半是缓存垃圾页）" });
        continue;
      }
      if (onUpdate) onUpdate({ stage: "parsed", engine: engine.name, count: Math.min(rows.length, limit) });
      return { rows: rows.slice(0, limit), engine: engine.name };
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      if (err && err.name === "AbortError") throw err;
      failures.push({ engine: engine.name, reason: (err && err.message) || String(err) });
    }
  }

  const detail = failures.map((f) => f.engine + "：" + f.reason).join("；");
  // 凡是真的给了结果的引擎都判「无关」→ 这才是缓存垃圾页，报专门的码；
  // 有引擎报错/跳过时它们没对内容下结论，不能算进这一步。
  if (evaluated > 0 && irrelevant === evaluated) {
    throw codeError(
      "search_irrelevant",
      "引擎返回的结果都与查询无关（" + evaluated + " 家全不相关），换个查询词或稍后再试（" + detail + "）"
    );
  }
  throw codeError("search_failed", "搜索全部失败（" + detail + "）");
}

/** 三条通道（引擎 / searchUrl / 原生）返回同一个形状，让 agent.js 与 UI 零改动 */
function buildResult({ query, recency, limit, engine, rows }) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ query, recency, count: rows.length, results: rows }),
      },
    ],
    details: { query, recency, limit, engine, results: rows },
  };
}

/**
 * @param {{getSettings: () => object}} deps
 * @returns {{name:string, description:string, parameters:object, executionMode:string, execute:Function}}
 */
export function createWebSearchTool({ getSettings } = {}) {
  const read = () => (typeof getSettings === "function" ? getSettings() || {} : {});

  return {
    name: "web_search",
    description:
      "搜索网页。只返回标题、链接和摘要，不返回正文；需要更细的内容时用 next_url 里的地址再查。" +
      "适用于需要最新事实、版本号、官方文档位置的场合。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词，尽量具体（含产品名/版本号/错误信息）" },
        recency: { type: "string", enum: ["any", "day", "week", "month"], description: "时间范围，默认 any" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "返回条数，默认 5，最多 8" },
      },
      required: ["query"],
    },
    /**
     * @param {string} id
     * @param {{query?:string, recency?:string, limit?:number}} args
     * @param {AbortSignal} [signal]
     * @param {(update: object) => void} [onUpdate]
     */
    async execute(id, args, signal, onUpdate) {
      const settings = read();
      const query = String((args && args.query) || "").trim();
      if (!query) throw codeError("bad_args", "web_search 需要非空的 query");
      const recency = ["any", "day", "week", "month"].includes(args && args.recency) ? args.recency : "any";
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args && args.limit) || DEFAULT_LIMIT));
      // 一枚 key 通吃 tavily / firecrawl；留空就都用免 key 档
      const key = String(settings.searchKey || "").trim();

      if (onUpdate) onUpdate({ stage: "requesting", query, limit });
      const out = await runEngines({ query, recency, limit, settings, key, signal, onUpdate });
      return buildResult({ query, recency, limit, engine: out.engine, rows: out.rows });
    },
  };
}

export default createWebSearchTool;
