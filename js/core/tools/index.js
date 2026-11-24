// js/core/tools/index.js — 工具清单的唯一出口
// 卡片不要各自 new 工具：一律 `createTools({ store, getSettings, ... })` 拿同一份。
// 现在六个工具：web_search（联网搜索，只回 title/url/snippet）、memo（单条备忘，整段覆盖）、
// context_info（只读自查：当前上下文多长、还剩多少预算）、set_name / set_persona / set_look
// （改「你自己」= 这一轮发言的成员，DEV.md §2.6）。
// update_agents_md 已按 lead 的决定删除：界面上没有「接受提案」的入口，留着只会让提案石沉大海。
"use strict";

import { createWebSearchTool } from "./web-search.js";
import { createMemoTool } from "./memo.js";
import { createContextInfoTool } from "./context-info.js";
import { createSetNameTool, createSetPersonaTool, createSetLookTool } from "./profile.js";

/**
 * @param {{
 *   store?: object,
 *   getSettings?: () => object,
 *   getContextStats?: () => object|null,
 *   convId?: string,
 *   getResponder?: () => object|null,
 *   onChanged?: (change: object) => void
 * }} deps
 * @returns {Array<object>} 工具列表（顺序：web_search / memo / context_info / set_name / set_persona / set_look）
 */
export function createTools({ store, getSettings, getContextStats, convId, getResponder, onChanged } = {}) {
  return [
    createWebSearchTool({ getSettings }),
    createMemoTool({ store }),
    createContextInfoTool({ store, getSettings, getContextStats, convId }),
    createSetNameTool({ store, convId, getResponder, onChanged }),
    createSetPersonaTool({ store, convId, getResponder, onChanged }),
    createSetLookTool({ store, convId, getResponder, onChanged }),
  ];
}

export { createWebSearchTool, createMemoTool, createContextInfoTool, createSetNameTool, createSetPersonaTool, createSetLookTool };
export default createTools;
