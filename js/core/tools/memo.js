// js/core/tools/memo.js — memo 工具（**单条**备忘，整段覆盖）
// 用户口径（2026-11-25）：备忘只有一条、无长度上限、工具只有「更新」这一个动作。
// 没有 op / key / read / delete：调用一次 = 用新文本整段替换旧文本（不是追加）。
// executionMode 是 sequential：先读旧长度、再覆盖写，不能让两个调用交错。
"use strict";

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 缺方法就说清楚，不做「假装存上了」的降级 */
function need(store, name) {
  if (!store || typeof store[name] !== "function") {
    throw codeError("store_method_missing", "数据层缺少 " + name + "()：store.js 的备忘接口没接上（见 DEV.md §2.6）");
  }
}

/**
 * @param {{store: object}} deps
 */
export function createMemoTool({ store } = {}) {
  return {
    name: "memo",
    description:
      "更新备忘。**【整段覆盖】**：这次传进来的 text 会**替换掉**原来的整条备忘，不是在后面追加。" +
      "想把旧内容留下来，必须自己把旧内容一起写进这次的新文本里。" +
      "备忘只有一条、没有长度上限，适合记长期偏好、项目约定、待办要点。" +
      "传空字符串 = 清空备忘。这是备忘唯一的动作，没有单独的读取或删除。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "新的备忘全文（会整段覆盖旧备忘，不是追加）。要保留旧内容请自己拼进这次的新文本；传空字符串 = 清空备忘。",
        },
      },
      required: ["text"],
    },
    /**
     * @param {string} id
     * @param {{text?: string}} args
     * @param {AbortSignal} [signal]
     * @param {(update: object) => void} [onUpdate]
     */
    async execute(id, args, signal, onUpdate) {
      if (signal && signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (!args || typeof args.text !== "string") {
        throw codeError("bad_args", "memo 需要 text（字符串）；传空字符串表示清空备忘");
      }
      const text = args.text;

      need(store, "getMemo");
      need(store, "setMemo");

      const previous = String((await store.getMemo()) || "");
      const row = await store.setMemo(text);
      const length = String((row && row.text) || "").length;
      if (onUpdate) onUpdate({ length, previousLength: previous.length });

      const head = text
        ? "已更新备忘（共 " + length + " 字符，覆盖了原来的 " + previous.length + " 字符）"
        : "已清空备忘（原来的 " + previous.length + " 字符已删除）";
      const body = text ? "这次的内容整段替换了旧备忘，不是追加。" : "现在没有备忘内容。";

      return {
        content: [{ type: "text", text: head + "\n" + body }],
        details: { length, previousLength: previous.length, cleared: !text },
      };
    },
  };
}

export default createMemoTool;
