// js/shell.js — 卡片壳：布局 + 卡片挂载 + ctx 注入
// 契约见 docs/cards-contract.md 第二、三节。
// 布局：r = innerWidth / innerHeight；r<1 单卡全屏，r>=1 两张等宽并排（gap 12、外边距 8）。
"use strict";

import { createEvents } from "./core/events.js";
import { createStore } from "./core/store.js";
import { createRouter } from "./core/router.js";
import { applySettings } from "./core/theme.js";
import * as api from "./core/api.js";
import { el } from "./core/util.js";

/** 卡片 id → 卡片类别（决定 CSS 前缀 .card-list / .card-chat / .card-detail / .card-settings / .card-request）。
 *  request-friend 与 request-join 共用 `kind: "request"`：两张申请页只有文案与 request.type 不同，
 *  样式同属 css/card-request.css（DEV.md §2.7.6）。 */
const CARDS = {
  list: { module: "./cards/list.js" },
  "chat-direct": { module: "./cards/chat-direct.js", kind: "chat" },
  "chat-group": { module: "./cards/chat-group.js", kind: "chat" },
  "detail-direct": { module: "./cards/detail-direct.js", kind: "detail" },
  "detail-group": { module: "./cards/detail-group.js", kind: "detail" },
  settings: { module: "./cards/settings.js" },
  "request-friend": { module: "./cards/request-friend.js", kind: "request" },
  "request-join": { module: "./cards/request-join.js", kind: "request" },
};

const GAP = 12;
const PAD = 8;
const RESIZE_THROTTLE = 100;

function cardClass(id) {
  const meta = CARDS[id] || {};
  const kind = meta.kind || id;
  return "card card-" + kind;
}

/**
 * 卡片壳。自己启动；也导出给测试用。
 * @param {object} [opts]
 * @param {HTMLElement} [opts.root] 卡片容器（默认 #cards）
 */
export function createShell(opts = {}) {
  const root = opts.root || document.getElementById("cards");
  if (!root) throw new Error("shell: 找不到卡片容器 #cards");

  const events = createEvents();
  const store = createStore();
  const router = createRouter({ events, cards: CARDS });

  /** ui/atoms.js 只在卡片真的弹出层时才 import（首屏不多付一次请求） */
  let atomsPromise = null;
  function loadAtoms() {
    if (!atomsPromise) atomsPromise = import("./ui/atoms.js");
    return atomsPromise;
  }

  /** ctx 里的 settings 是只读快照，改设置走 store.setSettings */
  const ctx = {
    store,
    api,
    router,
    events,
    settings: {},
    /** 当前栈顶会话 id（chat 卡片在 router 拿不到时的兜底） */
    __convId: null,

    /**
     * 底部动作菜单。items 同 ui/atoms.js 的 menu()。
     * 兼容卡片里 { label, onClick } 的写法：atoms.menu 只认 key 并把 key 交回，
     * 这里替它们补内部 key，选中后回调 onClick，卡片不必改。
     * @returns {Promise<any|null>} 选中项的 key；取消返回 null
     */
    openSheet(items) {
      const list = Array.isArray(items) ? items : [];
      const handlers = new Map();
      const normalized = list.map((item, i) => {
        if (item && typeof item === "object" && typeof item.onClick === "function") {
          const key = item.key != null ? item.key : "__sheet_" + i;
          handlers.set(key, item.onClick);
          return {
            key,
            label: item.label != null ? item.label : String(key),
            danger: !!item.danger,
          };
        }
        return item;
      });
      return loadAtoms()
        .then((m) => m.menu({ items: normalized }))
        .then((key) => {
          const fn = handlers.get(key);
          if (fn) {
            try {
              fn();
            } catch (e) {
              /* 回调里的错误由卡片自己报，不吞掉其它菜单项 */
            }
          }
          return key;
        });
    },

    /**
     * 单行输入框。卡片按 ctx.prompt(title, value) 这种位置参数调用。
     * @returns {Promise<string|null>} 取消返回 null
     */
    prompt(title, value, options) {
      const opts = Object.assign({}, options || {});
      if (title != null && opts.title == null) opts.title = String(title);
      if (value != null) opts.value = String(value);
      return loadAtoms().then((m) => m.promptDialog(opts));
    },

    /**
     * 确认框。ctx.confirm(text) 或 ctx.confirm({ title, message, danger })。
     * @returns {Promise<boolean>}
     */
    confirm(text, options) {
      const opts = Object.assign({}, options || {});
      if (typeof text === "string") {
        if (opts.message == null) opts.message = text;
      } else if (text && typeof text === "object") {
        Object.assign(opts, text);
      }
      return loadAtoms().then((m) => m.confirmDialog(opts));
    },
  };

  /**
   * 每个槽位挂载状态：{ id, params, instance, node }
   * @type {Array<{id:string, params:any, instance:any, node:HTMLElement}|null>}
   */
  const slots = [];

  /** @type {any[]} 模块缓存，避免重复 import */
  const moduleCache = new Map();

  let wide = null; // null = 还没算过
  let lastRound = null; // 本轮渲染的目标快照，避免重复渲染
  let resizeTimer = null;
  let toastTimer = null;
  let rendering = false; // 渲染是 async 的：同一时刻只允许一轮，其余排队
  let renderQueued = false;
  let queuedForce = false;

  // ================================================================ 布局判定
  function isWide() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    return w / h >= 1;
  }

  /** 宽屏 2 槽、窄屏 1 槽 */
  function slotCount() {
    return isWide() ? 2 : 1;
  }

  // ================================================================ 动效（规范见 docs/DEV.md §2.5）
  /** 卡片离场兜底：animationend 不一定来（reduced-motion 下时长 0.01ms、后台标签页、卡片被提前替换） */
  const EXIT_FALLBACK_MS = 400;

  /** 跑一段离场动画，结束后回调；animationend 与计时器谁先到谁算数，只跑一次。 */
  function afterExit(node, done) {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      node.removeEventListener("animationend", onEnd);
      done();
    };
    function onEnd(e) {
      if (e && e.target !== node) return;
      finish();
    }
    node.addEventListener("animationend", onEnd);
    setTimeout(finish, EXIT_FALLBACK_MS);
  }

  /** 挂入场类。类只挂一次、animationend 后摘掉（硬规则 4：重绘不许重放动画）。 */
  function playEnter(node, cls) {
    if (!node || !cls) return;
    node.classList.add(cls);
    node.addEventListener("animationend", function onEnd(e) {
      if (e && e.target !== node) return;
      node.removeEventListener("animationend", onEnd);
      node.classList.remove(cls); // 硬规则 4：动效类挂一次就摘，重绘不再重放
    });
  }

  // ================================================================ 卡片生命周期
  async function loadModule(id) {
    if (moduleCache.has(id)) return moduleCache.get(id);
    const meta = CARDS[id];
    if (!meta) throw new Error("shell: 未知卡片 '" + id + "'");
    const mod = await import(meta.module);
    const instance = mod && mod.default ? mod.default : mod;
    if (!instance || typeof instance.mount !== "function") {
      throw new Error("shell: 卡片 '" + id + "' 没有导出 mount()");
    }
    moduleCache.set(id, instance);
    return instance;
  }

  async function mountInto(slotIndex, id, params) {
    const node = el("section", cardClass(id));
    node.setAttribute("data-card", id);
    node.setAttribute("aria-label", id);
    root.appendChild(node);

    let instance;
    try {
      instance = await loadModule(id);
    } catch (err) {
      console.error("[shell] 加载卡片失败", id, err);
      node.appendChild(el("div", "card-error", "卡片加载失败：" + id));
      slots[slotIndex] = { id, params, instance: null, node };
      return;
    }

    try {
      await instance.mount(node, ctx);
      if (typeof instance.onEnter === "function") await instance.onEnter(params);
    } catch (err) {
      console.error("[shell] 卡片 mount 失败", id, err);
      node.appendChild(el("div", "card-error", "卡片初始化失败：" + id));
    }
    slots[slotIndex] = { id, params, instance, node };

    // 进场：窄屏 push 带位移，宽屏只淡入（§2.5 第 1、3 项）
    playEnter(node, isWide() ? "anim-card-fade" : "anim-card-push");
  }

  async function unmountSlot(slotIndex) {
    const cur = slots[slotIndex];
    if (!cur) return;
    // 逻辑卸载立刻生效：slots 先置空，后续渲染不会再把这张卡当成活的
    slots[slotIndex] = null;
    try {
      if (cur.instance && typeof cur.instance.onLeave === "function") await cur.instance.onLeave();
    } catch (err) {
      console.error("[shell] onLeave 失败", cur.id, err);
    }
    try {
      if (cur.instance && typeof cur.instance.unmount === "function") await cur.instance.unmount();
    } catch (err) {
      console.error("[shell] unmount 失败", cur.id, err);
    }
    const node = cur.node;
    if (!node || !node.parentNode) return;
    // 退场：animationend（或 400ms 兜底）之后才真的摘 DOM（§2.5 第 2 项）
    node.classList.add("anim-card-pop");
    afterExit(node, () => {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  /** 同一卡片、参数变了：只调 onEnter 刷新，不重新 mount */
  async function reenterSlot(slotIndex, params) {
    const cur = slots[slotIndex];
    if (!cur || !cur.instance) return;
    cur.params = params;
    if (typeof cur.instance.onEnter === "function") {
      try {
        await cur.instance.onEnter(params);
      } catch (err) {
        console.error("[shell] onEnter 失败", cur.id, err);
      }
    }
  }

  function emptyCard() {
    const node = el("section", "card card-empty");
    node.setAttribute("data-card", "empty");
    node.appendChild(el("div", "card-empty-tip", "选一个会话开始"));
    root.appendChild(node);
    return node;
  }

  // ================================================================ 渲染
  /**
   * 目标：把当前栈渲染到槽位里。
   * 宽屏：[栈底, 栈顶]；窄屏：[栈顶]。
   */
  function desiredCards() {
    const stack = router.stack;
    if (!stack.length) return [];
    if (isWide()) {
      // 宽屏只显示两层：栈底 + 栈顶
      if (stack.length === 1) return [stack[0], null]; // null = 空态卡
      return [stack[0], stack[stack.length - 1]];
    }
    return [stack[stack.length - 1]];
  }

  /**
   * 清掉 root 里不属于任何槽位、也不是空态卡 / 全局返回的节点。
   * 渲染是 async 的，两次渲染交错时会留下半成品 section，这里统一收尸，
   * 避免「同一个会话出现两张卡」「卡片顺序错位」。
   */
  function cleanupOrphans() {
    const keep = new Set();
    for (const s of slots) {
      if (s && s.node) keep.add(s.node);
    }
    for (const n of Array.from(root.children)) {
      // 正在播退场动画的卡（§2.5 第 2 项）：它已经从 slots 里摘掉了，
      // 但 DOM 要等 animationend / 400ms 兜底才删，这里必须放行。
      if (n.classList.contains("anim-card-pop")) continue;
      // 空态卡不是槽位卡（它不进 slots），这里必须放行，否则刚 append 就被收尸，
      // 结果是宽屏只有一个会话时右槽空掉、左卡被 flex 拉满整屏（实测 1032px）。
      if (n.classList.contains("card-empty")) continue;
      if (!keep.has(n)) n.remove();
    }
  }

  /**
   * 渲染是 async（要 await import / mount / onEnter），必须串行：
   * 并发一轮会各自 append 一张 section，后完成的那轮覆盖 slots，先完成的那张变成孤儿卡。
   * 这里同一时刻只跑一轮；期间来的请求合并成「收工后再跑一次」。
   */
  async function render(reason) {
    if (rendering) {
      renderQueued = true;
      if (reason === "force") queuedForce = true;
      return;
    }
    rendering = true;
    try {
      await renderOnce(reason);
      while (renderQueued) {
        renderQueued = false;
        const force = queuedForce;
        queuedForce = false;
        await renderOnce(force ? "force" : "queued");
      }
    } finally {
      rendering = false;
    }
  }

  async function renderOnce(reason) {
    const want = desiredCards();
    const fingerprint = JSON.stringify({ wide: isWide(), want });
    if (fingerprint === lastRound && reason !== "force") return;
    lastRound = fingerprint;

    // 清掉多余的槽
    for (let i = want.length; i < slots.length; i++) {
      await unmountSlot(i);
    }

    for (let i = 0; i < want.length; i++) {
      const target = want[i];
      const cur = slots[i];
      if (!target) {
        if (cur) await unmountSlot(i);
        // 空态卡单独处理（不进 slots，不算卡片）
        continue;
      }
      if (cur && cur.id === target.id) {
        // 同卡片：参数变了就 onEnter 一次
        if (JSON.stringify(cur.params) !== JSON.stringify(target.params)) {
          await reenterSlot(i, target.params);
        }
        // 重刷 class 时要把正在播的动效类留住，否则一次重绘就把入场动画抹掉
        const keepAnim = String(cur.node.className || "")
          .split(/\s+/)
          .filter((c) => c.indexOf("anim-") === 0);
        cur.node.setAttribute("data-card", target.id);
        cur.node.className = cardClass(target.id) + (keepAnim.length ? " " + keepAnim.join(" ") : "");
        continue;
      }
      if (cur) await unmountSlot(i);
      await mountInto(i, target.id, target.params);
    }

    // 空态卡：宽屏且栈只有一层时，右槽放占位
    const oldEmpty = root.querySelector(".card-empty");
    if (oldEmpty) oldEmpty.remove();
    if (isWide() && router.stack.length === 1) {
      emptyCard();
    }

    cleanupOrphans();
    syncLayoutClasses();
    syncBackButton();
  }

  /**
   * 返回键一律由卡片自带的 ‹ 承担（用户 2026-11-24 否掉了壳左上角那个白色圆钮）。
   * 壳不再渲染 .shell-back，也不再给 root 挂 has-shell-back；
   * 函数保留为空转，只为不改动 renderOnce() 的调用序列。
   */
  function syncBackButton() {
    const btn = root.querySelector(".shell-back");
    if (btn) btn.remove();
  }

  function syncLayoutClasses() {
    root.classList.toggle("cards-wide", !!isWide());
    root.classList.toggle("cards-narrow", !isWide());
    root.style.setProperty("--cards-gap", GAP + "px");
    root.style.setProperty("--cards-pad", PAD + "px");
  }

  // ================================================================ 事件接线
  /** 栈顶参数 → ctx.__convId（chat 卡片用它兜底取会话 id） */
  function syncConvId() {
    const top = router.current();
    const p = (top && top.params) || {};
    ctx.__convId = (p && (p.convId || p.id)) || null;
  }

  events.on("route", () => {
    syncConvId();
    render("route");
  });

  // 夺屏（§2.7.4）：会话可以强行把界面切到自己（或自己所在的群）
  // take_screen 工具 emit "screen:takeover" { convId, kind } → 收回栈再 push 那张聊天卡。
  // convId 缺省 = 「我自己所在的那个会话」，那种情况不发事件，所以这里直接忽略。
  const offTakeover = events.on("screen:takeover", (p) => {
    if (!p || !p.convId) return;
    router.reset();
    router.push(p.kind === "group" ? "chat-group" : "chat-direct", { convId: p.convId });
  });

  // ---------------------------------------------------------------- 数据变更广播
  // 两套命名并存：dev-c 的卡片 emit「conversations:changed」（冒号），
  // dev-b 的卡片 emit「conversations-changed / members-changed / messages-changed」（短横线）。
  // 壳把它们归一成一条 data:changed，谁改了数据都能让列表/详情自己重绘。
  function notifyDataChanged(what, payload) {
    const p = payload || {};
    events.emit("data:changed", {
      what,
      convId: p.convId || p.id || null,
      memberId: p.memberId || null,
      removed: !!p.removed,
    });
  }

  // §2.3 冻结的事件名（conv:changed / wallpaper-changed）+ 两套历史命名（冒号/短横线）全部归一
  [
    "conv:changed",
    "wallpaper-changed",
    "conversations-changed",
    "members-changed",
    "messages-changed",
    "conversations:changed",
  ].forEach((name) => {
    events.on(name, (p) => notifyDataChanged(name, p));
  });

  // 会话被删：栈里还留着它就把栈收回列表，否则会挂着一张读不到数据的卡片
  events.on("conversation-removed", (p) => {
    const convId = p && p.convId;
    notifyDataChanged("conversation-removed", p);
    if (!convId) return;
    const hit = router.stack.some((it) => {
      const params = (it && it.params) || {};
      return params.convId === convId || params.id === convId;
    });
    if (hit) router.reset();
  });

  // 设置变更：刷新 ctx 快照并广播给卡片
  events.on("settings:changed", (patch) => {
    ctx.settings = Object.assign({}, ctx.settings, patch || {});
  });

  // 外观：settings 卡片发出的完整设置重播到 body
  events.on("settings:applied", (settings) => {
    ctx.settings = Object.assign({}, settings || {});
    applySettings(ctx.settings);
  });

  // 轻提示（任何卡片都可以 emit("toast", {text})）
  events.on("toast", (p) => {
    const text = p && p.text ? String(p.text) : "";
    if (!text) return;
    let node = document.getElementById("toast");
    if (!node) {
      node = el("div", "toast");
      node.id = "toast";
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.classList.remove("show");
    }, 1800);
  });

  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      resizeTimer = null;
      const nowWide = isWide();
      if (nowWide !== wide) {
        wide = nowWide;
        // 切到宽屏时把栈裁到 2 层（list 固定在底）
        if (nowWide && router.depth() > 2) {
          router.clamp(2);
        }
      }
      await render("resize");
    }, RESIZE_THROTTLE);
  }

  // ================================================================ 原生壳（Capacitor App）
  // 网页里没有 window.Capacitor：下面整段空转（不加 class、不注册返回键）。
  // 不用 import "@capacitor/app"：没有打包器，裸包名浏览器解析不了，只能取运行时全局。
  const NATIVE_CLASS = "is-native"; // CSS 钩子，样式归 css/，本文件不写样式
  const EXIT_WINDOW_MS = 2000; // 双击退出的时间窗

  let nativeBackHandle = null; // addListener("backButton") 的 handle
  let nativeBackGone = false; // destroy 早于 handle 落地时，落地后立刻退订
  let nativeSetupDone = false; // start() 只接一次，重复 start 不重复注册
  let lastBackAt = 0; // 上一次在列表页按返回的时间戳

  /** Capacitor 桥只在 App 里注入；网页里 window.Capacitor 是 undefined，用 try/catch 兜住 */
  function isNative() {
    try {
      const cap = window.Capacitor;
      return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
    } catch (e) {
      return false;
    }
  }

  /** 运行时全局里的原生 App 插件；没有就是网页 */
  function nativeApp() {
    try {
      return window.Capacitor?.Plugins?.App || null;
    } catch (e) {
      return null;
    }
  }

  /** body 上的 is-native：加与摘都幂等，重复调用不报错 */
  function setNativeClass(on) {
    try {
      const body = document.body;
      if (!body || !body.classList) return;
      if (on) body.classList.add(NATIVE_CLASS);
      else body.classList.remove(NATIVE_CLASS);
    } catch (e) {
      /* classList 出问题也不能挡住启动 */
    }
  }

  /**
   * 关最上层弹层。
   * atoms 的 openOverlay 在 document 上接 Escape；详情卡自建的 .modal-mask 只接了「点遮罩」。
   * 点遮罩（e.target === mask）两边都通，而且一次只关一层，所以走这条。
   * @returns {boolean} 有没有弹层（遮罩/菜单/确认框）
   */
  function closeTopOverlay() {
    const masks = document.querySelectorAll(".modal-mask");
    if (!masks || !masks.length) return false;
    const mask = masks[masks.length - 1]; // 后挂上的在最上面
    if (typeof mask.click === "function") {
      mask.click(); // close() 自己幂等：正在退场的再点一次也没事
      return true;
    }
    // 兜底：atoms 在 document 上接 keydown Escape
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (e) {
      /* 没有 KeyboardEvent 构造器就放弃，别把返回键卡死 */
    }
    return true;
  }

  /** 安卓返回键：① 弹层 → ② 栈内返回 → ③ 列表页双击退出 */
  function onNativeBack() {
    if (closeTopOverlay()) return;
    if (router.depth() > 1) {
      router.back();
      return;
    }
    // 已经在列表页：2 秒内第二按才真退，超时重新计时
    const now = Date.now();
    if (lastBackAt && now - lastBackAt <= EXIT_WINDOW_MS) {
      lastBackAt = 0;
      try {
        const app = nativeApp();
        const p = app && typeof app.exitApp === "function" ? app.exitApp() : null;
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (e) {
        /* 退不掉也别抛，否则下一次返回键没人接 */
      }
      return;
    }
    lastBackAt = now;
    events.emit("toast", { text: "再按一次退出" });
  }

  /** 退订返回键；重复调用不报错 */
  function removeNativeBack() {
    nativeBackGone = true;
    const handle = nativeBackHandle;
    nativeBackHandle = null;
    if (!handle || typeof handle.remove !== "function") return;
    try {
      const p = handle.remove();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* 已经退订过 */
    }
  }

  /** 只在原生壳里接返回键；网页里直接返回，什么都不做 */
  function setupNative() {
    if (nativeSetupDone) return;
    if (!isNative()) return;
    nativeSetupDone = true;
    setNativeClass(true);
    const app = nativeApp();
    if (!app || typeof app.addListener !== "function") return;
    try {
      const ret = app.addListener("backButton", onNativeBack);
      // Capacitor 4+ 返回 Promise<PluginListenerHandle>，更老的直接返回 handle
      if (ret && typeof ret.then === "function") {
        ret
          .then((handle) => {
            nativeBackHandle = handle || null;
            if (nativeBackGone) removeNativeBack(); // destroy 先到了
          })
          .catch(() => {});
      } else {
        nativeBackHandle = ret || null;
      }
    } catch (e) {
      console.warn("[shell] 返回键注册失败", e);
    }
  }

  // ================================================================ 启动
  async function start() {
    wide = isWide();
    syncLayoutClasses();
    setupNative(); // 原生壳：body 打 is-native + 接安卓返回键（网页里空转）

    // 首屏：.cards 整体淡入，防白闪（§2.5 第 4 项）。类只挂一次，start() 之后不再重放。
    playEnter(root, "anim-cards-in");

    const { settings } = await store.ready();
    ctx.settings = settings || {};
    applySettings(ctx.settings); // 首屏就把皮肤/壁纸/亮度铺到 body

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    // 首屏：栈底固定 list
    syncConvId();
    await render("force");

    // 预热 atoms（弹层与头像都在里面）：首次点菜单/改名时不会再等一次动态 import
    loadAtoms().catch(() => {});
  }

  return {
    ctx,
    events,
    store,
    router,
    start,
    render,
    isWide,
    destroy() {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (toastTimer) clearTimeout(toastTimer);
      // 夺屏监听（§2.7.4）必须跟着退订，否则壳销毁后事件还会把路由推回去
      if (typeof offTakeover === "function") offTakeover();
      // 原生：退订返回键、摘掉 is-native（重复 destroy 不报错）
      removeNativeBack();
      setNativeClass(false);
      lastBackAt = 0;
    },
  };
}

// ---------------------------------------------------------------- 自启动
// index.html 直接 <script type="module" src="js/shell.js">，所以这里启动一次。
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
if (isBrowser && document.getElementById("cards")) {
  const boot = async () => {
    try {
      const shell = createShell();
      window.__meruchatShell = shell; // 方便浏览器里手工验证
      await shell.start();
    } catch (err) {
      console.error("[shell] 启动失败", err);
      const box = document.getElementById("cards");
      if (box) {
        const node = document.createElement("div");
        node.className = "card-error";
        node.textContent = "启动失败：" + (err && err.message ? err.message : err);
        box.appendChild(node);
      }
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

export default createShell;
