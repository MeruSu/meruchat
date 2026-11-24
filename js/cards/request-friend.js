/**
 * MeruChat 卡片：好友申请（request-friend）
 *
 * 契约见 `docs/DEV.md` §2.7.2 / §2.7.6：
 *   会话把你删了（`relations(convId,"user").state === "removed"`）之后，它的气泡左侧出现红色感叹号，
 *   点感叹号进这张卡；页上**只有一个输入框**；提交后落一条**普通消息**（不是系统消息），
 *   带 `request: { type, fromConvId, groupId?, status }` 字段——用户原话「好友申请是以正常的消息弹出来的」。
 *
 * 与 `request-join.js` 的差别只有 5 处（卡片 id / 顶部标题 / `.req-title` 文案 / hint 文案 /
 * `request.type`）；这两份 DOM 各写一份，样式只有一份 `css/card-request.css`
 * （用户口径：「做两个独立的页，复用一下，只有一个框显示填入好友申请/入群申请」）。
 *
 * DOM 骨架（根 `.card.card-request` > `.phone-win.phone-request`）：
 *   .req-head  ← ‹ 返回 + 标题
 *   .req-body
 *     .req-title    一行大字「向「{会话名}」发送好友申请」
 *     .req-hint     一行灰字说明（12px，--meta）
 *     .req-form
 *       textarea.req-input（唯一输入框）
 *       .req-foot > button.req-submit + span.req-note
 *     .req-empty    拿不到会话时那一行「会话不存在」
 *
 * 卡片根是壳建的（`js/shell.js` 的 CARDS 里 `kind: "request"` → `cardClass()` 出 `card card-request`）；
 * 单独挂到裸容器里时（预览 / 探针）这里自己补上两个 class，保证 DOM 骨架恒定。
 */

var CARD_ID = "request-friend";
var HEAD_TITLE = "好友申请";
var HINT_TEXT = "对方删除了你，说明一下你是谁再申请吧。";
var REQUEST_TYPE = "friend";

/* ------------------------------------------------------------- 模块级状态 */

var rootEl = null;
var ctx = null;
var convId = null;
var conv = null;
var mounted = false;
var winEl = null; // <aside class="phone-win phone-request">
var nameEl = null; // .req-title > .req-name（会话名的落点，只写 textContent）
var inputEl = null; // textarea.req-input（唯一输入框）
var submitEl = null; // button.req-submit
var busy = false; // 提交中（防止双击落两条申请）

/* -------------------------------------------------------------- 静态骨架 */

var BODY_TPL = [
  '<div class="req-head">',
  '  <button class="req-back" type="button" aria-label="返回">‹</button>',
  '  <span class="req-head-title">' + HEAD_TITLE + "</span>",
  "</div>",
  '<div class="req-body">',
  '  <div class="req-title">向「<span class="req-name"></span>」发送好友申请</div>',
  '  <div class="req-hint">' + HINT_TEXT + "</div>",
  '  <div class="req-form">',
  '    <textarea class="req-input" rows="4" placeholder="写一句申请理由…"></textarea>',
  '    <div class="req-foot">',
  '      <button class="req-submit" type="button" disabled>发送申请</button>',
  '      <span class="req-note">申请会以普通消息发给对方</span>',
  "    </div>",
  "  </div>",
  '  <div class="req-empty">会话不存在</div>',
  "</div>",
].join("\n");

/* ------------------------------------------------------------------ 小工具 */

/** 轻提示（壳在听 "toast"）；广播失败不影响已经落库的数据 */
function toast(text) {
  if (!text) return;
  try {
    if (ctx && ctx.events && typeof ctx.events.emit === "function") {
      ctx.events.emit("toast", { text: String(text) });
    }
  } catch (e) {
    // 没有事件总线就静默
  }
}

function emit(name, payload) {
  try {
    if (ctx && ctx.events && typeof ctx.events.emit === "function") {
      ctx.events.emit(name, payload || {});
    }
  } catch (e) {
    // 同 toast
  }
}

function back() {
  if (ctx && ctx.router && typeof ctx.router.back === "function") ctx.router.back();
}

/* ------------------------------------------------------------------ 数据 */

/** 读该申请要去哪个会话（会话标题要填进 .req-title） */
function load() {
  if (!convId || !ctx || !ctx.store || typeof ctx.store.getConversation !== "function") {
    conv = null;
    return Promise.resolve(false);
  }
  return Promise.resolve(ctx.store.getConversation(convId)).then(
    function (c) {
      conv = c || null;
      return !!conv;
    },
    function () {
      conv = null;
      return false;
    }
  );
}

/* ------------------------------------------------------------------ 渲染 */

/** 提交键在「有内容 + 有会话 + 不在提交中」时才可点（用户的硬要求：空着就是灰的） */
function syncSubmit() {
  if (!submitEl) return;
  var text = inputEl ? String(inputEl.value || "").trim() : "";
  submitEl.disabled = !(convId && conv && text && !busy);
}

/** 拿不到会话 → .phone-request[data-state="missing"]，CSS 只留「会话不存在」那一行 */
function paint() {
  if (!winEl) return;
  var has = !!(conv && convId);
  winEl.setAttribute("data-state", has ? "ready" : "missing");
  if (nameEl) nameEl.textContent = has ? String(conv.title || "") : "";
  syncSubmit();
}

/**
 * 提交：落一条**普通消息**，带 request 字段（§2.7.2）。成功后回上一页；
 * 失败只提示、不跳走（用户刚写的字还在输入框里）。
 */
function submit() {
  if (busy || !convId || !conv || !inputEl) return Promise.resolve(false);
  var text = String(inputEl.value || "").trim();
  if (!text) {
    toast("写一句申请理由再发送");
    syncSubmit();
    return Promise.resolve(false);
  }

  busy = true;
  syncSubmit();

  var message = {
    convId: convId,
    role: "user",
    content: text,
    status: "complete",
    request: { type: REQUEST_TYPE, fromConvId: convId, status: "pending" },
  };

  // addMessage 只收一个对象（convId 在对象里），别写成 addMessage(convId, message)
  return Promise.resolve(ctx.store.addMessage(message)).then(
    function () {
      busy = false;
      if (inputEl) inputEl.value = "";
      syncSubmit();
      // 会话列表的「最后一条」预览与聊天卡都要跟着变
      emit("messages-changed", { convId: convId });
      back();
      return true;
    },
    function (err) {
      busy = false;
      syncSubmit();
      toast("申请没发出去：" + (err && err.message ? err.message : String(err)));
      return false;
    }
  );
}

/* -------------------------------------------------------------- 生命周期 */

/** 挂骨架 + 接线（重复 mount 时先清空，防止两张窗口叠在一起） */
function build() {
  if (!rootEl) return;
  rootEl.textContent = "";
  if (!rootEl.classList.contains("card")) rootEl.classList.add("card");
  if (!rootEl.classList.contains("card-request")) rootEl.classList.add("card-request");

  var win = document.createElement("aside");
  win.className = "phone-win phone-request";
  win.setAttribute("data-state", "missing");
  win.innerHTML = BODY_TPL;
  rootEl.appendChild(win);
  winEl = win;

  nameEl = win.querySelector(".req-name");
  inputEl = win.querySelector(".req-input");
  submitEl = win.querySelector(".req-submit");

  var backBtn = win.querySelector(".req-back");
  if (backBtn) {
    backBtn.addEventListener("click", function () {
      back();
    });
  }

  if (inputEl) {
    inputEl.addEventListener("input", function () {
      syncSubmit();
    });
  }

  if (submitEl) {
    submitEl.addEventListener("click", function () {
      submit();
    });
  }
}

var card = {
  id: CARD_ID,
  title: HEAD_TITLE,

  async mount(root, context) {
    rootEl = root || null;
    ctx = context || null;
    mounted = true;
    build();

    // 壳可能先 mount 再 onEnter，也可能带 params 直接 mount；两种都兜住
    if (convId) {
      await load();
      paint();
    }
  },

  async onEnter(params) {
    var p = params || {};
    convId = p.convId || p.id || null;
    busy = false;
    if (!mounted || !rootEl) return; // 等 mount 补渲染
    await load();
    paint();
  },

  async unmount() {
    mounted = false;
    busy = false;
    if (rootEl) rootEl.textContent = "";
    winEl = null;
    nameEl = null;
    inputEl = null;
    submitEl = null;
    conv = null;
    convId = null;
    rootEl = null;
    ctx = null;
  },
};

/** 工厂（契约形状：export function createXxxCard() → 卡片对象） */
export function createRequestFriendCard() {
  return card;
}

export default card;