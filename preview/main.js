// preview/main.js — 预览壳入口（六帧总览，唯一文件，2026-11-25）
//
// 职责只有三件：
//   1. 造一份 ctx（store / api / events / router / openSheet / prompt / confirm），六帧共用；
//   2. 把六个卡片分别挂进 preview/index.html 里已有的六个槽位，单帧失败只影响自己；
//   3. 维护顶栏 `#pv-status` 与 `#pv-reset`。
//
// 这里**不实现任何业务逻辑**，也不许改用户数据：会话/消息只读。
// 唯一允许的写入是 ensureDemoData() 种的那份演示群聊（库里已经有群聊就一个字节都不动），
// 目的是让 chat-group / detail-group 两帧不至于空着；`#pv-reset` 只重建这条演示群聊再重挂六帧。
// 六帧必须共用同一个 store 实例（createStore() 每次调用都会各自开一个 IDB 连接）。
"use strict";

import { createStore } from "../js/core/store.js";
import { createEvents } from "../js/core/events.js";
import { applySettings } from "../js/core/theme.js";
import * as api from "../js/core/api.js";

import listCard from "../js/cards/list.js";
import chatDirectCard from "../js/cards/chat-direct.js";
import chatGroupCard from "../js/cards/chat-group.js";
import detailDirectCard from "../js/cards/detail-direct.js";
import detailGroupCard from "../js/cards/detail-group.js";
import settingsCard from "../js/cards/settings.js";

/** 槽位映射（写死；槽位由 preview/index.html 提供，本文件不创建任何骨架） */
const FRAMES = {
  list: "#pv-slot-list",
  "chat-direct": "#pv-slot-chat-direct",
  "chat-group": "#pv-slot-chat-group",
  "detail-direct": "#pv-slot-detail-direct",
  "detail-group": "#pv-slot-detail-group",
  settings: "#pv-slot-settings",
};

const FRAME_IDS = ["list", "chat-direct", "chat-group", "detail-direct", "detail-group", "settings"];

const CARDS = {
  list: listCard,
  "chat-direct": chatDirectCard,
  "chat-group": chatGroupCard,
  "detail-direct": detailDirectCard,
  "detail-group": detailGroupCard,
  settings: settingsCard,
};

/** 路由栈只做记录（最多保留最近 20 次），卡片只读 current()/depth() */
const STACK_MAX = 20;
/** 状态栏防抖 */
const STATUS_DEBOUNCE_MS = 200;
/** 状态栏统计的消息范围：前 20 个会话 */
const STATUS_CONV_LIMIT = 20;

// ================================================================ atoms 惰性加载
let atomsPromise = null;
/** import 失败后不缓存坏 Promise，下次点击还能重试 */
function loadAtoms() {
  if (!atomsPromise) {
    atomsPromise = import("../js/ui/atoms.js").catch((err) => {
      atomsPromise = null;
      throw err;
    });
  }
  return atomsPromise;
}

// ================================================================ 启动骨架
const store = createStore();
const events = createEvents();

/** 六帧共用的 ctx；settings 由 settings:applied 就地替换 */
const ctx = {
  store,
  api,
  events,
  settings: {},
  router: null,
  openSheet(items) {
    return loadAtoms().then((m) => {
      const list = Array.isArray(items) ? items : [];
      const handlers = [];
      const normalized = list.map((it, i) => {
        const key = "__sheet_" + i;
        if (typeof it === "string") {
          handlers.push(null);
          return { key: key, label: it };
        }
        const src = it || {};
        handlers.push(typeof src.onClick === "function" ? src.onClick : null);
        return {
          key: key,
          label: src.label != null ? String(src.label) : src.text != null ? String(src.text) : "",
          danger: !!src.danger,
        };
      });
      return Promise.resolve(m.menu({ items: normalized })).then((picked) => {
        if (picked == null) return null;
        let idx = -1;
        normalized.forEach((n, i) => {
          if (n.key === picked) idx = i;
        });
        const fn = idx >= 0 ? handlers[idx] : null;
        if (fn) {
          try {
            fn(picked);
          } catch (err) {
            console.error("[preview] openSheet 回调失败", err);
          }
        }
        return picked;
      });
    });
  },
  prompt(title, value, opts) {
    return loadAtoms().then((m) => {
      const base = opts && typeof opts === "object" ? Object.assign({}, opts) : {};
      base.title = String(title == null ? "" : title);
      base.value = String(value == null ? "" : value);
      return m.promptDialog(base);
    });
  },
  confirm(text, opts) {
    return loadAtoms().then((m) => {
      let base;
      if (text != null && typeof text === "object") base = Object.assign({}, text);
      else base = { message: String(text == null ? "" : text) };
      if (opts && typeof opts === "object") Object.assign(base, opts);
      return m.confirmDialog(base);
    });
  },
};

// ================================================================ 帧管理
/** id → { id, slotEl, instance } */
const frames = Object.create(null);
/** 最近一次成功挂载的帧，未知 id 的 push 就重挂它 */
let lastFrame = null;

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showError(slot, id) {
  if (!slot) return;
  clearNode(slot);
  const box = document.createElement("div");
  box.className = "card-error";
  box.textContent = "卡片加载失败：" + id;
  slot.appendChild(box);
}

/**
 * onLeave / unmount 任一抛错都不许连累其它帧；返回 Promise 等它们真正结束。
 * 卡片的 unmount 是 async 的（内部 await 之后才把模块级 ctx / rootEl 置 null），
 * 不等它就挂新实例，旧的 unmount 会在新 mount 之后把单例 ctx 又清成 null。
 */
function safeUnmount(frame) {
  if (!frame || !frame.instance) return Promise.resolve();
  const inst = frame.instance;
  frame.instance = null;

  let p = Promise.resolve();
  if (typeof inst.onLeave === "function") {
    p = p
      .then(() => inst.onLeave())
      .catch((err) => {
        console.warn("[preview] 卡片 onLeave 失败", frame.id, err);
      });
  }
  if (typeof inst.unmount === "function") {
    p = p
      .then(() => inst.unmount())
      .catch((err) => {
        console.warn("[preview] 卡片 unmount 失败", frame.id, err);
      });
  }
  return p;
}

/**
 * 每帧一把串行锁：卡片是模块级单例（ctx / rootEl / mounted 都在模块作用域里），
 * 同一帧被并发重挂时，后一次的 unmount() 会把单例 ctx 置 null，前一次还卡在 await 里的
 * mount/onEnter 回来就 `Cannot read properties of null (reading 'store')`。
 * 锁只保证同一帧的挂载序列排队，跨帧仍然并行（六帧首屏本来就要一起出来）。
 * key = 帧 id；存的是「已吞掉错误」的尾巴，保证一次失败不会卡死后续挂载。
 */
const frameChain = new Map();

function withFrameLock(id, fn) {
  const prev = frameChain.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  frameChain.set(
    id,
    next.catch(() => {})
  );
  return next;
}

/**
 * 每帧一个 router 视图：push/back/reset 仍打到共享帧路由，只有 current() 返回**这一帧自己的**参数。
 * 卡片全靠 `router.current().params` 与 `ctx.__convId` 认会话，六帧共用一个 router 会让四张会话卡
 * 都拿不到 convId（实测会渲染成「会话不存在」）。
 */
function routerViewFor(id, params) {
  const own = { id: id, params: params || {} };
  return {
    get stack() {
      return stack;
    },
    push(childId, childParams) {
      return frameRouter.push(childId, childParams);
    },
    back() {
      return frameRouter.back();
    },
    reset() {
      return frameRouter.reset();
    },
    current() {
      return own;
    },
    depth() {
      return stack.length || 1;
    },
  };
}

/** 帧级 ctx：原型链挂共享 ctx（settings 改动即时可见），只覆盖 __convId 与 router */
function ctxForFrame(id, params) {
  const view = Object.create(ctx);
  view.__convId = (params && (params.convId || params.id)) || null;
  view.router = routerViewFor(id, params);
  return view;
}

/**
 * 把某一张卡重新挂进它的槽（先卸旧的）。
 * 只影响这一帧：mount/onEnter（含 await 抛出的 rejection）就在该槽放 .card-error，其它帧照常。
 * 整段工作在 withFrameLock 里排队：返回的 Promise 要等 unmount → mount → onEnter 全部结束才 resolve。
 */
async function mountFrame(id, params) {
  return withFrameLock(id, async () => {
    const sel = FRAMES[id];
    const slot = sel ? document.querySelector(sel) : null;
    if (!slot) {
      console.warn("[preview] 找不到槽位", id, sel);
      return false;
    }
    let frame = frames[id];
    if (!frame) {
      frame = { id: id, slotEl: slot, instance: null };
      frames[id] = frame;
    }
    frame.slotEl = slot;

    const card = CARDS[id];

    try {
      // 先等旧实例卸干净：卡片的 unmount 是 async 的，它内部 await 完才把模块级 ctx 置 null
      await safeUnmount(frame);
      clearNode(slot);
      if (!card || typeof card.mount !== "function") {
        console.error("[preview] 卡片模块不可用", id);
        showError(slot, id);
        return false;
      }
      // 这一帧的目标 id 必须先落到 ctx 上：chat-* 的 mount() 用 readConvId(ctx) 取 id，
      // 拿不到就只画一句「会话不存在」并 return，之后 onEnter 再怎么调也补不出壳子。
      ctx.__convId = (params && (params.convId || params.id)) || null;
      const view = ctxForFrame(id, params);
      await card.mount(slot, view);
      frame.instance = card;
      if (typeof card.onEnter === "function") await card.onEnter(params || {});
      return true;
    } catch (err) {
      console.error("[preview] 卡片加载失败", id, err);
      frame.instance = null;
      showError(slot, id);
      return false;
    }
  });
}

function remountById(id, params) {
  return mountFrame(id, params).then((ok) => {
    if (ok) lastFrame = { id: id, params: params || {} };
    return ok;
  });
}

// ================================================================ router（六帧共享替身）
const stack = [];

const frameRouter = {
  get stack() {
    return stack;
  },
  push(id, params) {
    const p = params || {};
    // 同一帧同参数连续 push（比如一次点击里连发两枪）：不重挂，只重播一次路由事件。
    // 重挂会走 unmount，而卡片是模块级单例，白白多一次 ctx 置 null 的窗口。
    if (lastFrame && lastFrame.id === id && JSON.stringify(lastFrame.params) === JSON.stringify(p)) {
      events.emit("route", { id: id, params: p });
      return Promise.resolve(null);
    }
    stack.push({ id: id, params: p });
    if (stack.length > STACK_MAX) stack.splice(0, stack.length - STACK_MAX);
    const known = Object.prototype.hasOwnProperty.call(FRAMES, id);
    const target = known ? { id: id, params: p } : lastFrame;
    const run = target ? remountById(target.id, target.params) : Promise.resolve(false);
    return run.then(() => {
      events.emit("route", { id: id, params: p });
      return null;
    });
  },
  back() {
    // 预览是六帧并列，没有返回栈：不切任何帧，只提示一句
    events.emit("toast", { text: "预览里没有返回栈" });
    return Promise.resolve(false);
  },
  reset() {
    return mountAll().then(() => {
      events.emit("route", { id: "reset", params: {} });
      return true;
    });
  },
  current() {
    if (!stack.length) return null;
    return stack[stack.length - 1];
  },
  depth() {
    return stack.length;
  },
};

ctx.router = frameRouter;

// ================================================================ 初始参数
/** 取第一个私聊与第一个群聊的 id；读失败就都留空（卡片自己会落空态） */
function pickConvIds() {
  const ids = { direct: null, group: null };
  return Promise.resolve(store.listConversations())
    .then((convs) => {
      const list = Array.isArray(convs) ? convs : [];
      list.forEach((c) => {
        if (!c || !c.id) return;
        if (c.kind === "group") {
          if (!ids.group) ids.group = c.id;
        } else if (!ids.direct) {
          ids.direct = c.id;
        }
      });
      return ids;
    })
    .catch((err) => {
      console.warn("[preview] 读会话失败，四张会话卡传空参", err);
      return ids;
    });
}

function paramsFor(ids) {
  return {
    list: {},
    settings: {},
    "chat-direct": ids.direct ? { convId: ids.direct } : {},
    "detail-direct": ids.direct ? { convId: ids.direct } : {},
    "chat-group": ids.group ? { convId: ids.group } : {},
    "detail-group": ids.group ? { convId: ids.group } : {},
  };
}

function mountAll() {
  return pickConvIds().then((ids) => {
    const params = paramsFor(ids);
    return Promise.all(
      FRAME_IDS.map((id) => mountFrame(id, params[id]).then((ok) => (ok ? id : null)))
    ).then(() => undefined);
  });
}

// ================================================================ 演示数据
/** 演示群聊的身份标记：只有 title 与 kind 同时命中才算「我们种的那条」，别的一概不碰 */
const DEMO_GROUP_TITLE = "设计三人组";
const DEMO_GROUP_KIND = "group";
const DEMO_MEMBERS = [
  { name: "小满", persona: "你负责视觉与文案，说话简短。" },
  { name: "阿奇", persona: "你负责工程实现，爱较真。" },
  { name: "林森", persona: "你负责产品判断。" },
];
/** 四条开场消息；member 是成员名，落库前换成 member.id（取不到就省掉 memberId） */
const DEMO_MESSAGES = [
  { role: "user", content: "三个方向都看一下：极简、气泡、卡片式，你们各自说一句。" },
  { role: "assistant", member: "小满", content: "极简更稳，信息密度高也不吵。" },
  { role: "assistant", member: "阿奇", content: "气泡式实现最省事，样式我们已经有现成的。" },
  { role: "assistant", member: "林森", content: "先出极简，另外两个留作备选。" },
];

/**
 * 首屏缺群聊时种一份最小的演示数据（只有这一处会写库）。
 * 规则：库里已有任何群聊就直接返回，一条字节都不改；创建只发生一次，失败只 warn，不挡六帧挂载。
 * @returns {Promise<boolean>} 真的种下去了才 true
 */
function ensureDemoData() {
  return Promise.resolve()
    .then(() => store.listConversations())
    .then((convs) => {
      const list = Array.isArray(convs) ? convs : [];
      if (list.some((c) => c && c.kind === DEMO_GROUP_KIND)) return false;
      return Promise.resolve(
        store.createConversation({
          kind: DEMO_GROUP_KIND,
          title: DEMO_GROUP_TITLE,
          members: DEMO_MEMBERS.map((m) => Object.assign({}, m)),
        })
      ).then((made) => {
        const conversation = (made && made.conversation) || null;
        const members = (made && made.members) || [];
        const convId = conversation && conversation.id;
        if (!convId) return false;
        const idOf = (name) => {
          const hit = members.find((m) => m && m.name === name);
          return hit && hit.id ? hit.id : null;
        };
        // addMessage 自己补 id/ts/seq，这里只给业务字段，按顺序写
        return DEMO_MESSAGES.reduce(
          (p, row) =>
            p.then(() => {
              const msg = { convId: convId, role: row.role, content: row.content };
              if (row.member) {
                const mid = idOf(row.member);
                if (mid) msg.memberId = mid;
              }
              return Promise.resolve(store.addMessage(msg)).then(() => undefined);
            }),
          Promise.resolve()
        ).then(() => true);
      });
    })
    .catch((err) => {
      console.warn("[preview] 种演示数据失败，群聊帧留空态", err);
      return false;
    });
}

/**
 * 重置演示数据：只删「设计三人组 + kind=group」这一条，再种回来，最后重挂六帧。
 * 私聊、设置、备忘一律不碰。注意 store.deleteConversation 在「全库没有置顶」时会把最新一条置顶，
 * 那是 store 自己的行为：删完把除演示群聊外的置顶状态还原回去。
 */
function resetDemoData() {
  let pinnedBefore = new Map();
  return Promise.resolve()
    .then(() => store.listConversations())
    .then((convs) => {
      const list = Array.isArray(convs) ? convs : [];
      pinnedBefore = new Map(list.map((c) => [c && c.id, !!(c && c.pinned)]));
      const doomed = list.filter((c) => c && c.kind === DEMO_GROUP_KIND && c.title === DEMO_GROUP_TITLE);
      return doomed.reduce(
        (p, c) => p.then(() => Promise.resolve(store.deleteConversation(c.id)).then(() => undefined)),
        Promise.resolve()
      );
    })
    .catch((err) => {
      console.warn("[preview] 删演示群聊失败，继续重建", err);
    })
    .then(() => ensureDemoData())
    .then(() =>
      Promise.resolve(store.listConversations())
        .then((convs) => {
          const list = Array.isArray(convs) ? convs : [];
          return list.reduce(
            (p, c) =>
              p.then(() => {
                if (!c || !pinnedBefore.has(c.id)) return undefined;
                const was = pinnedBefore.get(c.id);
                if (!!c.pinned === was || typeof store.setPinned !== "function") return undefined;
                return Promise.resolve(store.setPinned(c.id, was)).then(() => undefined);
              }),
            Promise.resolve()
          );
        })
        .catch(() => undefined)
    )
    .then(() => mountAll());
}

// ================================================================ 顶栏状态栏
let statusTimer = null;

function scheduleStatus() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    refreshStatus();
  }, STATUS_DEBOUNCE_MS);
}

function countMessages(convs) {
  const list = Array.isArray(convs) ? convs.slice(0, STATUS_CONV_LIMIT) : [];
  return Promise.all(
    list.map((c) =>
      Promise.resolve(c && c.id ? store.listMessages(c.id) : [])
        .then((msgs) => (Array.isArray(msgs) ? msgs.length : 0))
        .catch(() => 0)
    )
  ).then((counts) => counts.reduce((a, b) => a + b, 0));
}

function refreshStatus() {
  const el = document.querySelector("#pv-status");
  if (!el) return Promise.resolve();
  return Promise.resolve(store.listConversations())
    .then((convs) => {
      const list = Array.isArray(convs) ? convs : [];
      return countMessages(list).then((m) => {
        el.textContent = "会话 " + list.length + " · 消息 " + m;
      });
    })
    .catch((err) => {
      console.warn("[preview] 状态读取失败", err);
      el.textContent = "状态读取失败";
    });
}

// ================================================================ 事件
/** preview/index.html 没有 toast 容器，而 back()/重置都要给一句反馈：这里补一个最小 toast */
const TOAST_MS = 1600;
let toastEl = null;
let toastTimer = null;

function showToast(text) {
  const msg = String(text == null ? "" : text);
  if (!msg) return;
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if (toastEl) toastEl.classList.remove("show");
  }, TOAST_MS);
}

const disposers = [];
function on(name, fn) {
  const off = events.on(name, fn);
  if (typeof off === "function") disposers.push(off);
}

on("toast", (p) => showToast(p && (p.text || p.message)));
on("data:changed", () => scheduleStatus());
on("conv:changed", () => scheduleStatus());
on("route", () => scheduleStatus());
on("settings:applied", (s) => {
  if (s && typeof s === "object") ctx.settings = Object.assign({}, s);
  try {
    applySettings(ctx.settings);
  } catch (err) {
    console.warn("[preview] applySettings 失败", err);
  }
  scheduleStatus();
});

// ================================================================ 按钮
function bindReset() {
  const btn = document.querySelector("#pv-reset");
  if (!btn) {
    console.warn("[preview] 找不到 #pv-reset");
    return;
  }
  btn.addEventListener("click", () => {
    Promise.resolve(ctx.confirm("重置演示数据？（会重建演示群聊，你自己的私聊不动）"))
      .then((ok) => {
        if (!ok) return null;
        return resetDemoData().then(() => {
          events.emit("toast", { text: "已重置演示数据" });
          return refreshStatus();
        });
      })
      .catch((err) => console.error("[preview] 重置演示数据失败", err));
  });
}

// ================================================================ boot
let booted = false;

function boot() {
  if (booted) return Promise.resolve();
  booted = true;

  window.__meruchatPreview = { store: store, events: events, frames: frames, ctx: ctx };

  const ready = typeof store.ready === "function" ? store.ready() : Promise.resolve({ settings: {} });
  return Promise.resolve(ready)
    .catch((err) => {
      console.error("[preview] store.ready() 失败，六帧按空设置启动", err);
      return { settings: {} };
    })
    .then((res) => {
      const settings = (res && res.settings) || {};
      ctx.settings = Object.assign({}, settings);
      try {
        applySettings(ctx.settings);
      } catch (err) {
        console.warn("[preview] applySettings 失败", err);
      }
      bindReset();
      // 先保证有群聊可预览，再挂六帧（种数据失败也照挂，群聊帧自己落空态）
      return ensureDemoData().then(() => mountAll());
    })
    .then(() => refreshStatus())
    .catch((err) => {
      console.error("[preview] 启动失败", err);
      const el = document.querySelector("#pv-status");
      if (el) el.textContent = "状态读取失败";
    });
}

boot();

export { store, events, frames, ctx, frameRouter };
