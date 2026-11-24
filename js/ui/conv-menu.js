// 会话动作菜单：私聊卡与群聊卡的顶栏 ⋮ 共用这一份实现，只靠 kind 区分菜单文案。
// 菜单 UI 走壳里已有的 ctx.openSheet，写操作只调 store 的公开方法，不碰 IndexedDB。
// 事件名对齐 dev-a 的列表卡：会话被改发 'conv:changed'（list.js:162 在听），
// 会话被删发 'conversation-removed'（shell.js:397 收回路由栈 + 归一成 data:changed）。
import { errorText } from "../core/util.js";

const LABELS = {
  direct: { rename: "重命名", remove: "删除会话" },
  group: { rename: "重命名群", remove: "删除群聊" },
};

/** 会话被改（标题/置顶/清空）：唯一广播点，不要在各卡片里另发明事件名 */
function emitChanged(ctx, convId) {
  if (ctx && ctx.events) ctx.events.emit("conv:changed", { id: convId });
}

/** 会话被删：壳收到后会收回路由栈，列表卡收到 data:changed 会重载 */
function emitRemoved(ctx, convId) {
  if (ctx && ctx.events) ctx.events.emit("conversation-removed", { convId: convId });
}

/**
 * 弹出会话动作菜单并执行选中项。
 * @param {{ctx:any, convId:string, kind:"direct"|"group"}} args
 * @returns {Promise<{key:string|null, conv:any, cleared:boolean, renamed:boolean,
 *                    pinnedChanged:boolean, deleted:boolean, error:string|null}>}
 */
export async function openConvMenu(args) {
  const ctx = (args && args.ctx) || {};
  const convId = args && args.convId;
  const kind = args && args.kind === "group" ? "group" : "direct";
  const result = {
    key: null,
    conv: null,
    cleared: false,
    renamed: false,
    pinnedChanged: false,
    deleted: false,
    error: null,
  };
  if (!ctx.store || !convId) return result;

  let conv = null;
  try {
    conv = await ctx.store.getConversation(convId);
  } catch (e) {
    result.error = "读取会话失败: " + errorText(e);
    return result;
  }
  result.conv = conv || null;
  if (!conv) return result;

  const words = LABELS[kind];
  const items = [
    { key: "pin", label: conv.pinned ? "取消置顶" : "置顶" },
    { key: "rename", label: words.rename },
    { key: "clear", label: "清空聊天记录" },
    { key: "remove", label: words.remove, danger: true },
  ];

  const key = await ctx.openSheet(items);
  result.key = key || null;
  if (!key) return result;

  try {
    if (key === "pin") {
      const next = !conv.pinned;
      // store.setPinned 自带「单一置顶」不变量：置顶某条会先清掉其它所有置顶
      await ctx.store.setPinned(convId, next);
      conv.pinned = next;
      result.pinnedChanged = true;
      emitChanged(ctx, convId);
    } else if (key === "rename") {
      const input = await ctx.prompt(words.rename, conv.title || "");
      if (input === null) return result;
      const title = String(input).trim();
      if (!title) return result;
      await ctx.store.updateConversation(convId, { title: title });
      conv.title = title;
      result.renamed = true;
      emitChanged(ctx, convId);
    } else if (key === "clear") {
      const ok = await ctx.confirm({
        title: "清空聊天记录",
        message: "清空这个会话的全部消息？会话本身会保留。",
        okText: "清空",
        danger: true,
      });
      if (!ok) return result;
      await ctx.store.clearMessages(convId);
      result.cleared = true;
      emitChanged(ctx, convId);
    } else if (key === "remove") {
      const ok = await ctx.confirm({
        title: words.remove,
        message: "删除这个会话？消息将一并删除。",
        okText: "删除",
        danger: true,
      });
      if (!ok) return result;
      await ctx.store.deleteConversation(convId);
      result.deleted = true;
      emitRemoved(ctx, convId);
      // 会话没了，退回列表
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
    }
  } catch (e) {
    result.error = "操作失败: " + errorText(e);
  }

  result.conv = conv;
  return result;
}

export default openConvMenu;