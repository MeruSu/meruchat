// js/core/group.js — 群聊调度（纯函数，不碰 DOM、不碰 IndexedDB）
// 顺序规则抄 AutoGen 的 _mentioned_agents / _finalize_speaker / next_agent：
//   恰好点了一个人 → 只让他回；点了多个 → 按 @ 出现顺序串行；
//   一个都没点 → 从「上一个发言者之后」开始轮转 maxRepliesPerTurn 个。
// 另外提供了群聊上下文映射与成员 system 提示的模板，避免人格漂移。
"use strict";

/** 一轮最多几个人接话：clamp(members.length, 1, 3)，UI 可调 1-6 */
export const MAX_REPLIES_CAP = 3;
export const MAX_REPLIES_UI_MAX = 6;
/** 「自转多轮」默认关闭；辩论模式才显式打开 */
export const DEFAULT_ROUNDS = 1;
/** 首字节 15s、单条总计 45s（群聊里一条失败不该拖住整轮） */
export const FIRST_BYTE_MS = 15000;
export const TOTAL_MS = 45000;
/** 连续失败这么多条就认为供应商/网络挂了，本轮 halted */
export const HALT_AFTER_FAILURES = 2;
/** 「我认为不需要补充」的静默标记（模型只输出它就不产生可见消息） */
export const SILENT_TOKEN = "[[SILENT]]";
/** 模型认为该收尾时写在最后一行 */
export const END_TOKEN = "[END]";
/** 没回上话的成员在后续成员的上下文里长这样，否则后人会把沉默当默认同意 */
export function unrepliedLine(name) {
  return "「" + String(name || "成员") + "」：（未回复）";
}

/** 成员按 sort 升序（同 sort 保持传入顺序） */
export function orderMembers(members) {
  return (members || []).slice().sort((a, b) => (a && a.sort ? a.sort : 0) - (b && b.sort ? b.sort : 0));
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

/**
 * 解析文本里被点名的人。优先结构化 `@名字`；没有任何 `@` 时退回
 * 「前后都不是字母数字的名字」兜底（不用后行断言，老 Safari 不支持）。
 * @param {string} text
 * @param {Array<{id:string,name:string}>} members
 * @returns {Array<{id:string,name:string,index:number}>} 按出现顺序
 */
export function parseMentions(text, members) {
  const body = String(text || "");
  const list = orderMembers(members).filter((m) => m && m.name);
  const hits = [];
  list.forEach((m) => {
    const name = String(m.name).trim();
    if (!name) return;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = new RegExp("[@＠]" + escaped, "g");
    let hit;
    while ((hit = at.exec(body))) hits.push({ id: m.id, name, index: hit.index });
  });
  if (!hits.length) {
    list.forEach((m) => {
      const name = String(m.name).trim();
      if (!name) return;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 前缀不吞字符：用捕获组拿前一个字符，位置按捕获组长度修正
      const bare = new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?![^\\p{L}\\p{N}])", "gu");
      let hit;
      while ((hit = bare.exec(body))) hits.push({ id: m.id, name, index: hit.index + (hit[1] ? hit[1].length : 0) });
    });
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
}

/**
 * 从 lastSpeakerId 之后开始轮转 count 个（不含 lastSpeakerId 自己）。
 * @param {Array<object>} members
 * @param {string} lastSpeakerId
 * @param {number} count
 */
export function rotateFrom(members, lastSpeakerId, count) {
  const list = orderMembers(members);
  if (!list.length) return [];
  const at = list.findIndex((m) => m.id === lastSpeakerId);
  const start = at < 0 ? 0 : (at + 1) % list.length;
  const out = [];
  const n = clamp(count, 1, MAX_REPLIES_UI_MAX);
  for (let i = 0; i < n && i < list.length; i += 1) out.push(list[(start + i) % list.length]);
  return out;
}

/**
 * 决定这一轮谁说、按什么顺序说。
 * @param {object} opts
 * @param {string} opts.text                用户最新这句话
 * @param {Array<object>} opts.members
 * @param {string} [opts.lastSpeakerId]     上一轮的最后一个发言者
 * @param {number} [opts.maxReplies]        默认 clamp(members.length,1,3)，可被 UI 调到 1-6
 * @param {string[]} [opts.explicitIds]     结构化 mention（点了头像那种），优先于文本解析
 * @returns {{queue: Array<object>, reason: string, mentioned: string[]}}
 */
export function planQueue({ text, members, lastSpeakerId, maxReplies, explicitIds } = {}) {
  const list = orderMembers(members);
  const mentioned = (explicitIds && explicitIds.length ? explicitIds.slice() : parseMentions(text, list).map((h) => h.id)).filter(
    (id, i, arr) => arr.indexOf(id) === i
  );
  const byId = (id) => list.find((m) => m.id === id);
  if (mentioned.length === 1) {
    const only = byId(mentioned[0]);
    return { queue: only ? [only] : [], reason: "single_mention", mentioned };
  }
  if (mentioned.length > 1) {
    return { queue: mentioned.map(byId).filter(Boolean), reason: "multi_mention", mentioned };
  }
  const cap = clamp(maxReplies == null ? clamp(list.length, 1, MAX_REPLIES_CAP) : maxReplies, 1, MAX_REPLIES_UI_MAX);
  return { queue: rotateFrom(list, lastSpeakerId, cap), reason: "rotate", mentioned: [] };
}

/** persona 的单行摘要（给「其他成员」那一栏，别把整段人格塞进去） */
function oneLine(member) {
  const raw = String((member && member.persona) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "（未设置说明）";
  return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
}

/**
 * 成员的系统提示（照 lead 给的模板，防角色翻转）。
 * @param {object} opts
 * @param {object} opts.member
 * @param {Array<object>} opts.members
 * @param {string} opts.userName
 * @param {number} [opts.maxChars]
 */
export function memberSystemPrompt({ member, members, userName, maxChars = 300 }) {
  const name = String((member && member.name) || "成员");
  const roleTag = String((member && member.roleTag) || (member && member.role) || "群成员");
  const persona = String((member && member.persona) || "").trim() || "你是一位乐于帮忙的对话成员，回答简洁、用用户的语言。";
  const others = orderMembers(members).filter((m) => m && m.id !== (member && member.id));
  const othersLine = others.length ? others.map((m) => "「" + m.name + "」：" + oneLine(m)).join(" / ") : "（无）";
  return (
    "你是「" + name + "」（" + roleTag + "）。" + persona +
    "\n\n当前群聊参与者：" +
    "\n- 用户：" + String(userName || "用户") +
    "\n- 其他成员：" + othersLine +
    "\n\n规则：" +
    "\n1. 你是「" + name + "」本人。别人的话会以「他们的名字：」前缀出现；不要替他们发言，不要复述他们刚说的。" +
    "\n2. 只回应用户最新这条消息里与你相关的部分。" +
    "\n3. 一次发言不超过 " + maxChars + " 字，不要使用“用户：”、“助手：”这类标签。" +
    "\n4. 如果你认为此刻没有补充价值，只输出 " + SILENT_TOKEN + "，系统会跳过你、不产生可见消息。" +
    "\n5. 可选：认为该收尾时最后一行写 " + END_TOKEN + "。"
  );
}

/**
 * 群聊上下文映射（防人格漂移）：自己 → assistant；别人 → user + 「名字」：前缀。
 * 一律不用 message.name 字段（多数 OpenAI 兼容端点直接忽略）。
 * @param {object} opts
 * @param {Array<object>} opts.messages        会话里的全部消息（按 seq/ts 升序）
 * @param {string} opts.responderId            当前回复者
 * @param {Array<object>} opts.members
 * @param {string} opts.system                 该成员的 system 提示
 * @param {Array<string>} [opts.extraUserLines] 追加到最末尾的 user 行（例如「X」：（未回复））
 * @returns {Array<object>} OpenAI 格式消息
 */
export function buildGroupTranscript({ messages, responderId, members, system, extraUserLines } = {}) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  const nameOf = (id) => {
    const m = (members || []).find((x) => x.id === id);
    return m && m.name ? m.name : "成员";
  };
  (messages || []).forEach((m) => {
    if (!m || m.role === "system") return;
    const text = m.content == null ? "" : String(m.content);
    if (m.role === "user") {
      out.push({ role: "user", content: text });
      return;
    }
    if (m.memberId === responderId) out.push({ role: "assistant", content: text });
    else out.push({ role: "user", content: "「" + nameOf(m.memberId) + "」：" + text });
  });
  if (extraUserLines && extraUserLines.length) out.push({ role: "user", content: extraUserLines.join("\n") });
  return out;
}

/**
 * 单调递增 seq：消息排序用它，不用 createdAt（同毫秒会撞）。
 * @param {Array<object>} messages
 * @returns {number}
 */
export function nextSeq(messages) {
  let max = 0;
  (messages || []).forEach((m) => {
    const s = Number(m && m.seq);
    if (isFinite(s) && s > max) max = s;
  });
  return max + 1;
}

/** 模型只输出静默标记时，这一条不该变成可见消息 */
export function isSilent(text) {
  const body = String(text || "").trim();
  if (!body) return true;
  const stripped = body.split(SILENT_TOKEN).join("").trim();
  return stripped.length === 0;
}

/** 去掉结尾的 [END] 标记，并告诉调用方该收尾了 */
export function stripEnd(text) {
  const body = String(text || "");
  if (!body.includes(END_TOKEN)) return { text: body, end: false };
  return { text: body.split(END_TOKEN).join("").trimEnd(), end: true };
}