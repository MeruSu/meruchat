// js/core/tools/context-info.js — context_info 工具（只读：查当前上下文有多长）
// 这是 DEV.md §2.6 的「自检」工具：模型自己能看到还剩多少预算，不必等用户问。
// 数据来源优先级：卡片传进来的 contextStats（就是底栏那行）> 直接从 store 现算。
// 只读、幂等，所以 executionMode 用默认的并行；不要在这里折叠，折叠只发生在发消息前。
"use strict";

import { estimateMessages, estimateTokens } from "../context.js";

const DEFAULT_BUDGET = 100000; // 与 store.js 的 DEFAULT_CONTEXT_BUDGET 同口径（§2.6）

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

/** 1320 → "1320"，13245 → "13.2k"；与底栏同一口径 */
function fmtTokens(n) {
  const v = num(n);
  if (v < 1000) return String(Math.round(v));
  return (v / 1000).toFixed(1) + "k";
}

function pct(part, whole) {
  if (!whole) return "0%";
  return Math.round((part / whole) * 100) + "%";
}

/**
 * @param {{store?: object, getSettings?: () => object, getContextStats?: () => object|null, convId?: string}} deps
 */
export function createContextInfoTool({ store, getSettings, getContextStats, convId } = {}) {
  /** 现算兜底：没有 contextStats 时（预览 mock store、或卡片还没拼过上下文） */
  async function measureFromStore() {
    if (!store) return null;
    const id = convId;
    const out = { blocks: [], unfolded: [], memo: "" };
    if (typeof store.listBlocks === "function" && id) out.blocks = (await store.listBlocks(id)) || [];
    if (typeof store.listUnfoldedMessages === "function" && id) out.unfolded = (await store.listUnfoldedMessages(id)) || [];
    // memo 全局唯一（用户口径），不按会话分桶：与 memo 工具写入的是同一条
    if (typeof store.getMemo === "function") out.memo = String((await store.getMemo()) || "");
    return out;
  }

  function readStats() {
    if (typeof getContextStats !== "function") return null;
    try {
      const st = getContextStats();
      return st && typeof st === "object" ? st : null;
    } catch (e) {
      return null;
    }
  }

  return {
    name: "context_info",
    description:
      "查当前这次对话的上下文长度：预算多少、现在用了多少、有几个压缩块、未压缩几条、六段各占多少。" +
      "只读，不修改任何东西。想知道自己还剩多少空间、或者要不要提前整理时调用它。",
    parameters: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description: "true 时额外列出每个压缩块覆盖的消息区间与 token 数",
        },
      },
      required: [],
    },
    async execute(id, args, signal) {
      if (signal && signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      const verbose = !!(args && args.verbose);
      const settings = (typeof getSettings === "function" ? getSettings() : null) || {};
      const budget = settings.contextBudget == null ? DEFAULT_BUDGET : num(settings.contextBudget);
      const compress = settings.contextCompress !== false;

      const stats = readStats();
      let estimated = stats ? num(stats.estimated) : 0;
      let parts = stats && stats.parts ? stats.parts : null;
      let blocks = null;
      let unfoldedCount = 0;
      let unfoldedTokens = 0;

      const fromStore = await measureFromStore();
      if (fromStore) {
        blocks = fromStore.blocks;
        unfoldedCount = (fromStore.unfolded || []).length;
        unfoldedTokens = estimateMessages(fromStore.unfolded || []);
      }

      if (!stats && fromStore) {
        const blockTokens = (blocks || []).reduce((s, b) => s + num(b && b.tokens), 0);
        // 备忘只有一条，原文整段注入（§2.6 第 [4] 段），不再有 key 前缀
        const memoBody = String(fromStore.memo || "").trim();
        const memoTokens = memoBody ? estimateTokens("当前备忘：\n" + memoBody) : 0;
        estimated = blockTokens + memoTokens + unfoldedTokens;
        parts = { blocks: blockTokens, memo: memoTokens, history: unfoldedTokens };
      }

      if (!fromStore && !stats) {
        throw codeError("no_data", "拿不到上下文数据：既没有 contextStats，store 也没有 blocks / messages 接口");
      }

      const live = budget > 0 && compress;
      // 块数以 contextStats 为准（那是卡片刚算完的），没有才退回现查的块列表
      const blockCount =
        stats && stats.blocks != null
          ? num(stats.blocks) || 0
          : blocks
          ? blocks.length
          : 0;
      const lines = [];

      if (budget <= 0) {
        lines.push("预算：不限（全量直喂，不折叠）");
      } else if (!compress) {
        lines.push("预算：" + fmtTokens(budget) + " token（自动压缩已关，超了也不折叠）");
      } else {
        lines.push("预算：" + fmtTokens(budget) + " token · 自动压缩开");
      }

      if (live && budget > 0) {
        lines.push(
          "当前上下文：约 " + fmtTokens(estimated) + " token（占预算 " + pct(estimated, budget) + "），还剩约 " +
            fmtTokens(Math.max(0, budget - estimated)) + " token"
        );
      } else {
        lines.push("当前上下文：约 " + fmtTokens(estimated) + " token（不折叠，超过模型窗口会直接报错）");
      }

      lines.push("压缩块：" + blockCount + " 个" + (blockCount >= 8 ? "（已达上限 8，下块会把前 4 块蒸馏成一块）" : ""));
      lines.push("未压缩消息：" + unfoldedCount + " 条" + (unfoldedTokens ? "（约 " + fmtTokens(unfoldedTokens) + " token）" : ""));

      if (parts) {
        const seg = [];
        if (parts.agentsMd != null) seg.push("AGENTS.md " + fmtTokens(parts.agentsMd));
        if (parts.persona != null) seg.push("设定 " + fmtTokens(parts.persona));
        if (parts.blocks != null) seg.push("压缩块 " + fmtTokens(parts.blocks));
        if (parts.memo != null) seg.push("memo " + fmtTokens(parts.memo));
        if (parts.tools != null) seg.push("工具与时间 " + fmtTokens(parts.tools));
        if (parts.history != null) seg.push("历史 " + fmtTokens(parts.history));
        if (seg.length) lines.push("组成：" + seg.join(" · "));
      }

      if (live && budget > 0 && estimated >= budget * 0.8) {
        lines.push("提示：已用超过 80% 预算，下一条消息发出前会自动折叠最旧的一批。");
      }

      if (verbose && blocks && blocks.length) {
        lines.push("压缩块明细：");
        blocks
          .slice()
          .sort((a, b) => num(a.index) - num(b.index))
          .forEach((b) => {
            lines.push(
              "  块 " + b.index + "｜原第 " + b.fromSeq + "–" + b.toSeq + " 条｜" + num(b.count) + " 条｜" + fmtTokens(b.tokens) + " token"
            );
          });
      }

      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          budget,
          compress,
          estimated,
          blocks: blockCount,
          unfolded: unfoldedCount,
          parts: parts || null,
        },
      };
    },
  };
}

export default createContextInfoTool;
