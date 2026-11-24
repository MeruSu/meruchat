/**
 * MeruChat 卡片：私聊详情（detail-direct）
 *
 * DOM 结构与文字**逐字照搬** `C:\Meru\website\su\preview\styles.html` 第 833-869 行
 * （用户 2026-11-24 原话：「私聊详情页直接照搬之前的第三页就行了 不要做改动」）。
 * 只做三处与第三页的差异，其余 class / 元素一个都不增删：
 *   1. 第三页那一整块强调色色板（那两组 .sw 色块）**整块不要**——用户 2026-11-24 定：私聊详情不显示强调色设置
 *   2. 壁纸 <select> 的选项：跟随默认 + 3 个枚举值（极光 aurora / 深绿 forest / 暮紫 dusk），不要「自定义」
 *   3. 文字部分（头像首字 / 名字 / 人格）来自 store，其余写死文字与第三页一致
 *
 * 数据结构口径以 js/core/store.js 为唯一来源：标题读 conv.title、背景读 store.resolveWallpaper()、
 * 头像优先走 js/ui/avatar.js 的 renderAvatar()（该模块尚未落地时回落到 atoms.avatar 的同 seed 渐变）。
 * 视觉全部由 css/style-kit.css（第三页原样副本）+ css/theme.css（token）+ css/card-detail.css 提供，
 * 本文件不写内联样式。
 */

import { avatar } from "../ui/atoms.js";
import * as storeNs from "../core/store.js";
import * as themeNs from "../core/theme.js";
import { estimateMessages, estimateTokens } from "../core/context.js";
import { el, errorText, now } from "../core/util.js";

var CARD_ID = "detail-direct";

/** 模块级状态（同一时刻只有一张 detail-direct 实例） */
var rootEl = null;
var ctx = null;
var convId = null;
var conv = null;
var member = null;
var mounted = false;
var personaTimer = null; // 人格输入的防抖定时器
var personaDirty = false; // 有未落盘的人格改动
var personaArea = null; // textarea 引用（卸载前 flush 用）
var nameEditor = null; // 正在编辑名字时的 input 引用
var escHandler = null;
var panel = null; // <aside class="phone-win sidebar-right">
var selectEl = null; // 壁纸 select
var avatarApi = null; // js/ui/avatar.js（dev-a 在建）；false = 探测过但不存在
var settingsOff = null; // settings:applied 的退订函数
var profileOff = null; // profile:changed 的退订函数（模型改了自己 → 就地重画）
var liveSettings = null; // settings:applied 带过来的最新用户设置（§2.3 的 User）

/* -------------------------------------------------------------- 第三页 DOM */

/** styles.html 833-869 行的结构，逐字照搬；只去掉「强调色」块、换壁纸选项 */
var PANEL_TPL = [
  '<button class="sr-back" type="button" aria-label="返回">‹</button>',
  '<div class="sr-scroll">',
  '  <div class="avatar-block">',
  '    <div class="big-ava" title="更换头像"></div>',
  "  </div>",
  '  <div class="name-center">',
  '    <div class="name-text"></div>',
  "  </div>",
  '  <div class="field">',
  '    <label class="lbl">设定 / 人格</label>',
  '    <textarea rows="5" placeholder="描述对方是谁、怎么说话、有什么设定……"></textarea>',
  "  </div>",
    '  <div class="section-title">外观</div>',
  '  <div class="field">',
  '    <label class="lbl">壁纸</label>',
  "    <select>",
  '      <option value="default">跟随默认</option>',
  '      <option value="aurora">极光</option>',
  '      <option value="forest">深绿</option>',
  '      <option value="dusk">暮紫</option>',
  "    </select>",
  "  </div>",
  '  <div class="section-title">上下文</div>',
  '  <div class="field" data-role="ctx"></div>',
  "</div>"
].join("\n");

/* -------------------------------------------------------------- 数据读写 */

/** 当前会话的「对方」：私聊只应有一个成员，取 sort 最小的那个 */
function load() {
  if (!convId) return Promise.resolve(false);
  return Promise.resolve(ctx.store.getConversation(convId)).then(function (c) {
    conv = c || null;
    if (!conv) return false;
    return Promise.resolve(ctx.store.listMembers(convId)).then(function (list) {
      member = list && list.length ? list[0] : null;
      return true;
    });
  });
}

/** 模型通过 set_name / set_persona / set_look 改了自己 → 重读库再重画。
 *  正在编辑名字或人格时不重画，否则会把用户没落盘的字冲掉。 */
function refreshFromStore() {
  if (!mounted || nameEditor || personaDirty) return Promise.resolve(null);
  return load().then(function (ok) {
    return ok ? render() : null;
  });
}

function emit(name, payload) {
  try {
    if (ctx && ctx.events && typeof ctx.events.emit === "function") {
      ctx.events.emit(name, payload || {});
    }
  } catch (e) {
    // 广播失败不影响已经落库的数据
  }
}

/** 保存人格（防抖到期 / 卸载 flush 时调用） */
function savePersona() {
  if (!member || !personaDirty || !personaArea) return Promise.resolve(null);
  personaDirty = false;
  member.persona = personaArea.value;
  member.updatedAt = now();
  var next = member;
  return Promise.resolve(ctx.store.putMember(next)).then(function () {
    emit("members-changed", { convId: convId, memberId: next.id });
    return next;
  });
}

/** 保存名字（会话标题 + 成员名同步） */
function saveName(raw) {
  if (!conv) return Promise.resolve(null);
  var name = String(raw == null ? "" : raw).trim();
  var changed = false;

  if (name && name !== conv.title) {
    conv.title = name;
    conv.updatedAt = now();
    changed = true;
  }
  if (member && name && name !== member.name) {
    member.name = name;
    member.updatedAt = now();
    Promise.resolve(ctx.store.putMember(member));
    changed = true;
  }

  if (!changed) return Promise.resolve(null);
  return Promise.resolve(ctx.store.putConversation(conv)).then(function () {
    emit("conv:changed", { id: convId });
    emit("members-changed", { convId: convId, memberId: member ? member.id : null });
    return conv;
  });
}

/* ------------------------------------------------------------------ 头像 */

/** 尽量用 js/ui/avatar.js 的 renderAvatar（dev-a 在建）；拿不到就回落到 atoms.avatar */
function ensureAvatarApi() {
  if (avatarApi !== null) return Promise.resolve(avatarApi);
  return import("../ui/avatar.js")
    .then(function (m) {
      avatarApi = m || false;
      return avatarApi;
    })
    .catch(function () {
      avatarApi = false;
      return false;
    });
}

/**
 * 画一个会话头头像：有 conv.avatar{label,color,image} 且 renderAvatar 可用时走它，
 * 否则退回 atoms.avatar（同 seed 同渐变）。
 */
/** 当前生效的用户设置（§2.3 的 User）：settings:applied 的 payload 最新，其次 ctx.settings */
function userSettings() {
  return liveSettings || (ctx && ctx.settings) || {};
}

/** 头像底色：唯一权威是 store.resolveAvatarColor(avatar, accent)（显式 color 优先，否则跟随强调色） */
function avatarColorOf(av, accent) {
  if (typeof storeNs.resolveAvatarColor === "function") return storeNs.resolveAvatarColor(av, accent);
  var own = av && av.color;
  return (typeof own === "string" && own) || accent || storeNs.DEFAULT_ACCENT || "#e5e5ea";
}

/** 主题变量清单兜底（正常走 theme.THEME_VARS，这里只在 theme.js 未导出时用） */
var THEME_VARS_FALLBACK = ["--accent", "--accent-soft", "--accent-surface", "--accent-on"];

/**
 * 私聊详情没有任何强调色控件（用户明确要求），但头像底色跟着全局强调色走，
 * 所以这里只把三件套写到卡片根，供头像字色 var(--accent-on) 使用。
 * 派生色一律由 theme.deriveTheme / theme.applyTheme 给，本卡不自己 color-mix。
 */
function paintThemeVars(hex) {
  if (!rootEl) return;
  if (typeof themeNs.applyTheme === "function") {
    themeNs.applyTheme(hex, rootEl);
    return;
  }
  var th = typeof themeNs.deriveTheme === "function" ? themeNs.deriveTheme(hex) : null;
  if (!th) return;
  rootEl.style.setProperty("--accent", th.base);
  rootEl.style.setProperty("--accent-soft", th.soft);
  rootEl.style.setProperty("--accent-surface", th.surface);
  rootEl.style.setProperty("--accent-on", th.on);
}

function clearThemeVars() {
  if (!rootEl) return;
  if (typeof themeNs.clearTheme === "function") {
    themeNs.clearTheme(rootEl);
    return;
  }
  var vars = Array.isArray(themeNs.THEME_VARS) ? themeNs.THEME_VARS : THEME_VARS_FALLBACK;
  for (var i = 0; i < vars.length; i++) rootEl.style.removeProperty(vars[i]);
}

function paintBigAvatar(node) {
  var av = conv && conv.avatar && typeof conv.avatar === "object" ? conv.avatar : null;
  var api = avatarApi;
  if (api && typeof api.renderAvatar === "function" && av) {
    var colored = {
      label: av.label || (conv ? conv.title : ""),
      color: avatarColorOf(av, storeNs.resolveAccent(conv, userSettings())),
      image: av.image
    };
    try {
      api.renderAvatar(node, colored, { size: null });
      return node;
    } catch (e) {
      // 落到下面的回落
    }
  }
  var fallback = avatar({ className: "big-ava", seed: conv ? conv.id : "", name: conv ? conv.title : "" });
  fallback.setAttribute("title", "更换头像");
  if (node && node.parentNode) node.parentNode.replaceChild(fallback, node);
  return fallback;
}

/** 用户改了强调色（settings:applied）→ 不刷新页面，就地重画头像底色 */
function repaintAvatars() {
  if (!panel) return;
  paintThemeVars(storeNs.resolveAccent(conv, userSettings()));
  var big = panel.querySelector(".avatar-block > .big-ava");
  if (big) paintBigAvatar(big);
}

/** 写回本会话的背景设置；「跟随默认」= conv.wallpaper 置 null */
function saveWallpaper(value) {
  if (!conv) return Promise.resolve(null);
  var v = storeNs.WALLPAPERS.indexOf(value) >= 0 ? value : null;
  return Promise.resolve(
    ctx.store.updateConversation(conv.id, { wallpaper: v, touch: false })
  ).then(function () {
    conv.wallpaper = v;
    emit("conv:changed", { id: conv.id });
    emit("wallpaper-changed", { convId: conv.id });
    return conv;
  });
}

/** 自定义背景图已下线：枚举里没有 custom，老 wallpaperDataUrl 由 store 忽略。 */

/* -------------------------------------------------------------- 上下文（§2.6） */

/**
 * 上下文区块：只读展示压缩块 + 未压缩条数，另加「立即压缩 / 清空压缩块」两个动作。
 * 数据全部走 store（listBlocks / listUnfoldedMessages / deleteBlocks），
 * 折叠本身由 js/core/context.js 的 foldOldest 负责，本卡只发起调用，不自己拼上下文。
 */

function toast(text) {
  emit("toast", { text: String(text == null ? "" : text) });
}

/** 压缩块；接口未落地时当空（dev-a 在建 store.listBlocks） */
function listBlocks() {
  var store = ctx && ctx.store;
  if (!store || typeof store.listBlocks !== "function") return Promise.resolve([]);
  return Promise.resolve(store.listBlocks(convId))
    .then(function (list) {
      return Array.isArray(list) ? list : [];
    })
    .catch(function () {
      return [];
    });
}

/** 未压缩的消息（还会原样喂给模型的那批） */
function listUnfolded() {
  var store = ctx && ctx.store;
  if (!store || typeof store.listUnfoldedMessages !== "function") return Promise.resolve([]);
  return Promise.resolve(store.listUnfoldedMessages(convId))
    .then(function (list) {
      return Array.isArray(list) ? list : [];
    })
    .catch(function () {
      return [];
    });
}


function fmtK(tokens) {
  const n = Number(tokens) || 0;
  return n < 1000 ? String(n) : (n / 1000).toFixed(1) + "k";
}

/** 摘要首 60 字；空白压成单空格，超出补 … */
function clip(text, max) {
  var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * 只读全文弹层。atoms 里没有「纯文本只读框」（menu/confirm/prompt 都是输入或列表），
 * 这里用同一套 .modal-mask / .modal / .modal-head / .modal-body / .modal-foot / .btn 结构，
 * 不自创视觉；Esc、点遮罩、点「关闭」都能关。
 */
function openSummaryDialog(title, text) {
  var mask = el("div", "modal-mask");
  var dialog = el("div", "modal");
  dialog.appendChild(el("div", "modal-head", title));
  var body = el("div", "modal-body");
  body.appendChild(el("div", "ctx-summary", text));
  dialog.appendChild(body);
  var foot = el("div", "modal-foot");
  var ok = el("button", "btn", "关闭");
  ok.type = "button";
  foot.appendChild(ok);
  dialog.appendChild(foot);
  mask.appendChild(dialog);

  function close() {
    document.removeEventListener("keydown", onKey);
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  ok.addEventListener("click", close);
  mask.addEventListener("click", function (e) {
    if (e.target === mask) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(mask);
  mask.classList.add("anim-fade-in");
  dialog.classList.add("anim-sheet-in");
}

/** 「立即压缩」：交给 js/core/context.js 的 foldOldest，成功后重画本区块 */
function foldNow(btn, box) {
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "压缩中…";
  var user = userSettings();
  return import("../core/context.js")
    .then(function (mod) {
      if (!mod || typeof mod.foldOldest !== "function") throw new Error("context.js 里没有 foldOldest");
      return mod.foldOldest({
        store: ctx.store,
        conv: conv,
        responder: member || { persona: "" },
        members: member ? [member] : [],
        baseUrl: user.baseUrl,
        model: user.model,
        apiKey: user.apiKey
      });
    })
    .then(function (res) {
      var folded = res && typeof res.folded === "number" ? res.folded : 0;
      if (!folded) {
        toast("没有可压缩的历史");
        return null;
      }
      emit("conv:changed", { id: convId });
      return fillContext(box);
    })
    .catch(function (e) {
      toast("压缩失败：" + errorText(e));
      return null;
    })
    .then(function () {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = label;
      }
      return null;
    });
}

/** 「清空压缩块」：历史原封回上下文，二次确认走 ctx.confirm */
function clearBlocks(box) {
  return Promise.resolve(
    ctx.confirm("清空所有压缩块？历史消息会原封重新进入上下文。", { title: "清空压缩块", danger: true })
  )
    .then(function (ok) {
      if (!ok) return null;
      var store = ctx.store;
      if (!store || typeof store.deleteBlocks !== "function") {
        throw new Error("store 还没有 deleteBlocks");
      }
      return Promise.resolve(store.deleteBlocks(convId)).then(function () {
        emit("conv:changed", { id: convId });
        return fillContext(box);
      });
    })
    .catch(function (e) {
      toast("清空失败：" + errorText(e));
      return null;
    });
}

/** 把「上下文」区块填满；两块都没有时只留一行 .note */
function fillContext(box) {
  if (!box) return Promise.resolve(null);
  box.textContent = "";
  return Promise.all([listBlocks(), listUnfolded()]).then(function (r) {
    var blocks = r[0];
    var unfolded = r[1];
    if (!blocks.length && !unfolded.length) {
      box.appendChild(el("div", "note", "暂无上下文"));
      return null;
    }

    if (blocks.length) {
      var total = 0;
      for (var k = 0; k < blocks.length; k++) {
        total +=
          typeof blocks[k].tokens === "number" ? blocks[k].tokens : estimateTokens(blocks[k].summary);
      }
      box.appendChild(el("label", "lbl", "压缩块（" + blocks.length + " 块 · 约 " + fmtK(total) + "）"));
      blocks.forEach(function (b, i) {
        var no = b.index == null ? i + 1 : b.index;
        var summary = String(b.summary == null ? "" : b.summary);
        var row = el("div", "ctx-block");
        row.setAttribute("data-block-id", b.id == null ? "" : String(b.id));
        row.appendChild(el("span", "idx", String(no)));
        row.appendChild(
          el("span", "range", "原第 " + (b.fromSeq == null ? "?" : b.fromSeq) + "–" + (b.toSeq == null ? "?" : b.toSeq) + " 条")
        );
        row.appendChild(el("span", "sum", clip(summary, 60)));
        row.appendChild(
          el("span", "tk", fmtK(typeof b.tokens === "number" ? b.tokens : estimateTokens(summary)))
        );
        row.addEventListener("click", function () {
          openSummaryDialog("压缩块 " + no, summary);
        });
        box.appendChild(row);
      });
    }

    box.appendChild(el("label", "lbl", "未压缩"));
    box.appendChild(el("div", "note", unfolded.length + " 条 · 约 " + fmtK(estimateMessages(unfolded))));

    var actions = el("div", "ctx-actions");
    var foldBtn = el("button", "btn", "立即压缩");
    foldBtn.type = "button";
    foldBtn.addEventListener("click", function () {
      foldNow(foldBtn, box);
    });
    var clearBtn = el("button", "btn", "清空压缩块");
    clearBtn.type = "button";
    clearBtn.addEventListener("click", function () {
      clearBlocks(box);
    });
    actions.appendChild(foldBtn);
    actions.appendChild(clearBtn);
    box.appendChild(actions);
    return null;
  });
}

/* -------------------------------------------------------------------- 渲染 */

/** 名字就地编辑：.name-text → input，失焦或回车保存，Esc 取消 */
function startNameEdit(nameNode) {
  if (nameEditor || !nameNode || !nameNode.isConnected) return;
  var original = nameNode.textContent;
  var input = document.createElement("input");
  input.type = "text";
  input.className = "name-text";
  input.value = original;
  input.setAttribute("placeholder", "会话名称");
  nameEditor = input;
  nameNode.parentNode.replaceChild(input, nameNode);
  input.focus();
  if (input.setSelectionRange) {
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (e) {
      // 某些 WebView 不支持，忽略
    }
  }

  var finished = false;
  function finish(commit) {
    if (finished) return;
    finished = true;
    nameEditor = null;
    var value = commit ? String(input.value).trim() : original;
    var restored = el("div", "name-text", commit && value ? value : original);
    restored.addEventListener("click", function () {
      startNameEdit(restored);
    });
    if (input.parentNode) input.parentNode.replaceChild(restored, input);
    if (!commit) return;
    saveName(value).then(function () {
      if (!conv || !panel) return null;
      // 标题变了，头像跟着重画（统一走 paintBigAvatar：有 avatar.js 就用 renderAvatar）
      var avaNode = panel.querySelector(".avatar-block > .big-ava");
      paintBigAvatar(avaNode);
      return null;
    });
  }

  input.addEventListener("blur", function () {
    finish(true);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
}

async function renderPanel() {
  var aside = document.createElement("aside");
  aside.className = "phone-win sidebar-right";
  aside.innerHTML = PANEL_TPL;

  await ensureAvatarApi();

  // 顶部返回键：先把未落盘的 textarea 存了再退
  var back = aside.querySelector(".sr-back");
  back.addEventListener("click", function () {
    if (personaTimer) {
      clearTimeout(personaTimer);
      personaTimer = null;
    }
    Promise.resolve(savePersona()).then(function () {
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
    });
  });

  // 大头像：优先 js/ui/avatar.js 的 renderAvatar(conv.avatar)，否则 atoms.avatar
  // 先落主题变量（头像字色要读 --accent-on），再画头像
  paintThemeVars(storeNs.resolveAccent(conv, userSettings()));
  var slot = aside.querySelector(".avatar-block > .big-ava");
  paintBigAvatar(slot);

  // 名字：点击就地改名
  var name = aside.querySelector(".name-center > .name-text");
  name.textContent = conv.title || "";
  name.addEventListener("click", function () {
    startNameEdit(name);
  });

  personaArea = aside.querySelector(".field > textarea");
  if (personaArea) {
    personaArea.value = member && member.persona ? member.persona : "";
    personaArea.addEventListener("input", function () {
      personaDirty = true;
      if (personaTimer) clearTimeout(personaTimer);
      personaTimer = setTimeout(function () {
        personaTimer = null;
        savePersona();
      }, 500);
    });
  }

  // 壁纸：跟随默认 + 3 个枚举值（跑 store.resolveWallpaper 判有效值，不要再加「自定义」）
  selectEl = aside.querySelector(".field > select");
  var effective = storeNs.resolveWallpaper(conv, userSettings());
  selectEl.value = conv.wallpaper == null ? "default" : effective;
  selectEl.addEventListener("change", function () {
    Promise.resolve(saveWallpaper(selectEl.value)).then(function () {
      return null;
    });
  });

  // 上下文区块（§2.6 可见性）：放在所有字段之后
  await fillContext(aside.querySelector('.field[data-role="ctx"]'));
  return aside;
}

function renderEmpty(message) {
  var box = el("div", "empty-tip", message || "会话不存在或已被删除");
  return box;
}

async function render() {
  if (!rootEl) return Promise.resolve(null);
  rootEl.textContent = "";
  personaArea = null;
  selectEl = null;

  if (!conv) {
    panel = null;
    rootEl.appendChild(renderEmpty());
    return Promise.resolve(null);
  }

  panel = await renderPanel();
  rootEl.appendChild(panel);
  return Promise.resolve(null);
}

/* ------------------------------------------------------------- 生命周期 */

var card = {
  id: CARD_ID,
  title: "私聊详情",

  async mount(root, context) {
    rootEl = root;
    ctx = context;
    mounted = true;

    // Esc = 返回；卸载时移除
    escHandler = function (e) {
      if (e.key !== "Escape") return;
      if (nameEditor) return; // 名字编辑中，Esc 交给输入框自己处理
      if (document.querySelector(".modal-mask")) return; // 弹层开着，先关弹层
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
    };
    document.addEventListener("keydown", escHandler);

    // 用户改强调色 → 头像底色就地重画（不刷新页面）；卸载时退订
    if (ctx.events && typeof ctx.events.on === "function") {
      settingsOff = ctx.events.on("settings:applied", function () {
        repaintAvatars();
      });
      // 模型改了自己（名字 / 人格 / 头像 / 壁纸）→ 重读库再重画
      profileOff = ctx.events.on("profile:changed", function (p) {
        if (p && p.convId && p.convId !== convId) return;
        refreshFromStore();
      });
    }

    // shell 可能先 mount 再 onEnter，也可能带 params 直接 mount；两种都兜住
    if (convId) {
      await load();
      await render();
    }
  },

  async unmount() {
    mounted = false;
    if (typeof settingsOff === "function") {
      settingsOff();
      settingsOff = null;
    }
    if (typeof profileOff === "function") {
      profileOff();
      profileOff = null;
    }
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    if (personaTimer) {
      clearTimeout(personaTimer);
      personaTimer = null;
    }
    // 未落盘的改动先 flush，避免卸载丢字
    await savePersona();
    personaArea = null;
    nameEditor = null;
    panel = null;
    selectEl = null;
    clearThemeVars();
    rootEl = null;
    ctx = null;
  },

  async onEnter(params) {
    var p = params || {};
    convId = p.convId || p.id || null;
    if (!convId) {
      conv = null;
      member = null;
      if (mounted) await render();
      return;
    }
    if (!mounted) return; // 等 mount 补渲染
    await load();
    await render();
  },

  async onLeave() {
    if (personaTimer) {
      clearTimeout(personaTimer);
      personaTimer = null;
    }
    await savePersona();
  }
};

export default card;
