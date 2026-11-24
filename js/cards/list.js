// js/cards/list.js — 会话列表卡片
// DOM 逐字照抄 C:\Meru\website\su\preview\styles.html 第 741-749 行（aside）+ 956-981 行（renderConvs 的行模板），
// 只把写死的 6 条假会话换成 store 里的真实数据。class 一个不改、元素一个不增删。
// 视觉全部交给 css/style-kit.css（该文件禁止修改）；本卡片只写外框。
"use strict";

import { menu, promptDialog, confirmDialog } from "../ui/atoms.js";
import { renderAvatar } from "../ui/avatar.js";
import { el } from "../core/util.js";

const TITLE = "会话";

/** stagger 只覆盖前 8 行（§2.5 第 6 项：8 × 24ms + 180ms ≈ 372ms，不超 400ms） */
const STAGGER_MAX = 8;

/** 头像统一走 {label,color}（store.avatarForName 生成），这里不再自造渐变/首字 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 会话形态：kind 优先；旧数据（无 kind）按成员数兜底，仅用于显示，不写回 */
function kindOf(conv, members) {
  if (conv && (conv.kind === "direct" || conv.kind === "group")) return conv.kind;
  return members && members.length >= 2 ? "group" : "direct";
}

function chatCardId(kind) {
  return kind === "group" ? "chat-group" : "chat-direct";
}

function detailCardId(kind) {
  return kind === "group" ? "detail-group" : "detail-direct";
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? hh + ":" + mm : d.getMonth() + 1 + "/" + d.getDate();
}

/** 照 styles.html 741-749 行，逐字 */
const ASIDE_HTML =
  '<div class="sl-top">' +
  '  <button class="sl-settings" id="gearBtn" type="button" aria-label="设置" title="设置">' +
  '    <span class="sl-logo"></span>' +
  "  </button>" +
  "</div>" +
  '<div class="conv-list" id="convList"></div>' +
  '<button class="fab" id="fabBtn" type="button" aria-label="新建聊天">＋</button>';

export default {
  id: "list",
  title: TITLE,

  async mount(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.disposers = [];
    this.conversations = [];
    this.membersOf = Object.create(null); // convId → 成员数组（判 kind 用）
    this.previews = Object.create(null); // convId → 最后一条消息预览
    this.activeId = null;
    // §2.5 第 6 项：stagger 只在「这个卡片实例第一次画出列表」时播一次。
    // 窄屏返回会把卡片重新 mount（单槽位），所以标志不能在 mount 里无条件重置。
    if (!this.staggerDone) this.staggerPending = true;

    const wrap = el("aside", "phone-win sidebar-left");
    wrap.id = "sidebarLeft";
    wrap.innerHTML = ASIDE_HTML;
    this.wrap = wrap;
    this.listEl = wrap.querySelector(".conv-list");

    const logoBtn = wrap.querySelector(".sl-settings");
    const fab = wrap.querySelector(".fab");

    root.appendChild(wrap);

    // ---------------------------------------------------------------- 交互
    logoBtn.addEventListener("click", () => ctx.router.push("settings"));

    // FAB：点击建私聊，长按 / 右键建群（设计稿里只有一个 ＋ 按钮，不额外加元素）
    let longPressTimer = null;
    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    fab.addEventListener("pointerdown", () => {
      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        this.newGroupChat();
      }, 550);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
      fab.addEventListener(ev, clearLongPress)
    );
    fab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      clearLongPress();
      this.newGroupChat();
    });
    fab.addEventListener("click", () => {
      if (longPressTimer) {
        clearLongPress();
        return;
      }
      this.newDirectChat();
    });

    this.listEl.addEventListener("click", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.onListClick(e);
    });
    // 设计稿没有行尾 ⋮：长按 / 右键开同一份会话菜单
    this.listEl.addEventListener("contextmenu", (e) => {
      const row = this.rowOf(e);
      if (!row) return;
      e.preventDefault();
      const conv = this.convById(row.getAttribute("data-id"));
      if (conv) this.openConvMenu(conv);
    });
    this.listEl.addEventListener("pointerdown", (e) => {
      const row = this.rowOf(e);
      if (!row) return;
      const id = row.getAttribute("data-id");
      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        this.suppressClick = true; // 长按已开菜单，别让随后的 click 又进会话
        const conv = this.convById(id);
        if (conv) this.openConvMenu(conv);
      }, 550);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
      this.listEl.addEventListener(ev, clearLongPress)
    );

    // 别的卡片改了数据会广播，列表跟着刷新
    this.disposers.push(ctx.events.on("conv:changed", () => this.reload()));
    // 用户改了主题色 → 会话头像底色跟着变，重绘一次（§2.3 resolveAvatarColor）
    this.disposers.push(ctx.events.on("settings:applied", () => this.reload()));
    this.disposers.push(ctx.events.on("conv:selected", (p) => this.setActive(p && p.convId)));
    this.disposers.push(
      ctx.events.on("data:changed", (p) => {
        if (p && p.convId && (p.removed || p.what === "conversation-removed")) {
          if (this.activeId === p.convId) this.activeId = null;
        }
        this.reload();
      })
    );
  },

  async onEnter() {
    await this.reload();
  },

  async onLeave() {},

  async unmount() {
    (this.disposers || []).forEach((fn) => fn());
    this.disposers = [];
    this.root = null;
    this.wrap = null;
    this.listEl = null;
  },

  // ================================================================ 数据
  // 读库是异步的，两次 reload 交错时后完成的那次可能读到旧数据并盖掉新 DOM。
  // 串行化：reloading 期间再来的请求合并成「跑完后再来一次」。
  async reload() {
    if (this.reloading) {
      this.reloadQueued = true;
      return this.reloadPromise;
    }
    this.reloading = true;
    this.reloadPromise = (async () => {
      try {
        do {
          this.reloadQueued = false;
          await this.reloadOnce();
        } while (this.reloadQueued);
      } finally {
        this.reloading = false;
      }
    })();
    return this.reloadPromise;
  },

  async reloadOnce() {
    const { store } = this.ctx;
    // §2.7.3：软删除的会话（removedByUser === true）不进列表。
    // 优先用活会话接口（它自带 pinned 优先 + updatedAt 倒序的排序），
    // 老 store 没有这个方法时退回 listConversations 再自己过滤。
    const convs = await (typeof store.listActiveConversations === "function"
      ? store.listActiveConversations()
      : store.listConversations().then((l) => (l || []).filter((c) => !c.removedByUser)));
    // 头像底色要跟主题色走：拿一份用户设置（§2.3 resolveAvatarColor）
    this.settings = (await store.getSettings()) || this.ctx.settings || {};
    const [memberLists, msgLists] = await Promise.all([
      Promise.all(convs.map((c) => store.listMembers(c.id))),
      Promise.all(convs.map((c) => store.listMessages(c.id))),
    ]);

    const membersOf = Object.create(null);
    const previews = Object.create(null);
    convs.forEach((c, i) => {
      membersOf[c.id] = memberLists[i] || [];
      const msgs = msgLists[i] || [];
      const last = msgs[msgs.length - 1];
      previews[c.id] = last ? String(last.content || "").replace(/\s+/g, " ").slice(0, 40) : "";
    });

    // 排序不再做第二遍：listActiveConversations 就是 listConversations 的过滤版
    // （pinned 永远在最前、其余按 updatedAt 倒序），这里照原样用
    this.conversations = convs;
    this.membersOf = membersOf;
    this.previews = previews;
    // 设计稿里始终有一行是选中的（第一页默认选中第一条）；没有活动会话时用第一条兜底
    // 第一条 = 置顶优先那条，于是「打开默认显示置顶会话」在列表上也自洽
    if (!this.activeId && this.conversations.length) this.activeId = this.conversations[0].id;
    this.render();
  },

  kindFor(conv) {
    return kindOf(conv, this.membersOf[conv.id]);
  },

  convById(id) {
    return this.conversations.filter((c) => c.id === id)[0] || null;
  },

  setActive(convId) {
    this.activeId = convId || null;
    this.updateActiveClass();
  },

  updateActiveClass() {
    if (!this.listEl) return;
    for (const node of this.listEl.children) {
      node.classList.toggle(
        "active",
        !!this.activeId && node.getAttribute("data-id") === this.activeId
      );
    }
  },

  // ================================================================ 渲染
  render() {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.innerHTML = "";
    listEl.classList.remove("anim-stagger"); // 每次重画先摘标记，只有下面首帧会重新挂

    if (!this.conversations.length) {
      listEl.appendChild(el("div", null, "还没有会话，点右下角 ＋ 新建"));
      this.staggerPending = false;
      return;
    }

    // 首次渲染才播 stagger（§2.5 第 6 项 + 硬规则 4：重绘不许重放动画）
    const stagger = !!this.staggerPending;
    this.staggerPending = false;
    this.staggerDone = true;

    this.conversations.forEach((conv, i) => {
      const row = document.createElement("div");
      row.className = "conv" + (conv.id === this.activeId ? " active" : "");
      row.setAttribute("data-id", conv.id);
      if (conv.pinned) row.setAttribute("data-pinned", "1");
      // stagger 的序号：只在首帧写，交错的 delay 由 css/motion.css 的 .anim-stagger 规则算
      if (stagger && i < STAGGER_MAX) row.style.setProperty("--i", String(i));

      const title = conv.title || "未命名";
      const time = fmtTime(conv.updatedAt || conv.createdAt);
      // 行尾那一位：照设计稿的三种可能（未读 / 小圆点 / 时间），本应用没有未读，落时间
      const badge = '<span class="c-time">' + esc(time) + "</span>";

      row.innerHTML =
        '<div class="c-ava"></div>' +
        '<div class="c-main">' +
        '<div class="c-name"><span>' +
        esc(title) +
        "</span>" +
        "</div>" +
        '<div class="c-preview">' +
        esc(this.previews[conv.id] || "（还没有消息）") +
        "</div>" +
        "</div>" +
        badge;

      // 头像内容（首字 + 底色）由统一渲染器写入；底色跟这个会话自己的主题色（§2.3）
      const st = this.settings || this.ctx.settings || {};
      const accent = this.ctx.store.resolveAccent(conv, st);
      renderAvatar(row.querySelector(".c-ava"), conv.avatar || { label: title }, { accent });

      listEl.appendChild(row);
    });

    if (stagger) listEl.classList.add("anim-stagger");
  },

  // ================================================================ 点击
  /** 事件发生在哪一行（合成事件里 target 可能为空，兜底到列表本身） */
  rowOf(e) {
    const t = (e && e.target) || (e && e.currentTarget) || this.listEl;
    return t && t.closest ? t.closest(".conv") : null;
  },

  onListClick(e) {
    const row = this.rowOf(e);
    if (!row) return;
    const conv = this.convById(row.getAttribute("data-id"));
    if (!conv) return;
    this.openConversation(conv);
  },

  openConversation(conv) {
    const { router, events } = this.ctx;
    this.setActive(conv.id);
    events.emit("conv:selected", { convId: conv.id });
    router.push(chatCardId(this.kindFor(conv)), { convId: conv.id });
  },

  async openConvMenu(conv) {
    const { router, store, events } = this.ctx;
    const isGroup = this.kindFor(conv) === "group";

    // 四种菜单项，置顶那项的文字本身就反映当前状态
    const items = [
      { key: "pin", label: conv.pinned ? "取消置顶" : "置顶" },
      { key: "rename", label: "重命名" },
      { key: "clear", label: "清空聊天记录" },
      { key: "delete", label: isGroup ? "删除群聊" : "删除会话", danger: true },
    ];
    // 群聊多成员会话里「清空聊天记录」与「删除群聊」是两件事，都保留
    const choice = await menu({ items });
    if (!choice) return;

    if (choice === "pin") {
      await store.setPinned(conv.id, !conv.pinned);
      events.emit("conv:changed", { reason: "pin", convId: conv.id });
      await this.reload();
      return;
    }

    if (choice === "rename") {
      const name = await promptDialog({ title: "重命名", value: conv.title || "" });
      if (name == null || !String(name).trim()) return;
      await store.updateConversation(conv.id, {
        title: String(name).trim(),
        updatedAt: Date.now(),
      });
      events.emit("conv:changed", { reason: "rename", convId: conv.id });
      await this.reload();
      return;
    }

    if (choice === "clear") {
      const ok = await confirmDialog({
        title: "清空聊天记录",
        message: "「" + (conv.title || "未命名") + "」的消息会全部删除，会话本身保留。",
      });
      if (!ok) return;
      const msgs = await store.listMessages(conv.id);
      await store.deleteMessages(msgs.map((m) => m.id));
      events.emit("conv:changed", { reason: "clear", convId: conv.id });
      await this.reload();
      return;
    }

    if (choice === "delete") {
      const ok = await confirmDialog({
        title: isGroup ? "删除群聊" : "删除会话",
        message: "「" + (conv.title || "未命名") + "」和它的全部消息会一起删除，无法撤销。",
        danger: true,
        okText: "删除",
      });
      if (!ok) return;
      await store.deleteConversation(conv.id);
      if (this.activeId === conv.id) {
        this.activeId = null;
        router.reset();
      }
      events.emit("conversation-removed", { convId: conv.id });
      events.emit("conv:changed", { reason: "delete", convId: conv.id, removed: true });
      await this.reload();
      return;
    }
  },

  // ================================================================ 新建
  async newDirectChat() {
    const { store, router, events } = this.ctx;
    const res = await store.createConversation("助手", null, "direct");
    const conv = res.conversation;
    events.emit("conv:changed", { reason: "create", convId: conv.id });
    await this.reload();
    this.setActive(conv.id);
    events.emit("conv:selected", { convId: conv.id });
    router.push("chat-direct", { convId: conv.id });
    events.emit("chat:focus", { convId: conv.id });
  },

  async newGroupChat() {
    const { store, router, events } = this.ctx;

    const name = await promptDialog({
      title: "新建群聊",
      placeholder: "群名，例如：周末计划",
      okText: "下一步",
    });
    if (!name || !name.trim()) return;

    const memberName = await promptDialog({
      title: "第一位成员",
      placeholder: "成员名，例如：助手",
      okText: "下一步",
    });
    if (!memberName || !memberName.trim()) return;

    const persona = await promptDialog({
      title: "成员设定",
      placeholder: "人格 / system 提示，可留空",
      okText: "创建",
    });

    const created = await store.createConversation(
      name.trim(),
      [{ name: memberName.trim(), persona: String(persona || "").trim() }],
      "group"
    );
    const conv = created.conversation;
    events.emit("conv:changed", { reason: "create", convId: conv.id });
    await this.reload();
    this.setActive(conv.id);
    events.emit("conv:selected", { convId: conv.id });
    router.push("chat-group", { convId: conv.id });
    events.emit("chat:focus", { convId: conv.id });
  },
};