// js/core/tools/index.js — 工具清单的唯一出口
// 卡片不要各自 new 工具：一律 `createTools({ store, getSettings, ... })` 拿同一份。
// 现在十三个工具：
//   web_search（联网搜索，只回 title/url/snippet）
//   memo（单条备忘，整段覆盖）
//   context_info（只读自查：当前上下文多长、还剩多少预算）
//   set_name / set_persona / set_look（改「你自己」= 这一轮发言的成员，DEV.md §2.6）
//   list_conversations / get_conversation（只读：查会话 id、看别人的人设）
//   join_group / invite_to_group / kick_from_group / remove_user（会话之间的关系，DEV.md §2.7）
//   take_screen（夺屏：发 screen:takeover 让 shell 切到某个会话，DEV.md §2.7.4）
// update_agents_md 已按 lead 的决定删除：界面上没有「接受提案」的入口，留着只会让提案石沉大海。
"use strict";

import { createWebSearchTool } from "./web-search.js";
import { createMemoTool } from "./memo.js";
import { createContextInfoTool } from "./context-info.js";
import { createSetNameTool, createSetPersonaTool, createSetLookTool } from "./profile.js";
import {
  createListConversationsTool,
  createGetConversationTool,
  createJoinGroupTool,
  createInviteToGroupTool,
  createKickFromGroupTool,
  createRemoveUserTool,
} from "./social.js";
import { createTakeScreenTool } from "./screen.js";

/**
 * @param {{
 *   store?: object,
 *   getSettings?: () => object,
 *   getContextStats?: () => object|null,
 *   convId?: string,
 *   getResponder?: () => object|null,
 *   onChanged?: (change: object) => void,
 *   emit?: (event: string, payload?: object) => void
 * }} deps
 * @returns {Array<object>} 工具列表（顺序：web_search / memo / context_info / set_name / set_persona / set_look /
 *   list_conversations / get_conversation / join_group / invite_to_group / kick_from_group / remove_user / take_screen）
 */
export function createTools({ store, getSettings, getContextStats, convId, getResponder, onChanged, emit } = {}) {
  return [
    createWebSearchTool({ getSettings }),
    createMemoTool({ store }),
    createContextInfoTool({ store, getSettings, getContextStats, convId }),
    createSetNameTool({ store, convId, getResponder, onChanged }),
    createSetPersonaTool({ store, convId, getResponder, onChanged }),
    createSetLookTool({ store, convId, getResponder, onChanged }),
    createListConversationsTool({ store }),
    createGetConversationTool({ store }),
    createJoinGroupTool({ store, convId, getResponder, onChanged }),
    createInviteToGroupTool({ store, convId, getResponder, onChanged }),
    createKickFromGroupTool({ store, convId, getResponder, onChanged }),
    createRemoveUserTool({ store, convId, getResponder, onChanged }),
    // 只有夺屏需要 UI 事件通道：emit 不往别的工具里塞
    createTakeScreenTool({ store, convId, getResponder, emit }),
  ];
}

export {
  createWebSearchTool,
  createMemoTool,
  createContextInfoTool,
  createSetNameTool,
  createSetPersonaTool,
  createSetLookTool,
  createListConversationsTool,
  createGetConversationTool,
  createJoinGroupTool,
  createInviteToGroupTool,
  createKickFromGroupTool,
  createRemoveUserTool,
  createTakeScreenTool,
};
export default createTools;
