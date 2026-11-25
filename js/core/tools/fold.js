// js/core/tools/fold.js — fold_context 工具（模型自己决定把最旧的一批折成摘要）
// 到预算只在 [5] 段提醒（见 context.js 的 buildContext），折不折由模型决定；
// 真正干活的是 context.js 的 foldOldest，工具不另写摘要、不自己写库。
// executionMode 是 sequential：要写 blocks 表、给消息打 foldedBlockId，不许两个调用并行。
"use strict";

import { estimateMessages, foldOldest } from "../context.js";

/**
 * [3] 压缩块 + [6] 未压缩消息两段的估 token。折叠只动这两段，其余四段与折叠无关。
 * 读不到（预览 mock store 缺方法）就返回 null，不编数字。
 * @returns {Promise<number|null>}
 */
async function measureContextTokens(store, convId) {
  try {
    const msgs =
      typeof store.listUnfoldedMessages === "function" ? (await store.listUnfoldedMessages(convId)) || [] : [];
    const blocks = typeof store.listBlocks === "function" ? (await store.listBlocks(convId)) || [] : [];
    const blockTokens = blocks.reduce((n, b) => n + (b && typeof b.tokens === "number" ? b.tokens : 0), 0);
    return estimateMessages(msgs) + blockTokens;
  } catch (e) {
    return null;
  }
}

/** 工具的返回值形状与 memo / context-info 一致 */
function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

/**
 * @param {{
 *   store?: object,
 *   getSettings?: () => object,
 *   convId?: string,
 *   getResponder?: () => object|null,
 *   emit?: (event: string, payload?: object) => void
 * }} deps
 */
export function createFoldTool({ store, getSettings, convId, getResponder, emit } = {}) {
  return {
    name: "fold_context",
    description:
      "把最旧的一批未压缩消息折叠成一条摘要，折叠后这些消息不再进上下文、占用的上下文会明显变小。" +
      "原始消息不会删（界面上照旧显示），只是不再发给模型。" +
      "只有上下文比较长、早期内容不再需要时才建议用；折叠本身要调一次模型，会多花几秒。" +
      "参数 force=true 可以忽略阈值直接折（默认 false：只在已到预算时折）。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "true = 忽略预算阈值，直接折最旧的一批；默认 false",
        },
      },
      required: [],
    },
    /**
     * @param {string} id
     * @param {{force?: boolean}} [args]
     * @param {AbortSignal} [signal]
     */
    async execute(id, args, signal) {
      if (signal && signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (!store || typeof store.getConversation !== "function") {
        return textResult("折叠不可用：数据层缺少 getConversation()（见 DEV.md §2.6）。", {
          folded: 0,
          error: "store_method_missing",
        });
      }
      if (!convId) {
        return textResult("折叠不可用：当前没有会话 id。", { folded: 0, error: "no_conv_id" });
      }

      const settings = (typeof getSettings === "function" ? getSettings() : null) || {};
      let conv = null;
      try {
        conv = await store.getConversation(convId);
      } catch (e) {
        conv = null;
      }
      if (!conv || !conv.id) {
        return textResult("折叠失败：读不到当前会话（" + convId + "），什么都没动。", {
          folded: 0,
          error: "no_conversation",
        });
      }

      // 群聊里 responder 是这一轮发言的成员，可能拿不到（允许 null）
      let responder = null;
      try {
        responder = typeof getResponder === "function" ? getResponder() : null;
      } catch (e) {
        responder = null;
      }

      const before = await measureContextTokens(store, convId);

      let result;
      try {
        result = await foldOldest({
          store,
          conv,
          responder,
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          signal,
          force: !!(args && args.force),
        });
      } catch (e) {
        // foldOldest 自己不抛；这里再兜一层，工具抛错会中断整轮对话
        const error = e && e.message ? e.message : String(e);
        return textResult("折叠失败：" + error + "。上下文保持原样，消息没有动。", { folded: 0, error });
      }

      if (result && result.error) {
        return textResult("折叠失败：" + result.error + "。上下文保持原样，消息没有动。", {
          folded: 0,
          error: result.error,
        });
      }

      const folded = result && typeof result.folded === "number" ? result.folded : 0;
      if (!folded) {
        return textResult("没有需要折叠的消息（当前上下文还比较短）", {
          folded: 0,
          reason: (result && result.reason) || "",
        });
      }

      const block = result.block || null;
      const after = await measureContextTokens(store, convId);
      const range = block ? "（原第 " + block.fromSeq + " 到 " + block.toSeq + " 条）" : "";
      const shrink = before != null && after != null ? "，约从 " + before + " token 降到 " + after + " token" : "";

      // 卡片据 context:folded 刷新统计；事件通道坏了不影响折叠结果
      if (typeof emit === "function") {
        try {
          emit("context:folded", { convId, folded });
        } catch (e) {
          /* 事件没人听就算了 */
        }
      }

      return textResult("已折叠 " + folded + " 条消息" + range + "成压缩块" + shrink, {
        folded,
        blockIndex: block ? block.index : null,
        tokensBefore: before,
        tokensAfter: after,
      });
    },
  };
}

export default createFoldTool;
