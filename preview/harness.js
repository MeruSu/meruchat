// preview/harness.js — 单卡预览外壳
// 用法：/preview/?card=list          单卡
//       /preview/?card=chat-group&scenario=empty
//       /preview/all                 六张卡同时挂载（竖向排列，看整体一致性）
// 每张卡都跑在内存假数据上，不碰 IndexedDB、不联网、不依赖其它卡片。
"use strict";

import { createEvents } from "../js/core/events.js";
import { buildFixture, createMockStore, streamChat } from "./mock.js";
import { applySettings } from "../js/core/theme.js";

const CARDS = [
  { id: "list", label: "会话列表" },
  { id: "chat-direct", label: "私聊会话" },
  { id: "chat-group", label: "群聊会话" },
  { id: "detail-direct", label: "私聊详情" },
  { id: "detail-group", label: "群聊详情" },
  { id: "settings", label: "全局设置" },
];

const MODULE = {
  list: "../js/cards/list.js",
  "chat-direct": "../js/cards/chat-direct.js",
  "chat-group": "../js/cards/chat-group.js",
  "detail-direct": "../js/cards/detail-direct.js",
  "detail-group": "../js/cards/detail-group.js",
  settings: "../js/cards/settings.js",
};

const KIND = {
  list: "list",
  settings: "settings",
  "chat-direct": "chat",
  "chat-group": "chat",
  "detail-direct": "detail",
  "detail-group": "detail",
};

const PARAMS = {
  "chat-direct": { convId: "conv-direct" },
  "chat-group": { convId: "conv-group" },
  "detail-direct": { convId: "conv-direct" },
  "detail-group": { convId: "conv-group" },
};

const bar = document.getElementById("pv-bar");
const stage = document.getElementById("pv-stage");
const qs = new URLSearchParams(location.search);
const which = qs.get("card") || "list";
const scenario = qs.get("scenario") || "default";
const showAll = qs.get("all") != null || /\/all(\.html)?$/.test(location.pathname) || location.pathname.indexOf("/preview/all") >= 0;

function renderBar(current) {
  const links = CARDS.map(
    (c) =>
      `<a href="?card=${c.id}${scenario === "empty" ? "&scenario=empty" : ""}" class="${
        c.id === current ? "on" : ""
      }">${c.label}</a>`,
  ).join("");
  bar.innerHTML =
    links +
    '<span class="sep"></span>' +
    `<a href="?card=${current}&scenario=empty" class="${scenario === "empty" ? "on" : ""}">空态</a>` +
    `<a href="?card=${current}">有数据</a>` +
    '<span class="sep"></span>' +
    '<a href="all">六卡整排</a>' +
    '<span class="sep"></span>' +
    '<a href="../index.html">整合版（真数据）</a>';
}

function fail(where, err) {
  const box = document.createElement("div");
  box.id = "pv-err";
  box.textContent = "[" + where + "] " + (err && err.stack ? err.stack : String(err));
  stage.appendChild(box);
  console.error(where, err);
}

function makeCtx(store, events) {
  const router = {
    stack: [{ id: "list", params: {} }],
    push(id, params) {
      this.stack.push({ id, params: params || {} });
      events.emit("route", { stack: this.stack.slice() });
    },
    back() {
      if (this.stack.length > 1) this.stack.pop();
      events.emit("route", { stack: this.stack.slice() });
    },
    replace(id, params) {
      this.stack[this.stack.length - 1] = { id, params: params || {} };
      events.emit("route", { stack: this.stack.slice() });
    },
    reset(id, params) {
      this.stack = [{ id: id || "list", params: params || {} }];
      events.emit("route", { stack: this.stack.slice() });
    },
    current() {
      return this.stack[this.stack.length - 1];
    },
  };

  return {
    store,
    api: { streamChat },
    router,
    events,
    settings: {},
    __convId: null,
    openSheet(items) {
      return import("../js/ui/atoms.js").then((m) => m.menu({ items }));
    },
    prompt(t, v, o) {
      return import("../js/ui/atoms.js").then((m) =>
        m.promptDialog(Object.assign({ title: t != null ? String(t) : "", value: v }, o || {})),
      );
    },
    confirm(t, o) {
      const opts = Object.assign({}, o || {});
      if (typeof t === "string") opts.message = t;
      else if (t && typeof t === "object") Object.assign(opts, t);
      return import("../js/ui/atoms.js").then((m) => m.confirmDialog(opts));
    },
  };
}

async function mountCard(id, host) {
  const events = createEvents();
  const store = createMockStore(buildFixture(scenario), events);
  const ctx = makeCtx(store, events);
  const settings = await store.getSettings();
  ctx.settings = settings;
  applySettings(settings);
  // 与 js/shell.js:409/414 对齐：卡片改设置后要重播到 body，否则预览页看不到换肤/换背景
  events.on("settings:changed", (patch) => {
    ctx.settings = Object.assign({}, ctx.settings, patch || {});
  });
  events.on("settings:applied", (next) => {
    ctx.settings = Object.assign({}, next || {});
    applySettings(ctx.settings);
  });
  ctx.__convId = (PARAMS[id] && PARAMS[id].convId) || null;
  if (PARAMS[id]) ctx.router.stack.push({ id, params: PARAMS[id] });

  const mod = await import(MODULE[id]);
  const card = mod && mod.default ? mod.default : mod;
  if (!card || typeof card.mount !== "function") throw new Error(id + " 没有导出 mount()");

  const shell = document.createElement("div");
  shell.className = "card card-" + (KIND[id] || id);
  shell.style.minHeight = "0";
  host.appendChild(shell);

  await card.mount(shell, ctx);
  if (typeof card.onEnter === "function") await card.onEnter(PARAMS[id] || {});
  return { card, shell, ctx, store };
}

async function boot() {
  if (showAll) {
    renderBar(null);
    stage.classList.add("pv-all");
    for (const c of CARDS) {
      const col = document.createElement("div");
      col.className = "pv-col";
      const tag = document.createElement("div");
      tag.className = "pv-tag";
      tag.textContent = c.label;
      col.appendChild(tag);
      const frame = document.createElement("div");
      frame.className = "pv-frame";
      col.appendChild(frame);
      stage.appendChild(col);
      try {
        await mountCard(c.id, frame);
      } catch (e) {
        fail(c.label, e);
      }
    }
    return;
  }

  renderBar(which);
  const frame = document.createElement("div");
  frame.className = "pv-frame";
  stage.appendChild(frame);
  try {
    await mountCard(which, frame);
  } catch (e) {
    fail(which, e);
  }
}

boot();
