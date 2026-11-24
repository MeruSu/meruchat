// preview/mock.js — 单卡预览用的假数据层
// 目的：任何一张卡片都能脱离 IndexedDB、脱离真网关、脱离其它卡片单独挂载，
// 让人肉眼确认这一张卡片的样子。全部是内存对象，刷新即重置。
"use strict";

// 解析函数（resolveAccent / resolveWallpaper / resolveAvatarColor / resolveMemberAccent）
// 直接复用真 store 的实现——预览层不复写口径，卡片拿到的结果与真机完全一致。
import {
  resolveAccent,
  resolveWallpaper,
  resolveAvatarColor,
  resolveMemberAccent,
} from "../js/core/store.js";

let seq = 0;
const uid = (p) => (p || "id") + "-" + (++seq).toString(36).padStart(3, "0");
const now = () => Date.now();

/** 场景：seed（默认，有 1 私聊 + 1 群聊）、empty（什么都没有） */
export function buildFixture(scenario) {
  const t0 = now() - 3600_000;
  const directConv = {
    id: "conv-direct",
    title: "助手",
    kind: "direct",
    pinned: true,
    createdAt: t0,
    updatedAt: t0 + 600_000,
  };
  const groupConv = {
    id: "conv-group",
    title: "设计三人组",
    kind: "group",
    pinned: false,
    createdAt: t0 + 60_000,
    updatedAt: t0 + 900_000,
  };

  const directMember = {
    id: "mem-direct",
    convId: directConv.id,
    name: "助手",
    persona: "你是一位乐于帮忙的对话成员，回答简洁、用用户的语言。",
    sort: 1,
  };
  const groupMembers = [
    { id: "mem-a", convId: groupConv.id, name: "小满", persona: "你是产品设计，说话直接，先给结论。", sort: 1 },
    { id: "mem-b", convId: groupConv.id, name: "阿岩", persona: "你是前端工程师，关注实现成本与边界。", sort: 2 },
    { id: "mem-c", convId: groupConv.id, name: "青禾", persona: "你是文案，语言克制，爱用短句。", sort: 3 },
  ];

  const messages = [
    { id: uid("m"), convId: directConv.id, memberId: directMember.id, role: "user", content: "你好，用一句话自我介绍", ts: t0 + 30_000 },
    { id: uid("m"), convId: directConv.id, memberId: directMember.id, role: "assistant", content: "你好！我是一个乐于帮忙的对话成员，回答简洁、用你的语言交流。", ts: t0 + 31_000 },
    { id: uid("m"), convId: directConv.id, memberId: directMember.id, role: "user", content: "这个项目现在到哪一步了？", ts: t0 + 120_000 },
    { id: uid("m"), convId: directConv.id, memberId: directMember.id, role: "assistant", content: "卡片已经拆完并各自能单独挂载，剩下的是视觉打磨和详情页联调。", ts: t0 + 121_000 },

    { id: uid("m"), convId: groupConv.id, memberId: "mem-a", role: "user", content: "首页要不要做一个置顶会话的强调？", ts: t0 + 200_000 },
    { id: uid("m"), convId: groupConv.id, memberId: "mem-a", role: "assistant", content: "要。但强调只能有一个，靠左侧一条 2px 竖线就够，不要加底色。", ts: t0 + 201_000 },
    { id: uid("m"), convId: groupConv.id, memberId: "mem-b", role: "assistant", content: "实现上没问题，单置顶的不变量我加在 store 里，切置顶是原子操作。", ts: t0 + 203_000 },
    { id: uid("m"), convId: groupConv.id, memberId: "mem-c", role: "assistant", content: "文案我建议就写「置顶」，不要「固定到顶部」。", ts: t0 + 205_000 },
  ];

  if (scenario === "empty") {
    return { conversations: [], members: [], messages: [] };
  }

  return {
    conversations: [directConv, groupConv],
    members: [directMember, ...groupMembers],
    messages,
  };
}

/**
 * 内存 store，接口与 js/core/store.js 对齐（只实现卡片真正会调的那些）。
 * @param {{conversations:any[],members:any[],messages:any[]}} data
 * @param {object} events 事件总线（用来广播变更）
 */
export function createMockStore(data, events) {
  const state = {
    conversations: data.conversations.map((c) => ({ ...c })),
    members: data.members.map((m) => ({ ...m })),
    messages: data.messages.map((m) => ({ ...m })),
    settings: {
      // §2.3 口径：User = {name, avatar, defaultWallpaper, accent}
      name: "内测用户01",
      avatar: { label: "内", color: "#f5a623" },
      accent: "#0075de",
      defaultWallpaper: "aurora",
      dim: 0,
      baseUrl: "https://gw.ms7.pw/cors/v1",
      model: "opencode-go/deepseek-v4.1-flash",
      apiKey: "",
    },
  };

  const emit = (name, payload) => {
    if (events) events.emit(name, payload || {});
  };

  const byId = (arr, id) => arr.findIndex((x) => x.id === id);

  return {
    ready: async () => ({ settings: { ...state.settings } }),

    listConversations: async () =>
      state.conversations
        .slice()
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt),

    getConversation: async (id) => {
      const i = byId(state.conversations, id);
      return i >= 0 ? { ...state.conversations[i] } : null;
    },

    putConversation: async (c) => {
      const i = byId(state.conversations, c.id);
      if (i >= 0) state.conversations[i] = { ...state.conversations[i], ...c };
      else state.conversations.push({ ...c });
      emit("conversations-changed", { convId: c.id });
      return c;
    },

    updateConversation: async (id, patch) => {
      const i = byId(state.conversations, id);
      if (i >= 0) state.conversations[i] = { ...state.conversations[i], ...patch, updatedAt: now() };
      emit("conversations-changed", { convId: id });
    },

    touchConversation: async (id) => {
      const i = byId(state.conversations, id);
      if (i >= 0) state.conversations[i].updatedAt = now();
    },

    setPinned: async (id, pinned) => {
      for (const c of state.conversations) c.pinned = c.id === id ? !!pinned : false;
      emit("conversations-changed", { convId: id });
    },

    deleteConversation: async (id) => {
      const i = byId(state.conversations, id);
      if (i >= 0) state.conversations.splice(i, 1);
      state.members = state.members.filter((m) => m.convId !== id);
      state.messages = state.messages.filter((m) => m.convId !== id);
      emit("conversation-removed", { convId: id });
      emit("conversations-changed", { convId: id, removed: true });
    },

    listMembers: async (convId) =>
      state.members.filter((m) => m.convId === convId).sort((a, b) => (a.sort || 0) - (b.sort || 0)),

    getMember: async (id) => {
      const i = byId(state.members, id);
      return i >= 0 ? { ...state.members[i] } : null;
    },

    putMember: async (m) => {
      const i = byId(state.members, m.id);
      if (i >= 0) state.members[i] = { ...state.members[i], ...m };
      else state.members.push({ ...m });
      emit("members-changed", { convId: m.convId, memberId: m.id });
      return m;
    },

    addMember: async (m) => {
      state.members.push({ ...m });
      emit("members-changed", { convId: m.convId, memberId: m.id, added: true });
      return m;
    },

    updateMember: async (id, patch) => {
      const i = byId(state.members, id);
      if (i >= 0) state.members[i] = { ...state.members[i], ...patch };
      const convId = i >= 0 ? state.members[i].convId : null;
      emit("members-changed", { convId, memberId: id });
    },

    deleteMember: async (id) => {
      const i = byId(state.members, id);
      const convId = i >= 0 ? state.members[i].convId : null;
      if (i >= 0) state.members.splice(i, 1);
      emit("members-changed", { convId, memberId: id, removed: true });
    },

    listMessages: async (convId) =>
      state.messages.filter((m) => m.convId === convId).sort((a, b) => a.ts - b.ts),

    addMessage: async (m) => {
      state.messages.push({ ...m });
      emit("messages-changed", { convId: m.convId });
      return m;
    },

    clearMessages: async (convId) => {
      state.messages = state.messages.filter((m) => m.convId !== convId);
      emit("messages-changed", { convId });
    },

    deleteMessages: async (ids) => {
      const set = new Set(ids || []);
      state.messages = state.messages.filter((m) => !set.has(m.id));
    },

    getSettings: async () => ({ ...state.settings }),

    setSettings: async (patch) => {
      state.settings = { ...state.settings, ...(patch || {}) };
      emit("settings:changed", { ...state.settings });
      return { ...state.settings };
    },

    /** 预览专用：让测试脚本能读到当前内存状态 */
    __state: state,

    // §2.3 口径的解析函数：与真 store 同一实现（卡片只会走这四个入口）
    resolveAccent: (conv, user) => resolveAccent(conv, user || state.settings),
    resolveWallpaper: (conv, user) => resolveWallpaper(conv, user || state.settings),
    resolveAvatarColor: (avatar, accent) => resolveAvatarColor(avatar, accent),
    resolveMemberAccent: (member, user) => resolveMemberAccent(member, user || state.settings),
  };
}

/**
 * 假网关：不联网，逐字吐一句固定回复，用来确认流式渲染与气泡状态。
 * 签名与 js/core/api.js 的 streamChat 一致。
 */
export async function streamChat({ messages, onDelta, signal }) {
  const last = (messages || []).filter((m) => m.role === "user").pop();
  const reply =
    "（预览回复）收到你的消息：" +
    String((last && last.content) || "").slice(0, 40) +
    "。这条回复由预览层的假网关生成，不消耗任何额度。";
  const emit = typeof onDelta === "function" ? onDelta : () => {};
  for (const ch of Array.from(reply)) {
    if (signal && signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    emit(ch);
    await new Promise((r) => setTimeout(r, 18));
  }
  return reply;
}

export default { buildFixture, createMockStore, streamChat };
