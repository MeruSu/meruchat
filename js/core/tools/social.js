// js/core/tools/social.js — 六个「会话之间」的工具
// list_conversations / get_conversation / join_group / invite_to_group / kick_from_group / remove_user
// 口径：DEV.md §2.7（2026-11-25 用户定，冻结）。关系表、冷却（COOLDOWN_MS）、软删除全在 store.js 里，
// 这里只做三件事：校验参数 → 调 store 的方法 → 把结果翻成人话。
// 不自己实现关系、不自己造兜底数据、不降级假装成功（缺方法一律 need() 报出来）。
// 数据层抛的 cooldown / already_in_group / not_a_group / no_member 一律**原样透出**：
// message 里带着剩余秒数，模型要看到的是数据层算出来的那个数，不是工具再算一遍。
//
// 签名统一成 `createXxxTool({ store, convId, getResponder, onChanged } = {})`。
// 六个关系工具**都不碰路由、也不发 UI 事件**：切屏幕是 take_screen 的事（那是 shell 的活，见 §2.7.4），
// 这里只负责把关系写进数据层，写完由 onChanged 通知卡片自己刷新。
"use strict";

const PERSONA_MAX = 200; // get_conversation 文案里 persona 的显示上限（按码点数）
const SHORT_ID_MAX = 8; // list_conversations 文案里的 id 前缀长度
const COOLDOWN_HINT_MIN = 3; // §2.7.1 COOLDOWN_MS = 180000，只在数据层没回 until 时用作提示

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 缺方法就说清楚，不做「假装改上了」的降级 */
function need(store, name) {
  if (!store || typeof store[name] !== "function") {
    throw codeError("store_method_missing", "数据层缺少 " + name + "()：社交工具没法动会话关系（见 DEV.md §2.7）");
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }
}

function text(v) {
  return String(v == null ? "" : v);
}

/** 按字符（码点）数，不按 UTF-16 长度 */
function chars(s) {
  return Array.from(text(s));
}

/** 读不到会话标题时的短 id：46089eba…（只截显示，不改数据） */
function shortId(id) {
  const a = chars(id);
  return a.length > SHORT_ID_MAX ? a.slice(0, SHORT_ID_MAX).join("") + "…" : a.join("");
}

/** 老数据没有 kind 字段 → 当私聊（与 profile.js 的 kindOf 同口径） */
function kindOf(conv) {
  return conv && conv.kind === "group" ? "group" : "direct";
}

function kindLabel(kind) {
  return kind === "group" ? "群聊" : "私聊";
}

function titleOfConv(conv, id) {
  return text(conv && conv.title) || shortId(id) || "（无标题）";
}

/** persona 超过 PERSONA_MAX 字截断加「…」；空的写成「（没有设定）」 */
function personaLine(persona) {
  if (!text(persona).trim()) return "（没有设定）";
  const a = chars(persona);
  return a.length > PERSONA_MAX ? a.slice(0, PERSONA_MAX).join("") + "…" : a.join("");
}

/** 剩余冷却的分钟数；拿不到 / 已过期 → null（此时不提冷却，不编一个数） */
function cooldownMinutes(until, fallbackMs) {
  const end = Number(until);
  if (Number.isFinite(end) && end > 0) {
    const left = end - Date.now();
    if (left <= 0) return null;
    return Math.max(1, Math.round(left / 60000));
  }
  if (Number.isFinite(fallbackMs) && fallbackMs > 0) return Math.max(1, Math.round(fallbackMs / 60000));
  return null;
}

/** 可选字符串参数：没给 / 给的不是字符串 → "" */
function optString(args, key) {
  const v = args && args[key];
  return typeof v === "string" ? v.trim() : "";
}

/** 当前会话 id：发言人所在会话优先，其次构造参数 convId；都没有就明确报错 */
function currentConvId(getResponder, convId) {
  let r = null;
  try {
    r = typeof getResponder === "function" ? getResponder() : null;
  } catch (e) {
    r = null;
  }
  const id = text((r && r.convId) || convId).trim();
  if (!id) {
    throw codeError(
      "no_conversation",
      "拿不到当前会话：这个工具要知道「我是哪个会话」才能动关系（需要 getResponder().convId 或 convId）"
    );
  }
  return id;
}

/** 读会话；读不到（没有这个方法 / 没有这条记录）返回 null，调用方自己决定报什么错 */
async function readConv(store, id) {
  if (!id || typeof store.getConversation !== "function") return null;
  try {
    return (await store.getConversation(id)) || null;
  } catch (e) {
    return null;
  }
}

/** 会话标题（只用于文案）；读不到就退回短 id，绝不编一个名字 */
async function convTitle(store, id) {
  return titleOfConv(await readConv(store, id), id);
}

/** 成员数；数据层没有 listMembers 或返回非数组 → null（文案里就不提人数） */
async function memberCountOf(store, convId) {
  if (typeof store.listMembers !== "function") return null;
  const list = await store.listMembers(convId);
  if (!Array.isArray(list)) {
    throw codeError("store_error", "listMembers(" + convId + ") 没返回数组：数不出成员数");
  }
  return list.length;
}

/** 改完通知 UI；UI 挂了也不许把工具搞失败 */
function notify(onChanged, payload) {
  try {
    if (typeof onChanged === "function") onChanged(payload);
  } catch (e) {
    /* 忽略 */
  }
}

// ================================================================ list_conversations
export function createListConversationsTool({ store } = {}) {
  return {
    name: "list_conversations",
    description:
      "列出**这台设备上的所有会话**（含已被用户软删除的，带 removedByUser 标记），每项给出 id / 标题 / 私聊还是群聊 / 成员数。" +
      "这是查会话 id 的入口：join_group、invite_to_group、kick_from_group、get_conversation、take_screen 都要先拿到 id。" +
      "只读，不改任何东西。",
    // 只读也走 sequential：DEV.md §2.7 末行「都改库」的统一口径（顺带保证一批调用里它先跑完，
    // 后面的 join / invite 拿到的是同一份会话列表）
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(id, args, signal) {
      checkAbort(signal);
      need(store, "listConversations");
      need(store, "listMembers");

      const list = await store.listConversations();
      if (!Array.isArray(list)) {
        throw codeError("store_error", "listConversations() 没返回数组：查不到会话列表");
      }

      const rows = [];
      for (const c of list) {
        if (!c || !c.id) continue;
        const members = await store.listMembers(c.id);
        if (!Array.isArray(members)) {
          throw codeError("store_error", "listMembers(" + c.id + ") 没返回数组：数不出成员数");
        }
        rows.push({
          id: String(c.id),
          title: text(c.title),
          kind: kindOf(c),
          memberCount: members.length,
          removedByUser: c.removedByUser === true,
        });
      }

      const lines = rows.length ? ["共 " + rows.length + " 个会话："] : ["还没有任何会话。"];
      for (const r of rows) {
        lines.push(
          "- " +
            shortId(r.id) +
            " " +
            (r.title || "（无标题）") +
            "（" +
            kindLabel(r.kind) +
            "，" +
            r.memberCount +
            " 位成员" +
            (r.removedByUser ? "，已被删除" : "") +
            "）"
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: rows.length, conversations: rows },
      };
    },
  };
}

// ================================================================ get_conversation
export function createGetConversationTool({ store } = {}) {
  return {
    name: "get_conversation",
    description:
      "按 id 查**一个会话**的详情：标题、私聊还是群聊、群公告、主题色、壁纸，以及它每个成员的名字与设定/人格全文。" +
      "想知道群里那几位是什么人设、或者确认某个 id 是不是群，就看这里。id 用 list_conversations 查。只读。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "会话 id（用 list_conversations 查，形如 46089eba…）" },
      },
      required: ["id"],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const id = optString(args, "id");
      if (!id) throw codeError("bad_args", "get_conversation 需要 id（先用 list_conversations 查会话 id）");

      need(store, "getConversation");
      need(store, "listMembers");

      const conv = await readConv(store, id);
      if (!conv) throw codeError("not_found", "没有 id 为 " + id + " 的会话，先用 list_conversations 查");

      const list = await store.listMembers(id);
      if (!Array.isArray(list)) {
        throw codeError("store_error", "listMembers(" + id + ") 没返回数组：读不出成员");
      }
      const members = list
        .filter((m) => m && m.id)
        .map((m) => ({ id: String(m.id), name: text(m.name), persona: text(m.persona) }));

      const kind = kindOf(conv);
      const lines = ["会话「" + titleOfConv(conv, id) + "」（" + kindLabel(kind) + "）"];
      if (!members.length) lines.push("（还没有成员）");
      for (const m of members) {
        lines.push("- " + (m.name || "（无名）") + "：" + personaLine(m.persona));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          id: String(conv.id || id),
          title: text(conv.title),
          kind,
          announcement: conv.announcement,
          accent: conv.accent,
          wallpaper: conv.wallpaper,
          members,
        },
      };
    },
  };
}

// ================================================================ join_group
export function createJoinGroupTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "join_group",
    description:
      "把**你自己所在的会话**（这一轮发言的成员所属的那个会话）作为一个成员加进目标群。" +
      "入群只校验三件事：群存在、冷却已过、你不在群里 —— 知道群 id 就能申请。群 id 用 list_conversations 查。" +
      "被这个群踢过的 3 分钟冷却里会失败，错误里带着还要等多少秒。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "目标群会话 id（用 list_conversations 查 kind 为 group 的那个）" },
      },
      required: ["groupId"],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const groupId = optString(args, "groupId");
      if (!groupId) throw codeError("bad_args", "join_group 需要 groupId（先用 list_conversations 查群会话 id）");

      const mine = currentConvId(getResponder, convId);
      if (groupId === mine) throw codeError("bad_args", "你就在这个会话里，join_group 要的是**别的**群 id");

      need(store, "getConversation");
      const group = await readConv(store, groupId);
      if (!group) throw codeError("not_found", "没有 id 为 " + groupId + " 的会话，先用 list_conversations 查");
      if (kindOf(group) !== "group") {
        throw codeError("not_a_group", "「" + titleOfConv(group, groupId) + "」不是群聊，进不去");
      }

      need(store, "joinConversationToGroup");
      // 数据层抛的 cooldown / already_in_group / not_a_group / no_member 原样透出（message 带剩余秒数）
      const res = await store.joinConversationToGroup({ groupId, convId: mine });
      if (res && res.ok === false) throw codeError("join_failed", "数据层没有让入群生效（joinConversationToGroup 返回 ok:false）");

      const count = await memberCountOf(store, groupId);
      const tail = count == null ? "" : "，现在是群里第 " + count + " 位成员";
      notify(onChanged, { convId: groupId, kind: "social", action: "join" });

      return {
        content: [{ type: "text", text: "已加入群「" + titleOfConv(group, groupId) + "」" + tail + "。" }],
        details: {
          groupId,
          convId: mine,
          member: (res && res.member) || null,
          memberCount: count,
        },
      };
    },
  };
}

// ================================================================ invite_to_group
export function createInviteToGroupTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "invite_to_group",
    description:
      "把**另一个会话**拉进群（默认拉进**当前这个群**）。是**引用**不是复制：被拉进来的还是它自己那条会话，" +
      "名字、人设、头像、配色都共用一份，在群里改、在它自己的会话里也会变（DEV.md §2.8）。" +
      "只有群聊能拉人；自己正在私聊里就不能用。" +
      "convId 是要拉的那个会话 id，groupId 不给就是当前群 —— 两个都可以用 list_conversations 查。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        convId: { type: "string", description: "要拉进群的那个会话 id（用 list_conversations 查）" },
        groupId: { type: "string", description: "拉进哪个群；不给 = 当前这个会话（必须是群）" },
      },
      required: ["convId"],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const targetConvId = optString(args, "convId");
      if (!targetConvId) throw codeError("bad_args", "invite_to_group 需要 convId（要拉进群的那个会话 id）");

      const mine = currentConvId(getResponder, convId);
      const groupId = optString(args, "groupId") || mine;

      need(store, "getConversation");
      const group = await readConv(store, groupId);
      if (!group) throw codeError("not_found", "没有 id 为 " + groupId + " 的会话，先用 list_conversations 查");
      if (kindOf(group) !== "group") {
        throw codeError(
          "not_a_group",
          groupId === mine
            ? "只有群聊会话能拉人，当前是私聊"
            : "「" + titleOfConv(group, groupId) + "」不是群聊，拉不进去"
        );
      }
      if (targetConvId === groupId) throw codeError("bad_args", "不能把这个群自己拉进群");

      need(store, "inviteConversationToGroup");
      // 冷却、已在群里等错误由数据层给出，原样透出
      const res = await store.inviteConversationToGroup({ groupId, convId: targetConvId });
      if (res && res.ok === false) throw codeError("invite_failed", "数据层没有把人拉进群（inviteConversationToGroup 返回 ok:false）");

      const invited = await convTitle(store, targetConvId);
      const count = await memberCountOf(store, groupId);
      notify(onChanged, { convId: groupId, kind: "social", action: "invite" });

      return {
        content: [
          {
            type: "text",
            text:
              "已把「" +
              invited +
              "」拉进群「" +
              titleOfConv(group, groupId) +
              "」" +
              (count == null ? "。" : "，现在 " + count + " 位成员。"),
          },
        ],
        details: {
          groupId,
          convId: targetConvId,
          member: (res && res.member) || null,
          memberCount: count,
        },
      };
    },
  };
}

// ================================================================ kick_from_group
export function createKickFromGroupTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "kick_from_group",
    description:
      "把**某个会话**从这个群里移出去（只删群里的那条引用，它自己的会话、人设、历史都还在），" +
      "并给它写上 3 分钟冷却（这 3 分钟内它不能再进群）。" +
      "只有群聊能用，且不许踢自己。convId 是要踢出去的那个会话 id（用 list_conversations 查）。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        convId: { type: "string", description: "要踢出群的那个会话 id（用 list_conversations 查）" },
      },
      required: ["convId"],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const targetConvId = optString(args, "convId");
      if (!targetConvId) throw codeError("bad_args", "kick_from_group 需要 convId（要踢出去的那个会话 id）");

      const mine = currentConvId(getResponder, convId);
      if (targetConvId === mine) throw codeError("bad_args", "不能踢自己");

      need(store, "getConversation");
      const group = await readConv(store, mine);
      if (!group) throw codeError("not_found", "读不到当前会话（id " + mine + "）：不知道在哪个群里踢人");
      if (kindOf(group) !== "group") throw codeError("not_a_group", "只有群聊会话能踢人，当前是私聊");

      need(store, "kickConversationFromGroup");
      // 不在群里 → 数据层报 no_member，原样透出
      const res = await store.kickConversationFromGroup({ groupId: mine, convId: targetConvId, byConvId: mine });
      if (res && res.ok === false) throw codeError("kick_failed", "数据层没有把人踢出去（kickConversationFromGroup 返回 ok:false）");

      const kicked = await convTitle(store, targetConvId);
      const resUntil = res && Number(res.until);
      const mins = cooldownMinutes(resUntil, COOLDOWN_HINT_MIN * 60000);
      notify(onChanged, { convId: mine, kind: "social", action: "kick" });

      return {
        content: [
          {
            type: "text",
            text:
              "已把「" +
              kicked +
              "」踢出群「" +
              titleOfConv(group, mine) +
              "」。" +
              (mins == null ? "" : mins + " 分钟内它不能再申请进群。"),
          },
        ],
        details: {
          groupId: mine,
          convId: targetConvId,
          removedCount: res && typeof res.removedCount === "number" ? res.removedCount : 0,
          until: resUntil || 0,
        },
      };
    },
  };
}

// ================================================================ remove_user
export function createRemoveUserTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "remove_user",
    description:
      "处理**用户**（对面那个真人）和当前会话的关系：私聊里 = 删好友，群聊里 = 把用户踢出群。" +
      "两种都写关系表与冷却，之后用户在这个会话里发消息会失败（要想恢复得走好友申请 / 进群申请）。" +
      "不需要参数 —— 动的一定是**当前会话**。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const mine = currentConvId(getResponder, convId);

      need(store, "getConversation");
      need(store, "removeUserFromConversation");
      const conv = await readConv(store, mine);
      if (!conv) throw codeError("not_found", "读不到当前会话（id " + mine + "）：不知道要跟谁断关系");

      const res = await store.removeUserFromConversation(mine);
      if (res && res.ok === false) {
        throw codeError("remove_failed", "数据层没有把用户删掉（removeUserFromConversation 返回 ok:false）");
      }
      const kind = kindOf(conv);
      const title = titleOfConv(conv, mine);
      notify(onChanged, { convId: mine, kind: "social", action: "remove_user" });

      const line =
        kind === "group"
          ? "已把用户踢出群「" + title + "」。"
          : "已把用户从「" + title + "」里删除，他发消息会失败，可以先发好友申请。";

      return {
        content: [{ type: "text", text: line }],
        details: {
          convId: mine,
          kind,
          until: res && Number(res.until) ? Number(res.until) : 0,
        },
      };
    },
  };
}

export default createListConversationsTool;
