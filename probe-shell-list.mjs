// probe-shell-list.mjs — dev-a 单元探针：router / events / theme / list 卡片
// 自写内存 IndexedDB + 迷你 DOM（沙箱里不能 npm i，也不装 fake-indexeddb）。
// 跑法：node probe-shell-list.mjs（从 webapp 目录）
"use strict";

import assert from "node:assert/strict";

// ================================================================ 迷你 DOM
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.classList = makeClassList();
    this.style = makeStyle();
    this.attributes = Object.create(null);
    // atoms.avatar 会写 dataset.ava / dataset.avGrad；真 DOM 上 dataset 就是 data-*
    this.dataset = Object.create(null);
    this.listeners = Object.create(null);
    this._text = "";
    this.hidden = false;
    this.value = "";
    this.title = "";
    this.type = "";
    this.disabled = false;
  }
  get className() {
    return this.classList.toString();
  }
  set className(v) {
    this.classList = makeClassList(v);
  }
  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = v == null ? "" : String(v);
  }
  /** 卡片用 innerHTML 拼静态骨架（照抄设计稿），探针里给一个够用的极简解析器 */
  get innerHTML() {
    return this.childNodes.map(serializeNode).join("");
  }
  set innerHTML(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this._text = "";
    for (const node of parseFragment(String(v == null ? "" : v))) this.appendChild(node);
  }
  get outerHTML() {
    return serializeNode(this);
  }
  get children() {
    return this.childNodes.filter((n) => n.tagName !== "#text");
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document.body || n === globalThis.document.documentElement;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n));
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "id") this.id = String(v);
    if (k === "role") this.role = String(v);
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  addEventListener(name, fn) {
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
  }
  removeEventListener(name, fn) {
    const arr = this.listeners[name];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(name, event) {
    const arr = this.listeners[name] || [];
    const ev = Object.assign(
      {
        type: name,
        target: this,
        preventDefault() {},
        stopPropagation() {},
      },
      event || {}
    );
    arr.slice().forEach((fn) => fn(ev));
    return ev;
  }
  /** 只实现探针用到的选择器：.cls / [attr] / 组合未用 */
  querySelector(sel) {
    return this._find((n) => matches(n, sel));
  }
  querySelectorAll(sel) {
    const out = [];
    this._walk((n) => {
      if (matches(n, sel)) out.push(n);
    });
    return out;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  _walk(cb) {
    for (const c of this.childNodes) {
      cb(c);
      c._walk(cb);
    }
  }
  _find(pred) {
    let hit = null;
    this._walk((n) => {
      if (!hit && pred(n)) hit = n;
    });
    return hit;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
}

function matches(node, sel) {
  if (!node || !node.tagName || node.tagName === "#text") return false;
  // 先剥掉卡片的 .card-fill 等前缀之后由简单选择器组成，这里只做最小子集：
  // .cls / tag / [attr] / [attr=value] / tag[attr=value] / .cls[attr=value]
  const s = String(sel).trim();
  if (s.startsWith("#")) return node.getAttribute("id") === s.slice(1);
  if (s.startsWith(".")) {
    const rest = s.slice(1);
    const bracket = rest.indexOf("[");
    if (bracket < 0) return node.classList.contains(rest);
    return node.classList.contains(rest.slice(0, bracket)) && matches(node, rest.slice(bracket));
  }
  const tagAttr = s.match(/^([a-zA-Z][\w-]*)\[/);
  if (tagAttr) {
    if (node.tagName !== tagAttr[1].toUpperCase()) return false;
    return matches(node, s.slice(tagAttr[1].length));
  }
  if (s.startsWith("[")) {
    const body = s.replace(/^\[|\]$/g, "");
    const m = body.split("=");
    if (m.length === 2) {
      const want = m[1].replace(/^"|"$/g, "");
      const got = node.getAttribute(m[0]);
      return got === want || (got === null && node[m[0]] === want);
    }
    return node.getAttribute(body) !== null;
  }
  return node.tagName === s.toUpperCase();
}

// ---------------------------------------------------------------- 极简 HTML 片段解析（只给 innerHTML 用）
// 支持：普通标签、带属性的标签、自闭合、纯文本。注释直接丢弃。
const TAG_RE =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const VOID_TAGS = new Set(["INPUT", "IMG", "BR", "HR", "META", "LINK"]);

function parseAttrs(str, node) {
  if (!str) return;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str))) {
    const name = m[1];
    if (!name || name === "/") continue;
    const raw = m[2] || "";
    const value = raw.replace(/^["']|["']$/g, "");
    if (name === "class") node.className = value;
    else if (name === "style") node.style.cssText = value;
    else node.setAttribute(name, value);
    if (name === "value") node.value = value;
    if (name === "hidden") node.hidden = true;
  }
}

function parseFragment(html) {
  const out = [];
  const stack = [{ childNodes: out }];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  const pushText = (text) => {
    if (!text) return;
    const t = document.createElement("#text");
    t.tagName = "#text";
    t.textContent = text;
    stack[stack.length - 1].childNodes.push(t);
    t.parentNode = stack[stack.length - 1];
  };
  while ((m = TAG_RE.exec(html))) {
    pushText(html.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      // 结束标签
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = m[2];
    const node = document.createElement(tag);
    parseAttrs(m[3], node);
    const parent = stack[stack.length - 1];
    parent.childNodes.push(node);
    node.parentNode = parent;
    if (!m[4] && !VOID_TAGS.has(String(tag).toUpperCase())) stack.push(node);
  }
  pushText(html.slice(last));
  // 顶层文本节点的 parentNode 指向伪根：探针里没人用，留空即可
  out.forEach((n) => {
    if (n.parentNode && !n.parentNode.tagName) n.parentNode = null;
  });
  return out;
}

const ESC_TEXT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escAttr(v) {
  return String(v).replace(/[&<>"]/g, (c) => ESC_TEXT[c]);
}

function serializeNode(node) {
  if (!node) return "";
  if (node.tagName === "#text") return String(node._text || "").replace(/&/g, "&amp;");
  const attrs = [];
  const cls = node.className;
  if (cls) attrs.push('class="' + escAttr(cls) + '"');
  const css = node.style && node.style.cssText;
  if (css) attrs.push('style="' + escAttr(css) + '"');
  for (const k of Object.keys(node.attributes || {})) {
    attrs.push(k + '="' + escAttr(node.attributes[k]) + '"');
  }
  const open = "<" + node.tagName.toLowerCase() + (attrs.length ? " " + attrs.join(" ") : "") + ">";
  if (VOID_TAGS.has(node.tagName)) return open;
  return open + node.innerHTML + "</" + node.tagName.toLowerCase() + ">";
}

function makeStyle() {
  const vars = Object.create(null);
  const decls = Object.create(null); // 普通声明（innerHTML 里的 style="..."）
  return {
    setProperty(k, v) {
      vars[k] = String(v);
    },
    getPropertyValue(k) {
      return vars[k] || "";
    },
    removeProperty(k) {
      delete vars[k];
    },
    get cssText() {
      return Object.keys(decls)
        .map((k) => k + ":" + decls[k])
        .join(";");
    },
    set cssText(v) {
      const src = String(v || "");
      for (const part of src.split(";")) {
        const i = part.indexOf(":");
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const val = part.slice(i + 1).trim();
        if (k) decls[k] = val;
      }
    },
    /** 读普通声明（比如 background），探针断言用 */
    getProperty(k) {
      return decls[k] || "";
    },
    vars,
  };
}

function makeClassList(initial) {
  const set = new Set(String(initial || "").split(/\s+/).filter(Boolean));
  return {
    set,
    add(...cs) {
      cs.forEach((c) => set.add(c));
    },
    remove(...cs) {
      cs.forEach((c) => set.delete(c));
    },
    contains(c) {
      return set.has(c);
    },
    toggle(c, force) {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c);
      else set.delete(c);
      return want;
    },
    toString() {
      return Array.from(set).join(" ");
    },
  };
}

// ================================================================ 内存 IndexedDB（够 store.js 用）
function makeFakeIndexedDB() {
  const dbs = new Map();

  class FakeRequest {
    constructor() {
      this.onsuccess = null;
      this.onerror = null;
      this.result = undefined;
      this.error = null;
    }
    _done(fn, value) {
      // 真 IDB 是异步派发：回调在「当前同步栈跑完之后」才触发，且触发时才读 handler。
      // 两点都必须照做——
      //   1) 用 setTimeout(0) 而不是 queueMicrotask：microtask 会插在调用方 Promise 链之前，
      //      让 store.js 后续的 `req.onsuccess = ...` 永远赶不上；
      //   2) 触发时才从 this.onsuccess 取回调（不能提前捕获 fn）：store 的 req()
      //      是拿到 request 之后才挂 handler 的，提前捕获只会拿到 null 并永久挂起。
      setTimeout(() => {
        this.result = value;
        const handler = this.onsuccess || fn;
        if (handler) handler({ target: this });
      }, 0);
    }
  }

  class FakeStore {
    constructor(name, keyPath) {
      this.name = name;
      this.keyPath = keyPath;
      this.data = new Map();
      this.indexes = new Map();
    }
    // 复合主键（keyPath 是数组）要压成一个标量，Map 的键才认
    _normKey(key) {
      return Array.isArray(key) ? key.join("\u0000") : key;
    }
    _keyOf(value) {
      if (Array.isArray(this.keyPath)) {
        return this.keyPath.map((k) => value[k]).join("\u0000");
      }
      return value[this.keyPath];
    }
    createIndex(name, keyPath) {
      const idx = { name, keyPath };
      this.indexes.set(name, idx);
      return idx;
    }
    index(name) {
      const self = this;
      const idx = this.indexes.get(name);
      return {
        getAll(value) {
          const r = new FakeRequest();
          const out = [];
          for (const v of self.data.values()) if (v && v[idx.keyPath] === value) out.push(v);
          r._done(r.onsuccess, out);
          return r;
        },
      };
    }
    get(key) {
      const r = new FakeRequest();
      r._done(r.onsuccess, this.data.get(this._normKey(key)));
      return r;
    }
    getAll() {
      const r = new FakeRequest();
      r._done(r.onsuccess, Array.from(this.data.values()));
      return r;
    }
    put(value) {
      const r = new FakeRequest();
      this.data.set(this._keyOf(value), value);
      r._done(r.onsuccess, value);
      return r;
    }
    delete(key) {
      const r = new FakeRequest();
      this.data.delete(this._normKey(key));
      r._done(r.onsuccess, undefined);
      return r;
    }
  }

  class FakeTransaction {
    constructor(db, storeNames) {
      this.db = db;
      this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
      this.onerror = null;
      this.onabort = null;
      this._oncomplete = null;
      this._completed = false;
    }
    /**
     * 真 IDB 的 transaction 只在「它内部所有请求都完成之后」才 complete，
     * 而且 oncomplete 往往是拿到 transaction 之后（甚至请求回调里）才赋值。
     * 所以这里不能在构造时就排完成定时器——那样像 store.setPinned 这种
     * 「在 req() 回调里才 txDone(t)」的用法永远等不到回调。
     * 改为：赋值 oncomplete 的那一刻才排期；请求的 _done 定时器都在这之前注册，故先跑。
     */
    get oncomplete() {
      return this._oncomplete;
    }
    set oncomplete(fn) {
      this._oncomplete = fn;
      if (typeof fn !== "function" || this._completed) return;
      setTimeout(() => {
        if (this._completed) return;
        this._completed = true;
        this._oncomplete({ target: this });
      }, 0);
    }
    objectStore(name) {
      const s = this.db.stores.get(name);
      if (!s) throw new Error("没有 objectStore: " + name);
      return s;
    }
  }

  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
    }
    createObjectStore(name, opts) {
      const s = new FakeStore(name, opts && opts.keyPath);
      this.stores.set(name, s);
      return s;
    }
    transaction(stores, _mode) {
      return new FakeTransaction(this, stores);
    }
  }

  return {
    open(name, version) {
      const req = new FakeRequest();
      const db = new FakeDB();
      dbs.set(name, db);
      // 同 FakeRequest._done：必须等 store.js 同步挂好 oncsuccess 之后再派发
      setTimeout(() => {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  };
}

// ================================================================ 安装全局环境
const document = (() => {
  const html = new FakeNode("html");
  const body = new FakeNode("body");
  html.appendChild(body);
  const doc = {
    documentElement: html,
    body,
    readyState: "complete",
    activeElement: null,
    _byId: Object.create(null),
    createElement(tag) {
      return new FakeNode(tag);
    },
    createTextNode(t) {
      const n = new FakeNode("#text");
      n.textContent = t;
      return n;
    },
    getElementById(id) {
      let found = null;
      html._walk((n) => {
        if (!found && n.getAttribute && n.getAttribute("id") === id) found = n;
      });
      if (!found && id in this._byId) found = this._byId[id];
      return found || null;
    },
    querySelector(sel) {
      return html.querySelector(sel);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
})();

globalThis.document = document;
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.indexedDB = makeFakeIndexedDB();
// Node 22 自带 crypto（只读 getter），有 randomUUID 就直接用，不必伪造
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "id-" + Math.random().toString(36).slice(2) },
    configurable: true,
  });
}

// ================================================================ 测试小工具
let passed = 0;
const failures = [];

/** 轮询等待条件成立（异步渲染的用例用它代替固定 sleep，避免假红）
 *  注意：名字必须是 untilTrue —— batch2 的探针尾巴里已经有一个 until(sel, tries)，
 *  两个文件由 make-probe.mjs 拼成一个模块，重名会 SyntaxError。 */
async function untilTrue(pred, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    try {
      if (pred()) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (err) {
    failures.push({ name, err });
    console.log("  FAIL " + name + " — " + (err && err.message));
  }
}

// ================================================================ 1. events
const { createEvents } = await import("./js/core/events.js");
await test("events: on/emit/off，回调抛错不影响其它回调", () => {
  const e = createEvents();
  const seen = [];
  const off = e.on("x", (p) => seen.push("a:" + p));
  e.on("x", () => {
    throw new Error("boom");
  });
  e.on("x", (p) => seen.push("c:" + p));
  e.emit("x", 1);
  e.emit("none");
  off();
  e.emit("x", 2);
  assert.deepEqual(seen, ["a:1", "c:1", "c:2"]);
});

// ================================================================ 2. router
const { createRouter } = await import("./js/core/router.js");
await test("router: push/back/depth，栈底 list 不可弹", () => {
  const events = createEvents();
  const cards = { list: {}, "chat-direct": {}, "detail-direct": {}, settings: {} };
  const r = createRouter({ events, cards });
  assert.equal(r.depth(), 1);
  assert.equal(r.current().id, "list");
  r.back();
  assert.equal(r.depth(), 1);
  r.push("chat-direct", { convId: "c1" });
  assert.equal(r.depth(), 2);
  assert.deepEqual(r.current(), { id: "chat-direct", params: { convId: "c1" } });
  r.back();
  assert.equal(r.current().id, "list");
});

await test("router: 重复 push 同一张同参被忽略；未知卡片抛错", () => {
  const events = createEvents();
  const r = createRouter({ events, cards: { list: {}, settings: {} } });
  let routeCount = 0;
  events.on("route", () => routeCount++);
  r.push("settings");
  r.push("settings");
  assert.equal(r.depth(), 2);
  assert.equal(routeCount, 1);
  assert.throws(() => r.push("nope"), /未知卡片/);
});

await test("router: clamp(2) 保留栈底+栈顶", () => {
  const events = createEvents();
  const r = createRouter({ events, cards: { list: {}, a: {}, b: {}, c: {} } });
  r.push("a", { n: 1 });
  r.push("b", { n: 2 });
  r.push("c", { n: 3 });
  assert.equal(r.depth(), 4);
  r.clamp(2);
  assert.equal(r.depth(), 2);
  assert.equal(r.stack[0].id, "list");
  assert.equal(r.stack[1].id, "c");
});

await test("router: replace 替换栈顶，栈底不动", () => {
  const events = createEvents();
  const r = createRouter({ events, cards: { list: {}, a: {}, b: {} } });
  r.push("a", { n: 1 });
  r.replace("b", { n: 2 });
  assert.equal(r.depth(), 2);
  assert.equal(r.stack[1].id, "b");
  assert.equal(r.stack[0].id, "list");
});

// ================================================================ 3. theme
const { applySettings, deriveTheme } = await import("./js/core/theme.js");
await test("theme: skin/主题色/壁纸/亮度写到 body，三件套写到根", () => {
  applySettings({ accent: "#00a884", defaultWallpaper: "forest", dim: 0.4 });
  assert.equal(document.body.getAttribute("data-skin"), "wa");
  // 三件套（--accent / --accent-soft / --accent-surface / --accent-on / --send-bg）落在 documentElement
  const root = document.documentElement.style;
  assert.equal(root.getPropertyValue("--accent"), "#00a884");
  assert.equal(root.getPropertyValue("--send-bg"), "#00a884");
  assert.equal(root.getPropertyValue("--accent-soft"), "#e0f5f0");
  assert.equal(root.getPropertyValue("--accent-surface"), "#f7fcfb");
  assert.equal(root.getPropertyValue("--accent-on"), "#ffffff");
  assert.equal(document.body.getAttribute("data-wallpaper"), "forest");
  assert.equal(document.body.style.getPropertyValue("--dim-opacity"), "0.4");
});

await test("theme: 未知色值回落 notion，未知/缺失壁纸回落 aurora，亮度越界被夹住", () => {
  applySettings({ accent: "#123456", defaultWallpaper: "none", dim: 5 });
  assert.equal(document.documentElement.style.getPropertyValue("--accent"), "#123456");
  assert.equal(document.body.getAttribute("data-skin"), "notion");
  assert.equal(document.body.getAttribute("data-wallpaper"), "aurora");
  assert.equal(document.body.style.getPropertyValue("--dim-opacity"), "0.8");
  applySettings({ dim: -1 });
  assert.equal(document.body.style.getPropertyValue("--dim-opacity"), "0");
});

await test("theme: deriveTheme 三件套（浅灰默认 / 彩色 / 白已下线）", () => {
  const dark = deriveTheme("#0075de");
  assert.equal(dark.base, "#0075de");
  assert.equal(dark.soft, "#e0eefb");
  assert.equal(dark.surface, "#f7fbfe");
  assert.equal(dark.on, "#ffffff");
  // 默认浅灰：亮度 0.78 > 0.7 → 浅色分支，soft 混白 45%（不是 12%）
  const light = deriveTheme("#e5e5ea");
  assert.equal(light.base, "#e5e5ea");
  assert.equal(light.soft, "#f3f3f6");
  assert.equal(light.surface, "#ffffff");
  assert.equal(light.on, "#1c1c1e");
  // 三件套必须互不相同（气泡/卡面能肉眼分开）
  assert.notEqual(light.soft, light.surface);
  assert.notEqual(dark.soft, dark.surface);
  assert.notEqual(dark.soft, dark.base);
  // 认不出的色值回落默认色
  assert.equal(deriveTheme("bogus").base, "#e5e5ea");
});

// ================================================================ 4. store 建数据
const { createStore, getSelf } = await import("./js/core/store.js");
const store = createStore();
if (process.env.DBG) console.log("[dbg] store created, calling ready()");
await Promise.race([
  store.ready(),
  new Promise((_, rej) => setTimeout(() => rej(new Error("store.ready() 超时 3000ms")), 3000)),
]);
if (process.env.DBG) console.log("[dbg] ready ok");

// ================================================================ 5. list 卡片（真 import）
const listCard = (await import("./js/cards/list.js")).default;

function makeCtx() {
  const events = createEvents();
  const router = createRouter({
    events,
    cards: {
      list: {},
      "chat-direct": {},
      "chat-group": {},
      "detail-direct": {},
      "detail-group": {},
      settings: {},
    },
  });
  return { store, api: {}, router, events, settings: {} };
}

/** 每个 list 用例从干净库开始：级联删掉所有会话 */
async function resetDb() {
  for (const c of await store.listConversations()) await store.deleteConversation(c.id);
}

/** 按 data-id 找行，避免依赖列表顺序 */
function rowOf(convId) {
  return listCard.listEl
    .querySelectorAll(".conv")
    .filter((n) => n.getAttribute("data-id") === convId)[0];
}

/** 设计稿的行里没有 ⋮：会话菜单走右键（长按同一入口），事件冒泡到 .conv-list */
function dispatchMenuItem(convId) {
  const row = rowOf(convId);
  listCard.listEl.dispatch("contextmenu", { target: row });
}

await test("list: mount 后渲染会话行（照搬设计稿结构）", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);

  await store.createConversation("甲", null, "direct");
  const group = await store.createConversation("乙群", [{ name: "A" }, { name: "B" }], "group");
  await store.setPinned(group.conversation.id, true);
  await listCard.reload();

  const rows = listCard.listEl.querySelectorAll(".conv");
  assert.equal(rows.length, 2);
  // 置顶的排前面
  assert.equal(rows[0].getAttribute("data-id"), group.conversation.id);
  // 设计稿的行结构：c-ava / c-main(c-name>span + c-preview) + 行尾 c-time
  assert.ok(rows[0].querySelector(".c-ava"));
  assert.ok(rows[0].querySelector(".c-main"));
  assert.ok(rows[0].querySelector(".c-name"));
  assert.ok(rows[0].querySelector(".c-preview"));
  assert.ok(rows[0].querySelector(".c-time"));
  // 设计稿里没有 ⋮ / 图钉 / 成员数徽标
  assert.equal(rows[0].querySelector(".c-more"), null);
  assert.equal(rows[0].querySelector(".c-pin"), null);
  assert.equal(rows[0].querySelector(".c-badge"), null);
  assert.equal(rows[1].querySelector(".c-preview").textContent, "（还没有消息）");
  await listCard.unmount();
});

await test("list: 预览取最后一条消息并压平空白", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);

  const c = await store.createConversation("有消息", null, "direct");
  await store.addMessage({
    id: "m1",
    convId: c.conversation.id,
    role: "assistant",
    content: "line1\n\n  line2",
    ts: 1,
  });
  await store.addMessage({
    id: "m2",
    convId: c.conversation.id,
    role: "user",
    content: "最后的\n一句",
    ts: 2,
  });
  await listCard.reload();
  const row = rowOf(c.conversation.id);
  assert.equal(row.querySelector(".c-preview").textContent, "最后的 一句");
  await listCard.unmount();
});

await test("list: 点会话推 chat-* 并广播 conv:selected；群聊卡片 id 正确", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);

  let selected = null;
  ctx.events.on("conv:selected", (p) => (selected = p.convId));

  const group = await store.createConversation("群X", [{ name: "A" }, { name: "B" }], "group");
  await listCard.reload();
  const row = rowOf(group.conversation.id);
  listCard.listEl.dispatch("click", { target: row.querySelector(".c-ava") });

  assert.equal(selected, group.conversation.id);
  assert.equal(ctx.router.current().id, "chat-group");
  assert.equal(rowOf(group.conversation.id).classList.contains("active"), true);
  await listCard.unmount();
});

await test("list: 私聊 kind=direct 即使只有 1 个成员也推 chat-direct", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);
  const c = await store.createConversation("私聊X", null, "direct");
  await listCard.reload();
  const row = rowOf(c.conversation.id);
  listCard.listEl.dispatch("click", { target: row.querySelector(".c-ava") });
  assert.equal(ctx.router.current().id, "chat-direct");
  assert.equal(ctx.router.current().params.convId, c.conversation.id);
  await listCard.unmount();
});

await test("list: 没有会话时显示空态提示", async () => {
  const fresh = createStore();
  // 用同一 fake IDB，先清表
  for (const c of await store.listConversations()) await store.deleteConversation(c.id);
  await fresh.ready();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);
  await listCard.reload();
  assert.equal(listCard.listEl.querySelectorAll(".conv").length, 0);
  assert.ok(listCard.listEl.textContent.indexOf("还没有会话") >= 0, "应有空态提示文字");
  await listCard.unmount();
});

await test("list: 右键菜单「置顶」落库并把该会话排到第一", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);

  const a = await store.createConversation("甲会话", null, "direct");
  const b = await store.createConversation("乙会话", null, "direct");
  await listCard.reload();
  // 乙最后创建（updatedAt 最大）且在未置顶时排第一
  assert.equal(listCard.listEl.querySelectorAll(".conv")[0].getAttribute("data-id"), b.conversation.id);

  // 设计稿没有 ⋮，菜单走右键（长按同理）——atoms.menu 把 sheet 挂到 body
  dispatchMenuItem(a.conversation.id);
  await new Promise((r) => setTimeout(r, 20));

  const sheet = document.querySelector(".sheet");
  assert.ok(sheet, "应弹出底部菜单");
  const pinBtn = sheet
    .querySelectorAll(".sheet-item")
    .filter((n) => n.textContent === "置顶")[0];
  assert.ok(pinBtn, "菜单里应有「置顶」");
  pinBtn.dispatch("click");
  // 等 DOM 真的换过来（reload 是异步的，固定 sleep 会随加载阶段变化而假红）
  const ok = await untilTrue(() => {
    const first = listCard.listEl.querySelectorAll(".conv")[0];
    return first && first.getAttribute("data-id") === a.conversation.id;
  }, 3000);

  const convs = await store.listConversations();
  assert.equal(convs[0].id, a.conversation.id);
  assert.equal(convs[0].pinned, true);
  assert.equal(convs.filter((c) => c.pinned).length, 1, "单一置顶不变量");
  assert.equal(listCard.listEl.querySelectorAll(".conv")[0].getAttribute("data-id"), a.conversation.id);
  assert.equal(listCard.listEl.querySelectorAll(".conv")[0].getAttribute("data-pinned"), "1");
  assert.equal(listCard.listEl.querySelectorAll(".conv")[1].getAttribute("data-pinned"), null);
  await listCard.unmount();
});

await test("list: 右键菜单四项，群聊最后一项叫「删除群聊」", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await listCard.mount(root, ctx);

  const g = await store.createConversation("群D", [{ name: "A" }, { name: "B" }], "group");
  await listCard.reload();

  dispatchMenuItem(g.conversation.id);
  await new Promise((r) => setTimeout(r, 20));

  const sheet = document.querySelector(".sheet");
  const labels = sheet.querySelectorAll(".sheet-item").map((n) => n.textContent).join("|");
  assert.equal(labels, "置顶|重命名|清空聊天记录|删除群聊");
  await listCard.unmount();
});

await test("store: §2.3 口径（conv.accent 默认 null / 两个 resolve / memos）", async () => {
  const made = await store.createConversation("口径用例", [{ name: "甲" }], "direct");
  const conv = made.conversation;
  assert.equal(conv.accent, null);
  assert.equal(conv.wallpaper, null);
  assert.equal(typeof conv.avatar.label, "string");
  assert.equal(conv.avatar.label, "口径用例");

  // resolveAccent：会话覆盖优先，其次用户默认，最后兜底色
  assert.equal(store.resolveAccent(conv, { accent: "#00a884" }), "#00a884");
  assert.equal(store.resolveAccent({ accent: "#7c5cff" }, { accent: "#00a884" }), "#7c5cff");
  assert.equal(store.resolveAccent({}, {}), "#e5e5ea");
  // resolveMemberAccent：成员色 > 用户默认 > 默认浅灰
  assert.equal(store.resolveMemberAccent({ accent: "#7c5cff" }, { accent: "#00a884" }), "#7c5cff");
  assert.equal(store.resolveMemberAccent({ accent: null }, { accent: "#00a884" }), "#00a884");
  assert.equal(store.resolveMemberAccent({}, {}), "#e5e5ea");
  // 成员字段：accent 默认 null，avatar 由名字生成
  const mem = (await store.listMembers(conv.id))[0];
  assert.equal(mem.accent, null);
  assert.equal(mem.avatar.label, "甲");
  assert.equal(mem.roleTag, "");
  // resolveWallpaper：null/未知值一律回落用户默认
  assert.equal(store.resolveWallpaper(conv, { defaultWallpaper: "dusk" }), "dusk");
  assert.equal(store.resolveWallpaper({ wallpaper: "forest" }, { defaultWallpaper: "dusk" }), "forest");
  assert.equal(store.resolveWallpaper({ wallpaper: "bogus" }, {}), "aurora");

  // memo：单条、无上限、整段覆盖（用户口径 2026-11-25）
  assert.equal(await store.getMemo(conv.id), "", "没有备忘时是空串，不是 null");
  assert.equal((await store.setMemo("第一条", conv.id)).text, "第一条");
  assert.equal(await store.getMemo(conv.id), "第一条");
  // 覆盖式：再写一次只剩新内容，不是追加
  const second = await store.setMemo("第二条", conv.id);
  assert.equal(second.text, "第二条");
  assert.equal(await store.getMemo(conv.id), "第二条");
  // 无上限：3000 字符原样保留（老的 2048 截断已删）
  const long = await store.setMemo("x".repeat(3000), conv.id);
  assert.equal(long.text.length, 3000);
  // 空串 = 清空内容但不报错
  await store.setMemo("", conv.id);
  assert.equal(await store.getMemo(conv.id), "");
  // clearMemo 删行：删到了 true，本来没有 false
  await store.setMemo("再写一条", conv.id);
  assert.equal(await store.clearMemo(conv.id), true);
  assert.equal(await store.clearMemo(conv.id), false);
  // 省略 convId = 全局桶，与会话桶互不影响
  await store.setMemo("全局的");
  assert.equal(await store.getMemo(), "全局的");
  assert.equal(await store.getMemo(conv.id), "");
  assert.equal(await store.clearMemo(), true);
  // 删会话级联清备忘
  await store.setMemo("会话里的", conv.id);
  await store.deleteConversation(conv.id);
  assert.equal(await store.getMemo(conv.id), "");
});

await test("store: 旧 accent 白/近白迁到默认浅灰（#e5e5ea），彩色不动", async () => {
  // 白色主题已下线：老库里存着 #ffffff / 近白 的主题色，读出来必须是浅灰
  const a = await store.setSettings({ accent: "#ffffff" });
  assert.equal(a.accent, "#e5e5ea");
  assert.equal((await store.getSettings()).accent, "#e5e5ea");
  // 近白（亮度 > 0.95）同样迁走
  assert.equal((await store.setSettings({ accent: "#fefefe" })).accent, "#e5e5ea");
  // 彩色不迁
  assert.equal((await store.setSettings({ accent: "#00a884" })).accent, "#00a884");
  assert.equal((await store.setSettings({ accent: "#e5e5ea" })).accent, "#e5e5ea");
  // 会话/成员自己挑的「白」= 跟随默认（null）
  const made = await store.createConversation({ kind: "group", title: "白主题迁移", members: [{ name: "甲", accent: "#ffffff" }] });
  assert.equal((await store.listMembers(made.conversation.id))[0].accent, null);
  assert.equal((await store.getConversation(made.conversation.id)).accent, null);
  await store.deleteConversation(made.conversation.id);
});

await test("store: createConversation 对象签名（+ 旧签名兼容）与 addMessage 兜底 id/seq", async () => {
  // 对象签名是唯一正解：kind 不会被吞掉，title 不会是 "[object Object]"
  const g = await store.createConversation({ kind: "group", title: "三人群", members: [{ name: "甲" }, { name: "乙" }] });
  assert.equal(g.conversation.kind, "group");
  assert.equal(g.conversation.title, "三人群");
  assert.equal(g.members.length, 2);
  assert.equal(g.members[0].convId, g.conversation.id);
  assert.equal(g.members[0].seq, undefined); // 成员没有 seq

  // 只给 kind/title，其余走默认
  const d = await store.createConversation({ title: "私聊A" });
  assert.equal(d.conversation.kind, "direct");
  assert.equal(d.members.length, 1);

  // 旧签名 (title, members, kind) 仍然按原语义工作
  const old = await store.createConversation("旧签名群", [{ name: "丙" }], "group");
  assert.equal(old.conversation.kind, "group");
  assert.equal(old.conversation.title, "旧签名群");

  // addMessage：不给 id / seq / ts 也不抛 DataError
  const m1 = await store.addMessage({ convId: g.conversation.id, role: "user", content: "第一条" });
  assert.ok(m1 && m1.id, "addMessage 应自动补 id");
  assert.equal(m1.seq, 0);
  assert.equal(typeof m1.ts, "number");
  const m2 = await store.addMessage({ convId: g.conversation.id, role: "assistant", content: "第二条", memberId: g.members[0].id });
  assert.equal(m2.seq, 1);
  assert.notEqual(m2.id, m1.id);
  // 显式 seq 不被覆盖
  const m3 = await store.addMessage({ convId: g.conversation.id, role: "user", content: "第三条", id: "fixed-id", seq: 9 });
  assert.equal(m3.id, "fixed-id");
  assert.equal(m3.seq, 9);
  // 缺 convId 明确报错
  let threw = null;
  try {
    await store.addMessage({ role: "user", content: "x" });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && /convId/.test(threw.message), "缺 convId 应报错");
});

// ================================================================ 6. settings 卡片
const settingsCard = (await import("./js/cards/settings.js")).default;

await test("settings: mount 后填充当前设置并高亮当前主题/壁纸", async () => {
  await resetDb();
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await settingsCard.mount(root, ctx);
  await settingsCard.onEnter();

  const s = await store.getSettings();
  assert.equal(settingsCard.baseInput.value, s.baseUrl);
  assert.equal(settingsCard.modelInput.value, s.model);
  assert.equal(settingsCard.swatchEls[s.accent].classList.contains("active"), true);
  assert.equal(settingsCard.wallEls[s.defaultWallpaper].classList.contains("active"), true);
  await settingsCard.unmount();
});

await test("settings: 改主题/背景落库并广播 settings:applied", async () => {
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await settingsCard.mount(root, ctx);
  await settingsCard.onEnter();

  let applied = null;
  ctx.events.on("settings:applied", (s) => (applied = s));

  await settingsCard.apply({ accent: "#d97757" });
  await settingsCard.apply({ defaultWallpaper: "forest" });

  const s = await store.getSettings();
  assert.equal(s.accent, "#d97757");
  assert.equal(s.defaultWallpaper, "forest");
  assert.equal(applied.defaultWallpaper, "forest");
  assert.equal(settingsCard.wallEls.forest.classList.contains("active"), true);
  assert.equal(settingsCard.wallEls.aurora.classList.contains("active"), false);
  // 亮度滑块已按用户要求删除，设置卡里不能再有 range 控件
  assert.equal(root.querySelectorAll("input[type=range]").length, 0);
  // 三项背景按钮：极光 / 深绿 / 暮紫
  assert.equal(Object.keys(settingsCard.wallEls).join(","), "aurora,forest,dusk");
  assert.equal(
    settingsCard.wrap
      .querySelector(".seg")
      .querySelectorAll("button")
      .map((b) => b.textContent)
      .join(","),
    "极光,深绿,暮紫"
  );
  await settingsCard.unmount();
});

await test("settings: 保存时空 Base URL/模型不覆盖旧值，Key 可为空", async () => {
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await settingsCard.mount(root, ctx);
  await settingsCard.onEnter();

  await settingsCard.save({ baseUrl: "", model: "", apiKey: "sk-test" });
  let s = await store.getSettings();
  assert.equal(s.baseUrl, "/gw/v1");
  assert.equal(s.model, "group/meru");
  assert.equal(s.apiKey, "sk-test");

  await settingsCard.save({ baseUrl: "https://x.example/v1", model: "m1", apiKey: "" });
  s = await store.getSettings();
  assert.equal(s.baseUrl, "https://x.example/v1");
  assert.equal(s.model, "m1");
  assert.equal(s.apiKey, "");
  await settingsCard.unmount();
});

await test("settings: 大头像 = 自己，名字改名走 getSelf 唯一入口", async () => {
  const ctx = makeCtx();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await settingsCard.mount(root, ctx);
  await settingsCard.onEnter();

  // 默认身份（§2.3：User.name + User.avatar，label 存首字）
  assert.equal(getSelf().name, "内测用户01");
  assert.equal(getSelf().avatar.label, "内");
  assert.equal(root.querySelector(".name-text").textContent, "内测用户01");
  assert.equal(root.querySelector(".big-ava").textContent, "内");
  assert.equal(root.querySelector(".big-ava").getAttribute("title"), "内测用户01");

  let changed = null;
  ctx.events.on("settings:changed", (p) => (changed = p));

  // 点名字 = 改名（prompt 用桩替掉）
  ctx.prompt = async () => "测试用户B";
  await settingsCard.renameSelf();

  const s = await store.getSettings();
  assert.equal(s.name, "测试用户B");
  assert.equal(s.selfName, "测试用户B"); // 老键同步，供还没改完的卡片读
  assert.equal(changed && changed.name, "测试用户B");
  assert.equal(root.querySelector(".name-text").textContent, "测试用户B");
  assert.equal(root.querySelector(".big-ava").textContent, "测");
  assert.equal(root.querySelector(".big-ava").getAttribute("title"), "测试用户B");
  await settingsCard.unmount();
});

await test("settings: 返回按钮调用 router.back()", async () => {
  const ctx = makeCtx();
  ctx.router.push("settings");
  const depthBefore = ctx.router.depth();
  const root = document.createElement("section");
  document.body.appendChild(root);
  await settingsCard.mount(root, ctx);
  const backBtn = root.querySelector(".sr-back");
  backBtn.dispatch("click");
  assert.equal(ctx.router.depth(), depthBefore - 1);
  await settingsCard.unmount();
});

// ================================================================ 汇总console.log("");
console.log(passed + " passed, " + failures.length + " failed");
if (failures.length) {
  for (const f of failures) {
    console.log("--- " + f.name);
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exitCode = 1;
}
