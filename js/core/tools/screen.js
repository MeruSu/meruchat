// js/core/tools/screen.js — 夺屏工具 take_screen
// 口径：DEV.md §2.7.4（2026-11-25 用户定，冻结）。工具不碰 router，也不碰 DOM：
// 它只发一条事件 `screen:takeover { convId, kind }`，由 shell 收到后 reset + push 到对应聊天卡。
// 因此它需要 deps.emit（UI 事件通道）—— 拿不到就明确报 no_emit，不假装切过去了。
// 为什么不自己在工具里调 router.push：那会和 shell 的 reset+push 打架（切两次 / 栈里多一层），
// 路由只留一个驱动者。
"use strict";

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 缺方法就说清楚，不做「假装切过去了」的降级 */
function need(store, name) {
  if (!store || typeof store[name] !== "function") {
    throw codeError("store_method_missing", "数据层缺少 " + name + "()：夺屏工具没法确认会话（见 DEV.md §2.7）");
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

/** 老数据没有 kind 字段 → 当私聊（与 profile.js / social.js 同口径） */
function kindOf(conv) {
  return conv && conv.kind === "group" ? "group" : "direct";
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
      "拿不到当前会话：不给 convId 时夺屏需要知道「我在哪个会话」（需要 getResponder().convId 或 convId）"
    );
  }
  return id;
}

// ================================================================ take_screen
export function createTakeScreenTool({ store, convId, getResponder, emit } = {}) {
  return {
    name: "take_screen",
    description:
      "把**用户的屏幕强行切到某个会话**（夺屏）：界面会当场跳到那个会话的聊天页，用户看着就变了。" +
      "不传 convId = 切到**我自己所在的这个会话**。只在真的需要用户马上看到某个会话时才用，别拿它刷屏。" +
      "会话 id 用 list_conversations 查。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        convId: { type: "string", description: "要切过去的会话 id；不给 = 我现在所在的这个会话" },
      },
      required: [],
    },
    async execute(callId, args, signal) {
      checkAbort(signal);
      const asked = args && typeof args.convId === "string" ? args.convId.trim() : "";
      const target = asked || currentConvId(getResponder, convId);

      need(store, "getConversation");
      let conv = null;
      try {
        conv = (await store.getConversation(target)) || null;
      } catch (e) {
        conv = null;
      }
      if (!conv) throw codeError("not_found", "没有 id 为 " + target + " 的会话，先用 list_conversations 查");

      if (typeof emit !== "function") throw codeError("no_emit", "夺屏需要 UI 事件通道");

      const id = text(conv.id) || target;
      const kind = kindOf(conv);
      // 只发事件：切路由是 shell 的事（DEV.md §2.7.4）。emit 抛错就让工具失败 —— 没切过去不许报成功。
      emit("screen:takeover", { convId: id, kind });

      const title = text(conv.title) || id;
      return {
        content: [{ type: "text", text: "已把屏幕切到「" + title + "」。" }],
        details: { convId: id, kind, title, switchedByDefault: !asked },
      };
    },
  };
}

export default createTakeScreenTool;
