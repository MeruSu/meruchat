// js/core/context.js — 原生 Billion Context（唯一实现点，口径见 docs/DEV.md §2.6）
//
// 发给模型的消息严格按六段拼（顺序不许改，稳定内容在前以命中 prefix cache）：
//   [1] system   AGENTS.md   conv.agentsMd
//   [2] system   设定 / 人格  responder.persona
//   [3] system   压缩块 1..N  每块一行前缀 + 摘要正文，合成一条 system
//   [4] system   memo        单条备忘（一段自由文本），原文整段注入（全局唯一，不按会话分桶）
//   [5] system   工具与时间   当前时间 + 可用工具清单（合成一条 system，永远存在）
//   [6] 原样消息  未压缩的会话  按 seq 升序；assistant 属于当前成员才是 assistant，
//                              别人一律 user + 「名字」：前缀
// 任何卡片都不许自己拼 messages（chat-direct.js 的 buildTranscript 必须改调 buildContext）。
"use strict";

import { completionsUrl } from "./api.js";

/** 摘要提示词固定结构（不许各卡片另写） */
export const SUMMARY_PROMPT = `把下面这段对话压缩成结构化笔记，只输出这五行标题的内容，不要寒暄：
用户目标：
已确定的决定：
未完成事项：
关键事实与数字：
涉及的人与称呼：`;

/** 工具结果只在「本轮」进上下文，超过这个长度截断（§2.6） */
export const TOOL_RESULT_CONTEXT_MAX = 2000;

/** 折叠参数（§2.6）：目标 ≈ budget/2 token，至少 2 条、最多 40 条 */
export const FOLD_MIN_MESSAGES = 2;
export const FOLD_MAX_MESSAGES = 40;

/** 块数上限：新建第 9 块时把 1–4 块蒸馏成一块（T2），其余顺延重编号 */
export const BLOCK_LIMIT = 8;
export const DISTILL_BLOCKS = 4;

/** 摘要请求默认超时 */
export const SUMMARY_TIMEOUT_MS = 30000;

/** 每条消息的固定开销（role / 分隔） */
const PER_MESSAGE_TOKENS = 4;

/** [5] 工具与时间：单条工具描述截断长度 */
export const TOOL_LINE_MAX = 60;

/** 中文星期（getDay() 的下标；2026-11-25 是周三） */
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 两处数字补零 */
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/** 入参 now 归一成 Date：缺省 = 现在；Date / 数字 / 字符串都能吃 */
function toDate(now) {
  if (now instanceof Date && !isNaN(now.getTime())) return now;
  if (typeof now === "number" && isFinite(now)) {
    const d = new Date(now);
    if (!isNaN(d.getTime())) return d;
  }
  if (typeof now === "string" && now) {
    const d = new Date(now);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** 时区名：显式给了就用，否则问浏览器 */
function resolveTimeZone(timeZone) {
  const tz = String(timeZone == null ? "" : timeZone).trim();
  if (tz) return tz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (e) {
    return "UTC";
  }
}

/** 工具描述只留第一行（第一句），超 60 字截断加「…」 */
function firstSentence(text) {
  // 先按行切，再按句末标点切：描述里常写成「一句话。第二句」，只保留第一句
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!s) return "";
  let head = s;
  const m = s.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$))/);
  if (m && m[0].trim()) head = m[0].trim();
  if (head.length <= TOOL_LINE_MAX) return head;
  return head.slice(0, TOOL_LINE_MAX) + "…";
}

/**
 * 把某一时刻投影到指定时区的「墙上时间」（年月日时分秒 + 星期）。
 * 用 formatToParts 取数：Date 的 getHours() 只能给本机时区，时区参数会被忽略。
 * 时区名不合法 → 退回本机时区的同一套字段。
 */
function wallClock(date, timeZone) {
  const tz = resolveTimeZone(timeZone);
  let parts = null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    parts = fmt.formatToParts(date);
  } catch (e) {
    parts = null;
  }
  if (!parts) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
      tz: tz,
    };
  }
  const get = (type) => {
    for (let i = 0; i < parts.length; i += 1) if (parts[i].type === type) return parts[i].value;
    return "";
  };
  const WEEK_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = WEEK_EN[get("weekday")];
  // hour12:false 在部分实现里给「24」表示午夜，归一到 0
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: hour,
    minute: Number(get("minute")),
    weekday: typeof wd === "number" ? wd : date.getDay(),
    tz: tz,
  };
}

/**
 * [5] 工具与时间的正文（一条 system）：时间永远有，工具清单可能为空。
 * @param {Array<{name?: string, description?: string}>} tools
 * @param {Date|number|string} [now]
 * @param {string} [timeZone]
 * @returns {string}
 */
export function buildToolAndTimeText(tools, now, timeZone) {
  const list = Array.isArray(tools) ? tools : [];
  const d = toDate(now);
  const clock = wallClock(d, timeZone);
  const lines = [
    "当前时间：" +
      clock.year +
      "-" +
      pad2(clock.month) +
      "-" +
      pad2(clock.day) +
      " " +
      pad2(clock.hour) +
      ":" +
      pad2(clock.minute) +
      "（" +
      WEEKDAYS_ZH[clock.weekday] +
      "）· " +
      clock.tz,
  ];
  const usable = list.filter((t) => t && typeof t.name === "string" && t.name.trim());
  if (usable.length) {
    lines.push("可用工具（需要时直接发起工具调用，不要凭空编造工具结果）：");
    usable.forEach((t) => {
      const desc = firstSentence(t.description);
      lines.push("- " + t.name.trim() + (desc ? "：" + desc : ""));
    });
  }
  return lines.join("\n");
}

/** CJK 统一表意文字 + 假名 + 谚文：一字算 1 token */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 估 token（浏览器没有 tiktoken，只用于触发判断，不用于计费）。
 * CJK 一字 = 1；其它字符 4 个 = 1（向上取整）。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text == null ? "" : text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 估一组消息的 token（每条再加 4）。
 * @param {Array<{role?: string, content?: string}>} messages
 * @returns {number}
 */
export function estimateMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  list.forEach((m) => {
    total += PER_MESSAGE_TOKENS + estimateTokens(m && m.content);
  });
  return total;
}

/** 成员的显示名；找不到用会话标题兜底 */
function nameOfMember(members, memberId, fallback) {
  const list = Array.isArray(members) ? members : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === memberId) return String(list[i].name || "").trim() || fallback;
  }
  return fallback;
}

/** 工具结果超长截断（§2.6） */
function clipToolResult(content) {
  const s = String(content == null ? "" : content);
  if (s.length <= TOOL_RESULT_CONTEXT_MAX) return s;
  return s.slice(0, TOOL_RESULT_CONTEXT_MAX) + "…（截断，原 " + s.length + " 字）";
}

/** 预算是否关闭了压缩：0 / 非数字 = 不限（全量直喂），compress === false 也关 */
function compressOff(budget, compress) {
  if (compress === false) return true;
  if (typeof budget !== "number" || !isFinite(budget)) return false;
  return budget <= 0;
}

/**
 * 按 §2.6 的六段结构拼上下文。
 *
 * @param {object} opts
 * @param {object} opts.conv       会话（读 agentsMd / title）
 * @param {Array} [opts.members]   成员列表（把 memberId 翻成名字）
 * @param {object} [opts.responder] 本轮发言的成员（读 id / persona）
 * @param {Array} [opts.messages]  候选消息（按 seq 升序；已折叠的会被跳过）
 * @param {Array} [opts.blocks]    压缩块（按 index 升序）
 * @param {string} [opts.memo]     单条备忘（一段自由文本，无 key）
 * @param {Array<{name: string, description?: string}>} [opts.tools] 可用工具（[5] 段清单）
 * @param {Date|number|string} [opts.now] 当前时间，缺省 = new Date()
 * @param {string} [opts.timeZone] 时区名，缺省 = 浏览器 resolvedOptions().timeZone
 * @param {number} [opts.budget]   上下文预算 token
 * @param {boolean} [opts.compress] false = 不折叠（等同 budget 0）
 * @returns {{messages: Array, estimated: number, folded: number, parts: object}}
 */
export function buildContext(opts) {
  const o = opts || {};
  const conv = o.conv || {};
  const members = Array.isArray(o.members) ? o.members : [];
  const responder = o.responder || {};
  const input = Array.isArray(o.messages) ? o.messages : [];
  const blocks = Array.isArray(o.blocks) ? o.blocks : [];
  const off = compressOff(o.budget, o.compress);

  const out = [];
  const parts = { agentsMd: 0, persona: 0, blocks: 0, memo: 0, tools: 0, history: 0 };

  // [1] AGENTS.md（会话规则），空则整段省略
  const agentsMd = typeof conv.agentsMd === "string" ? conv.agentsMd.trim() : "";
  if (agentsMd) {
    out.push({ role: "system", content: agentsMd });
    parts.agentsMd = estimateTokens(agentsMd);
  }

  // [2] 设定 / 人格
  const persona = typeof responder.persona === "string" ? responder.persona.trim() : "";
  if (persona) {
    out.push({ role: "system", content: persona });
    parts.persona = estimateTokens(persona);
  }

  // [3] 压缩块 1..N —— 全部合成一条 system（多条 system 白费 token）
  if (!off && blocks.length) {
    const text = blocks
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((b) => "【压缩块 " + (b.index || 0) + "｜原第 " + (b.fromSeq || 0) + "–" + (b.toSeq || 0) + " 条】\n" + (b.summary || ""))
      .join("\n\n");
    if (text.trim()) {
      out.push({ role: "system", content: text });
      parts.blocks = estimateTokens(text);
    }
  }

  // [4] memo —— 单条，原文整段注入
  const memoText = String(o.memo || "").trim();
  if (memoText) {
    const text = "当前备忘：\n" + memoText;
    out.push({ role: "system", content: text });
    parts.memo = estimateTokens(text);
  }

  // [5] 工具与时间 —— 一条 system，时间永远有、工具清单可能为空
  const toolText = buildToolAndTimeText(o.tools, o.now, o.timeZone);
  out.push({ role: "system", content: toolText });
  parts.tools = estimateTokens(toolText);

  // [6] 未压缩消息，按 seq 升序
  const convTitle = String(conv.title || "").trim() || "成员";
  const responderId = responder.id;
  let folded = 0;
  const seqSorted = input
    .filter((m) => m && m.role !== "system")
    .slice()
    .sort((a, b) => (a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq));

  seqSorted.forEach((m) => {
    if (!off && m.foldedBlockId != null) {
      folded += 1;
      return;
    }
    if (m.role === "tool") {
      out.push({ role: "tool", content: clipToolResult(m.content) });
      return;
    }
    if (m.role === "assistant") {
      if (responderId != null && m.memberId === responderId) {
        out.push({ role: "assistant", content: String(m.content == null ? "" : m.content) });
        return;
      }
      // 别人发的：一律折成 user，并带上「名字」前缀（§2.3 群聊角色映射）
      const name = nameOfMember(members, m.memberId, convTitle);
      out.push({ role: "user", content: "「" + name + "」：" + String(m.content == null ? "" : m.content) });
      return;
    }
    out.push({ role: "user", content: String(m.content == null ? "" : m.content) });
  });
  parts.history = estimateMessages(out.filter((m) => m.role !== "system"));

  return { messages: out, estimated: estimateMessages(out), folded, parts };
}

/**
 * 把消息切成「不可切开的单元」：同一轮的 tool_call 与 tool_result 必须同批（§2.6）。
 * 判定优先用 roundId；没有则按 assistant.toolCalls[].id ↔ tool.toolCallId 配对。
 * @param {Array} messages
 * @returns {Array<Array>}
 */
function groupUnits(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const units = [];
  let i = 0;
  while (i < list.length) {
    const head = list[i];
    const unit = [head];
    i += 1;
    if (head && head.roundId != null) {
      while (i < list.length && list[i] && list[i].roundId === head.roundId) {
        unit.push(list[i]);
        i += 1;
      }
    } else if (head && Array.isArray(head.toolCalls) && head.toolCalls.length) {
      const ids = {};
      head.toolCalls.forEach((tc) => {
        if (tc && tc.id != null) ids[tc.id] = true;
      });
      while (i < list.length && list[i] && list[i].toolCallId != null && ids[list[i].toolCallId]) {
        unit.push(list[i]);
        i += 1;
      }
    }
    units.push(unit);
  }
  return units;
}

/**
 * 选最旧的一批消息去折叠：目标 ≈ budget/2 token，至少 2 条、最多 40 条，
 * 同一轮的 tool_call / tool_result 不许切开。
 *
 * @param {object} opts
 * @param {Array} opts.messages 未折叠消息（按 seq 升序）
 * @param {number} opts.budget  上下文预算
 * @returns {{batch: Array|null, reason: string}}
 */
export function planFold(opts) {
  const o = opts || {};
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const budget = o.budget;

  if (typeof budget !== "number" || !isFinite(budget) || budget <= 0) {
    return { batch: null, reason: "预算为 0（不限），不折叠" };
  }
  if (messages.length < 4) {
    return { batch: null, reason: "未压缩消息只有 " + messages.length + " 条，不足 4 条" };
  }

  const target = budget / 2;
  // 至少给模型留一条，绝不把历史全折了
  const hardMax = Math.min(FOLD_MAX_MESSAGES, messages.length - 1);
  if (hardMax < FOLD_MIN_MESSAGES) {
    return { batch: null, reason: "可用消息不足 " + FOLD_MIN_MESSAGES + " 条" };
  }

  const units = groupUnits(messages);
  const batch = [];
  let tokens = 0;
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    // 已够目标且已满足最小条数 → 停（单元边界切，绝不切半轮）
    if (tokens >= target && batch.length >= FOLD_MIN_MESSAGES) break;
    if (batch.length + unit.length > hardMax) break;
    unit.forEach((m) => batch.push(m));
    tokens += estimateMessages(unit);
  }

  if (batch.length < FOLD_MIN_MESSAGES) {
    return { batch: null, reason: "凑不出 " + FOLD_MIN_MESSAGES + " 条可折叠消息" };
  }
  return {
    batch,
    reason: "目标 ≈" + Math.round(target) + " token，实际折叠 " + batch.length + " 条 ≈" + tokens + " token",
  };
}

/** 把一批消息拼成纯文本（「名字」：内容；工具结果也拼进去） */
function batchToText(batch, members, conv) {
  const convTitle = String((conv && conv.title) || "").trim() || "成员";
  return (Array.isArray(batch) ? batch : [])
    .map((m) => {
      if (!m) return "";
      const content = String(m.content == null ? "" : m.content);
      if (m.role === "tool") return "工具结果：" + content;
      const name = nameOfMember(members, m.memberId, m.role === "assistant" ? convTitle : "用户");
      return "「" + name + "」：" + content;
    })
    .filter((line) => line)
    .join("\n");
}

/** 非流式摘要请求：system = SUMMARY_PROMPT，temperature 0，max_tokens 800 */
async function summarizeText(text, opts) {
  const o = opts || {};
  const { baseUrl, apiKey, model, signal } = o;
  const timeoutMs = typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? o.timeoutMs : SUMMARY_TIMEOUT_MS;

  // 本地网关不需要 key，空 apiKey 就不发 Authorization（与 agent.js 同一口径）；
  // 真 401 会走失败路径，用户能看到具体原因。
  const source = String(text == null ? "" : text);
  if (!source.trim()) throw new Error("摘要失败：没有可压缩的内容");

  const ctrl = new AbortController();
  let timer = null;
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new Error("摘要已取消");
    signal.addEventListener("abort", onOuterAbort);
  }
  timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(completionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
      },
      body: JSON.stringify({
        model: model || undefined,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: source },
        ],
        temperature: 0,
        max_tokens: 800,
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error("摘要超时（" + timeoutMs + "ms）");
    throw new Error("摘要请求失败：" + (err && err.message ? err.message : err));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch (_) {
      /* 读不到 body 就只报状态码 */
    }
    throw new Error("摘要失败：HTTP " + res.status + (bodyText ? "：" + bodyText.slice(0, 160) : ""));
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error("摘要失败：返回的不是 JSON");
  }
  const summary = String(
    (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || ""
  ).trim();
  if (!summary) throw new Error("摘要失败：模型返回空内容");
  return summary;
}

/**
 * 把一批消息压成一段结构化笔记（§2.6 的五行）。
 * @param {object} opts
 * @param {object} [opts.conv]
 * @param {Array} [opts.members]
 * @param {Array} opts.batch
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{summary: string, tokens: number}>}
 */
export async function summarizeBlock(opts) {
  const o = opts || {};
  const text = batchToText(o.batch, o.members, o.conv);
  const summary = await summarizeText(text, o);
  return { summary, tokens: estimateTokens(summary) };
}

/**
 * 折叠编排（发新消息前跑一次，流式过程中绝不折叠）。
 * 任何一步失败都返回 `{folded: 0, error}` —— 绝不抛，绝不丢历史。
 *
 * @param {object} opts
 * @param {object} opts.store          store 实例（用 listUnfoldedMessages / putBlock / markFolded / listBlocks / getContextSettings）
 * @param {object} opts.conv
 * @param {object} [opts.responder]
 * @param {Array} [opts.members]
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{folded: number, reason?: string, error?: string, block?: object}>}
 */
export async function foldOldest(opts) {
  const o = opts || {};
  const { store, conv } = o;
  if (!store || !conv || !conv.id) return { folded: 0, error: "foldOldest: 缺少 store 或 conv" };

  let cfg;
  let unfolded;
  let existing;
  try {
    cfg = await store.getContextSettings();
    if (!cfg.contextCompress) return { folded: 0, reason: "自动压缩已关闭" };
    if (!(cfg.contextBudget > 0)) return { folded: 0, reason: "预算为 0（不限），不折叠" };
    unfolded = await store.listUnfoldedMessages(conv.id);
    existing = await store.listBlocks(conv.id);
  } catch (err) {
    return { folded: 0, error: err && err.message ? err.message : String(err) };
  }

  // §2.6 触发条件：estimated > budget 且未折叠消息 ≥ 4 条
  const estimated = estimateMessages(unfolded);
  if (estimated <= cfg.contextBudget) {
    return { folded: 0, reason: "约 " + estimated + " token 未超预算 " + cfg.contextBudget };
  }

  const plan = planFold({ messages: unfolded, budget: cfg.contextBudget });
  if (!plan.batch) return { folded: 0, reason: plan.reason };

  let result;
  try {
    result = await summarizeBlock({
      conv,
      members: o.members,
      batch: plan.batch,
      baseUrl: o.baseUrl,
      apiKey: o.apiKey,
      model: o.model,
      signal: o.signal,
    });
  } catch (err) {
    // 摘要失败就什么都不做：宁可上下文长，不许丢历史
    return { folded: 0, error: err && err.message ? err.message : String(err) };
  }

  const indices = plan.batch.map((m) => (typeof m.seq === "number" ? m.seq : 0));
  const block = {
    conversationId: conv.id,
    index: existing.length ? Math.max.apply(null, existing.map((b) => b.index || 0)) + 1 : 1,
    fromSeq: Math.min.apply(null, indices),
    toSeq: Math.max.apply(null, indices),
    count: plan.batch.length,
    summary: result.summary,
    tokens: result.tokens,
    createdAt: Date.now(),
  };

  try {
    const saved = await store.putBlock(block);
    const ids = plan.batch.map((m) => m.id).filter((id) => id != null);
    await store.markFolded(conv.id, ids, saved.id);
    const distilled = await maybeDistill(Object.assign({}, o, { store, conv }));
    return { folded: plan.batch.length, block: saved, distilled };
  } catch (err) {
    return { folded: 0, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 块数超上限时的蒸馏：把 1–4 块合成一块（T2），其余顺延重编号。
 * 重建策略：算好新块表 → 清块（消息的 foldedBlockId 一起清）→ 写新块 → 按新 id 重新标记。
 * 蒸馏失败不动任何数据（宁可块多，不许丢块）。
 * @returns {Promise<{distilled: boolean, blocks: number, error?: string}>}
 */
async function maybeDistill(opts) {
  const { store, conv } = opts;
  let blocks;
  let msgs;
  try {
    blocks = await store.listBlocks(conv.id);
    if (blocks.length <= BLOCK_LIMIT) return { distilled: false, blocks: blocks.length };
    msgs = await store.listMessages(conv.id);
  } catch (err) {
    return { distilled: false, blocks: 0, error: err && err.message ? err.message : String(err) };
  }

  const head = blocks.slice(0, DISTILL_BLOCKS);
  const tail = blocks.slice(DISTILL_BLOCKS);
  const text = head
    .map((b) => "【压缩块 " + (b.index || 0) + "｜原第 " + (b.fromSeq || 0) + "–" + (b.toSeq || 0) + " 条】\n" + (b.summary || ""))
    .join("\n\n");

  let summary;
  try {
    summary = await summarizeText(text, opts);
  } catch (err) {
    // 蒸馏失败：保留原样（块数短暂超限，下次再试）
    return { distilled: false, blocks: blocks.length, error: err && err.message ? err.message : String(err) };
  }

  const merged = {
    id: head[0].id,
    conversationId: conv.id,
    index: 1,
    fromSeq: Math.min.apply(null, head.map((b) => b.fromSeq || 0)),
    toSeq: Math.max.apply(null, head.map((b) => b.toSeq || 0)),
    count: head.reduce((n, b) => n + (b.count || 0), 0),
    summary,
    tokens: estimateTokens(summary),
    createdAt: Date.now(),
    distilled: true,
  };

  // 旧块 id → 新块 id：被蒸掉的 1–4 块全指向合并块，其余保持自己的 id（只改 index）
  const deadIds = head.slice(1).map((b) => b.id);
  const remap = {};
  blocks.forEach((b) => {
    remap[b.id] = deadIds.indexOf(b.id) >= 0 ? merged.id : b.id;
  });

  // 先按旧块 id 归好消息，再动库（deleteBlocks 会把 foldedBlockId 清掉）
  const byBlock = {};
  msgs.forEach((m) => {
    if (m.foldedBlockId == null) return;
    const next = remap[m.foldedBlockId];
    if (!next) return;
    (byBlock[next] = byBlock[next] || []).push(m.id);
  });

  try {
    await store.deleteBlocks(conv.id);
    await store.putBlock(merged);
    for (let i = 0; i < tail.length; i += 1) {
      const b = tail[i];
      if (b.index !== i + 2) await store.putBlock(Object.assign({}, b, { index: i + 2 }));
    }
    // 重新标记：把原先折叠的消息按新块 id 挂回去
    const targets = Object.keys(byBlock);
    for (let i = 0; i < targets.length; i += 1) {
      await store.markFolded(conv.id, byBlock[targets[i]], targets[i]);
    }
    const after = await store.listBlocks(conv.id);
    return { distilled: true, blocks: after.length };
  } catch (err) {
    return { distilled: false, blocks: blocks.length, error: err && err.message ? err.message : String(err) };
  }
}

export default buildContext;
