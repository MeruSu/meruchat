/**
 * MeruChat 卡片：群聊详情（detail-group）
 *
 * DOM 与文字**逐字照搬** `C:\Meru\website\su\preview\styles.html` 第 833-869 行
 * （用户 2026-11-24 原话：「群聊详情页也照搬之前的第三页 然后多一个成员头像表就行
 * 就像那个 GitHub 那个贡献头像表单一样 一堆头像堆在那里就行了」）。
 * 与第三页的差异只有四处，其余 class / 元素一个都不增删：
 *   1. 第三页那一整块「主题色」色板（.swatches / .sw）不照搬，改成下面第 4 条的 .seg 主题色行
 *   2. 壁纸 <select> 选项换成 跟随默认 + 3 个枚举值（极光 aurora / 深绿 forest / 暮紫 dusk），
 *      不要「自定义」、不要上传图片
 *   3. 在「设定 / 人格」的位置换成**公告板**（群聊没有「成员自己的设定」，那块归群），
 *      随后接成员墙：.section-title 成员 + .member-grid > .m-ava
 *   4. 文字部分（群名 / 公告 / 成员首字）来自 store
 *   5. 壁纸下方加一行「主题色」（.seg：跟随默认 + 色块，色值取自 store.ACCENT_COLORS）：
 *      选中写 conv.accent 并发 conv:changed；气泡由聊天卡按卡片根 --accent 派生，本卡不碰气泡
 *
 * 公告板落在 `conversations[i].announcement`（"写在这里的话所有成员都看得到"）：
 * 群聊页面顺序 = 头像 → 群名 → 公告板 → 成员墙 → 聊天背景。
 *
 * 成员墙只有头像，没有行内文字按钮；成员的「改名与人格 / 移除」「添加成员」挂在
 * 头像点击（ctx.openSheet 弹层）和「成员」小标题点击上，这样 DOM 与第三页保持一致。
 * 视觉由 css/style-kit.css + css/theme.css + css/card-detail.css 提供，本文件不写其它内联样式。
 */

import { avatar, confirmDialog, memberEditDialog, promptDialog } from "../ui/atoms.js";
import * as storeNs from "../core/store.js";
import * as themeNs from "../core/theme.js";
import { estimateMessages, estimateTokens } from "../core/context.js";
import { el, errorText, now } from "../core/util.js";

var CARD_ID = "detail-group";

/**
 * 色名只用于文案；色值本身来自 store.ACCENT_COLORS（唯一来源，别处不另抄一份）。
 * 默认色已从白 `#ffffff` 换成浅灰 `#e5e5ea`；两条键都留着，dev-a 改 store 前后都能出名字。
 */
var ACCENT_LABELS = {
  "#e5e5ea": "灰",
  "#ffffff": "灰",
  "#0075de": "蓝",
  "#00a884": "绿",
  "#7c5cff": "紫",
  "#d97757": "橙"
};

/** 模块级状态（同一时刻只有一张 detail-group 实例） */
var rootEl = null;
var ctx = null;
var convId = null;
var conv = null;
var members = [];
var mounted = false;
var nameEditor = null;
var escHandler = null;
var busy = false; // 弹层/保存进行中，挡住重复点击
var panel = null; // <aside class="phone-win sidebar-right">
var selectEl = null;
var boardArea = null; // 公告板 textarea
var boardTimer = null;
var boardDirty = false;
var avatarApi = null; // js/ui/avatar.js（dev-a 在建）；false = 探测过但不存在
var settingsOff = null; // settings:applied 的退订函数
var profileOff = null; // profile:changed 的退订函数（模型改了自己 → 就地重画）

/* ------------------------------------------------------------------ 广播 */

function emit(name, payload) {
  try {
    if (ctx && ctx.events && typeof ctx.events.emit === "function") {
      ctx.events.emit(name, payload || {});
    }
  } catch (e) {
    // 广播失败不影响已经落库的数据
  }
}

/** 出错时给一句轻提示（壳在监听 toast），不吞静默失败 */
function toastError(e) {
  emit("toast", { text: errorText(e) });
}

/* -------------------------------------------------------------- 数据读写 */

function load() {
  if (!convId) return Promise.resolve(false);
  // 用户设置快照：ctx.settings 由 shell 维护，这里只读取最新的一份
  liveSettings = (ctx && ctx.settings) || liveSettings;
  return Promise.resolve(ctx.store.getConversation(convId)).then(function (c) {
    conv = c || null;
    if (!conv) return false;
    // 公告板是后加的字段，老数据没有这个键 → 读的时候就地补 ""（不新造表）
    if (typeof conv.announcement !== "string") conv.announcement = "";
    return Promise.resolve(ctx.store.listMembers(convId)).then(function (list) {
      members = list || [];
      return true;
    });
  });
}

/** 保存群名（只改会话标题，成员名不动） */
function saveTitle(raw) {
  if (!conv) return Promise.resolve(null);
  var title = String(raw == null ? "" : raw).trim();
  if (!title || title === conv.title) return Promise.resolve(null);
  conv.title = title;
  conv.updatedAt = now();
  return Promise.resolve(ctx.store.putConversation(conv)).then(function () {
    emit("conv:changed", { id: convId });
    return conv;
  });
}

function saveMember(patch) {
  var target = null;
  for (var i = 0; i < members.length; i++) {
    if (members[i].id === patch.id) {
      target = members[i];
      break;
    }
  }
  if (!target) return Promise.resolve(null);

  if (patch.name != null) target.name = String(patch.name).trim() || target.name;
  if (patch.persona != null) target.persona = String(patch.persona);
  // 成员主题色：null = 跟随用户默认；只在调用方明确传了才有动作
  if (patch.accent !== undefined) {
    target.accent = patch.accent == null || patch.accent === "" ? null : String(patch.accent);
  }
  target.updatedAt = now();
  return Promise.resolve(ctx.store.putMember(target)).then(function () {
    emit("members-changed", { convId: convId, memberId: target.id });
    // 聊天卡按成员主题色重绘该成员的气泡，靠这一个事件
    emit("conv:changed", { id: convId });
    return target;
  });
}

/** 公告板：写到 conversations[i].announcement（群里所有成员都看得到） */
function saveAnnouncement() {
  if (!conv || !boardDirty || !boardArea) return Promise.resolve(null);
  boardDirty = false;
  var text = String(boardArea.value == null ? "" : boardArea.value);
  return Promise.resolve(
    ctx.store.updateConversation(conv.id, { announcement: text, touch: false })
  ).then(function () {
    conv.announcement = text;
    emit("conv:changed", { id: conv.id });
    emit("announcement-changed", { convId: conv.id, announcement: text });
    return text;
  });
}

function togglePin() {
  if (!conv) return Promise.resolve(null);
  var nextPinned = !conv.pinned;
  return Promise.resolve(ctx.store.setPinned(conv.id, nextPinned)).then(function () {
    conv.pinned = nextPinned;
    emit("conv:changed", { id: conv.id });
    return rerender();
  });
}

function removeGroup() {
  if (!conv) return Promise.resolve(null);
  var id = conv.id;
  var title = conv.title || "这个群聊";
  return confirmDialog({
    title: "删除群聊",
    message: "「" + title + "」及其中所有成员与消息都会被永久删除。此操作不可撤销。",
    danger: true,
    okText: "删除"
  }).then(function (ok) {
    if (!ok) return null;
    return Promise.resolve(ctx.store.deleteConversation(id)).then(function () {
      emit("conv:changed", { id: id });
      emit("conversation-removed", { convId: id });
      conv = null;
      members = [];
      convId = null;
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
      return null;
    });
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

/** 画会话头像：有 conv.avatar{label,color,image} 且 renderAvatar 可用时走它，否则 atoms.avatar */
/** 头像底色：唯一权威是 store.resolveAvatarColor(avatar, accent)（显式 color 优先，否则跟随主题色） */
function avatarColorOf(av, accent) {
  if (typeof storeNs.resolveAvatarColor === "function") return storeNs.resolveAvatarColor(av, accent);
  var own = av && av.color;
  return (typeof own === "string" && own) || accent || storeNs.DEFAULT_ACCENT || "#e5e5ea";
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

/**
 * 成员头像：成员对象上的 avatar 可能是字符串（老数据）或 {label,color,image}（新结构）。
 * 底色唯一权威是 store.resolveAvatarColor(avatar, resolveMemberAccent(member, user))，
 * 这样成员自己挑的主题色能直接在头像上看出来；renderAvatar 不在时按同一份结果就地兜底。
 */
function paintMemberAvatar(node, m) {
  var raw = m ? m.avatar : null;
  var av = raw && typeof raw === "object" ? raw : null;
  var label = (av && av.label) || (m ? m.name : "") || "";
  var colored = {
    label: label,
    color: avatarColorOf(av, effectiveMemberAccent(m)),
    image: av && av.image
  };
  var api = avatarApi;
  if (api && typeof api.renderAvatar === "function") {
    try {
      api.renderAvatar(node, colored, { size: 34 });
      return true;
    } catch (e) {
      // 落到下面的兜底
    }
  }
  // 兜底：没有 renderAvatar 也要让成员色可见（首字 + 底色）
  if (!node) return false;
  node.textContent = Array.from(String(label))[0] || "?";
  node.style.backgroundColor = colored.color;
  node.style.backgroundImage = "";
  return true;
}

/** 用户改了主题色（settings:applied）→ 不刷新页面，就地重画群头像与成员头像 */
function repaintAvatars() {
  if (!panel) return;
  var big = panel.querySelector(".avatar-block > .big-ava");
  if (big) paintBigAvatar(big);
  var nodes = panel.querySelectorAll(".member-grid .m-ava");
  for (var i = 0; i < nodes.length; i++) {
    var m = members[i];
    if (!m) continue;
    paintMemberAvatar(nodes[i], m);
    markMemberAccent(nodes[i], m);
  }
  paintAccent(effectiveAccent());
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

/* --------------------------------------------------------------- 主题色 */

/** 这个会话生效的主题色：唯一权威是 store.resolveAccent(conv, user)，本卡不做任何自造回落 */
function effectiveAccent() {
  return storeNs.resolveAccent(conv, userSettings());
}

/** 主题变量清单兜底（正常走 theme.THEME_VARS，这里只在 theme.js 未导出时用） */
var THEME_VARS_FALLBACK = ["--accent", "--accent-soft", "--accent-surface", "--accent-on", "--send-bg"];

/**
 * 主题色落到卡片根：一个主题 = 三件套，全部由 theme.deriveTheme(hex) 算（经 theme.applyTheme
 * 一次落五个变量），本卡不自己 color-mix、不写死任何派生色。
 */
function paintAccent(hex) {
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
  rootEl.style.setProperty("--send-bg", th.base);
}

/** 卸载时把卡片根上的主题变量全部摘掉，不污染其它卡片（清单以 theme.THEME_VARS 为准） */
function clearAccent() {
  if (!rootEl) return;
  if (typeof themeNs.clearTheme === "function") {
    themeNs.clearTheme(rootEl);
    return;
  }
  var vars = Array.isArray(themeNs.THEME_VARS) ? themeNs.THEME_VARS : THEME_VARS_FALLBACK;
  for (var i = 0; i < vars.length; i++) rootEl.style.removeProperty(vars[i]);
}

/** 「跟随默认」= conv.accent 置 null；改完发 conv:changed */
function saveAccent(value) {
  if (!conv) return Promise.resolve(null);
  var v = value ? String(value) : null;
  return Promise.resolve(ctx.store.updateConversation(conv.id, { accent: v, touch: false })).then(function () {
    conv.accent = v;
    paintAccent(effectiveAccent());
    emit("conv:changed", { id: conv.id });
    return conv;
  });
}

/** 选中态：conv.accent 为 null 时高亮「跟随默认」 */
function markAccent(seg, activeValue) {
  if (!seg) return;
  var btns = seg.querySelectorAll("button");
  for (var i = 0; i < btns.length; i++) {
    var isDefault = btns[i].hasAttribute("data-accent-default");
    var want = activeValue ? btns[i].getAttribute("data-accent") === activeValue : isDefault;
    btns[i].classList.toggle("active", !!want);
  }
}

/* ----------------------------------------------------------- 成员主题色 */

/**
 * 当前生效的用户设置（§2.3 的 User）。settings:applied 的 payload 是最新的，
 * 比 ctx.settings 快一步（ctx.settings 由 shell 更新，事件里带的就是同一份）。
 */
var liveSettings = null;

function userSettings() {
  return liveSettings || (ctx && ctx.settings) || {};
}

/**
 * 成员自己的主题色（群聊里「谁说的消息就用谁的气泡色」）。
 * 唯一权威是 store.resolveMemberAccent(member, user)；dev-a 尚未落地时按
 * §2.3 同一套语义就地算：member.accent → user.accent → store.DEFAULT_ACCENT。
 */
function effectiveMemberAccent(m) {
  if (typeof storeNs.resolveMemberAccent === "function") {
    return storeNs.resolveMemberAccent(m, userSettings());
  }
  var own = m && m.accent;
  if (typeof own === "string" && own) return own;
  var fallback = userSettings().accent;
  if (typeof fallback === "string" && fallback) return fallback;
  return storeNs.DEFAULT_ACCENT || "#e5e5ea";
}

/**
 * 成员头像上的颜色标记：**不画描边**（用户 2026-11-24 定：发丝描边全部作废）。
 * 成员自己的色靠头像底色承担，这里只把 data-accent 打上，供选择器与验收读取。
 */
function markMemberAccent(node, m) {
  if (!node || !node.getAttribute) return null;
  var own = m && typeof m.accent === "string" && m.accent ? m.accent : null;
  node.setAttribute("data-accent", own || "default");
  return own;
}

/* --------------------------------------------------------------- 成员编辑 */

/** 点头像：名字 + 人格 + 主题色写在一张弹层里（atoms.memberEditDialog），取消即止。 */
function editMember(m) {
  if (!m || busy) return Promise.resolve(null);
  busy = true;
  return memberEditDialog({
    title: "编辑成员",
    name: m.name || "",
    persona: m.persona || "",
    accent: m.accent == null ? null : String(m.accent),
    accentColors: storeNs.ACCENT_COLORS,
    accentLabels: ACCENT_LABELS,
    mount: rootEl
  })
    .then(function (r) {
      if (!r) return null;
      return saveMember({
        id: m.id,
        name: r.name,
        persona: r.persona,
        accent: r.accent == null ? null : String(r.accent)
      }).then(rerender);
    })
    .then(function (r) {
      busy = false;
      return r;
    })
    .catch(function (e) {
      busy = false;
      toastError(e);
      return null;
    });
}

function deleteMemberConfirm(m) {
  if (!m || busy) return Promise.resolve(null);
  var isLast = members.length <= 1;
  busy = true;
  return confirmDialog({
    title: "从群里移除",
    message: isLast
      ? "「" + (m.name || "该成员") + "」是这个群聊里唯一的成员，移出后群里就没有可以对话的人了。只会把他从这个群里移出，他自己的会话还在。"
      : "从群里移除「" + (m.name || "该成员") + "」？只会把他从这个群里移出，他自己的会话还在。",
    danger: true,
    okText: "移除"
  })
    .then(function (ok) {
      if (!ok) return null;
      // §2.8：群成员是已有私聊会话的引用，只摘引用；deleteMember 会删身份行（等于把这个 AI 整个删掉），只做老库兜底
      var drop = typeof ctx.store.removeGroupMember === "function"
        ? function () { return ctx.store.removeGroupMember(convId, m.id); }
        : function () { return ctx.store.deleteMember(m.id); };
      return Promise.resolve(drop()).then(function () {
        members = members.filter(function (x) {
          return x.id !== m.id;
        });
        emit("members-changed", { convId: convId, memberId: m.id, removed: true });
        return rerender();
      });
    })
    .then(function (r) {
      busy = false;
      return r;
    })
    .catch(function (e) {
      busy = false;
      toastError(e);
      return null;
    });
}

function addMemberFlow() {
  if (busy || !conv) return Promise.resolve(null);
  busy = true;
  return promptDialog({
    title: "添加成员",
    value: "",
    placeholder: "成员名字"
  })
    .then(function (name) {
      if (name == null || !String(name).trim()) return null;
      return promptDialog({
        title: "成员人格设定",
        value: "",
        placeholder: "描述这个成员怎么说话（可留空）"
      }).then(function (persona) {
        var data = { name: String(name).trim(), persona: persona == null ? "" : String(persona) };
        return Promise.resolve(ctx.store.addMember(convId, data))
          .then(function () {
            emit("members-changed", { convId: convId, added: true });
            return load();
          })
          .then(rerender);
      });
    })
    .then(function (r) {
      busy = false;
      return r;
    })
    .catch(function (e) {
      busy = false;
      toastError(e);
      return null;
    });
}

/** 点头像弹出的菜单：改名/人格、移除（成员墙里没有行内按钮，入口收在这里） */
function openMemberSheet(m) {
  if (!m || busy) return Promise.resolve(null);
  return Promise.resolve(
    ctx.openSheet([
      { key: "edit", label: "改名字 / 人格 / 主题色" },
      { key: "remove", label: "从群聊移除", danger: true }
    ])
  ).then(function (key) {
    if (key === "edit") return editMember(m);
    if (key === "remove") return deleteMemberConfirm(m);
    return null;
  });
}

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
        responder: members[0] || { persona: "" },
        members: members,
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

/** styles.html 833-869 行的结构，逐字照搬；只去掉「主题色」色板块、换壁纸选项、加主题色 .seg 行 */

/** 主题色行：跟随默认 + 4 个色块（与壁纸同一套 .seg 形态；色值来自 store.ACCENT_COLORS） */
function accentButtonsHtml() {
  var out = ['      <button type="button" data-accent-default="1">跟随默认</button>'];
  storeNs.ACCENT_COLORS.forEach(function (hex) {
    var name = ACCENT_LABELS[hex] || hex;
    out.push(
      '      <button type="button" data-accent="' + hex + '" title="' + name + '">' +
        '<i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' +
        hex +
        ';margin-right:6px;vertical-align:-1px"></i>' +
        name +
        "</button>"
    );
  });
  return out.join("\n");
}
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
  '    <label class="lbl">公告板</label>',
  '    <textarea rows="4" placeholder="写在这里的话所有成员都看得到"></textarea>',
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
  '  <div class="field">',
  '    <label class="lbl">主题色</label>',
  '    <div class="seg" data-role="accent">',
  accentButtonsHtml(),
  "    </div>",
  "  </div>",
  '  <div class="section-title">上下文</div>',
  '  <div class="field" data-role="ctx"></div>',
  "</div>"
].join("\n");

/** 群名就地编辑 */
function startTitleEdit(titleNode) {
  if (nameEditor || !titleNode || !titleNode.isConnected) return;
  var original = titleNode.textContent;
  var input = document.createElement("input");
  input.type = "text";
  input.className = "name-text";
  input.value = original;
  input.setAttribute("placeholder", "群聊名称");
  nameEditor = input;
  titleNode.parentNode.replaceChild(input, titleNode);
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
      startTitleEdit(restored);
    });
    if (input.parentNode) input.parentNode.replaceChild(restored, input);
    if (commit) saveTitle(value);
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

/** 成员墙：像 GitHub 贡献格子一样一堆头像堆着（用户原话） */
function buildMemberWall() {
  var title = el("div", "section-title", "成员");
  title.setAttribute("title", "点这里添加成员");
  title.addEventListener("click", function () {
    addMemberFlow();
  });

  var grid = el("div", "member-grid");
  members.forEach(function (m) {
    var node = avatar({ className: "m-ava", seed: m.id || m.name, name: m.name });
    // 有 js/ui/avatar.js 的 renderAvatar 就交给它；没有时沿用 atoms 的 data-av-grad 色板兜底
    if (!paintMemberAvatar(node, m)) {
      var grad = String(node.dataset.avGrad || "").split(",");
      if (grad.length === 2) {
        node.style.background = "linear-gradient(135deg," + grad[0] + "," + grad[1] + ")";
      }
    }
    node.addEventListener("click", function () {
      openMemberSheet(m);
    });
    // 当前主题色用头像描边示意（null = 跟随默认，不画）
    markMemberAccent(node, m);
    grid.appendChild(node);
  });

  return [title, grid];
}

async function renderPanel() {
  var aside = document.createElement("aside");
  aside.className = "phone-win sidebar-right";
  aside.innerHTML = PANEL_TPL;

  await ensureAvatarApi();

  // 顶部返回键：公告板未落盘的改动先 flush 再退
  var back = aside.querySelector(".sr-back");
  back.addEventListener("click", function () {
    if (boardTimer) {
      clearTimeout(boardTimer);
      boardTimer = null;
    }
    Promise.resolve(saveAnnouncement()).then(function () {
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
    });
  });

  // 大头像：优先 js/ui/avatar.js 的 renderAvatar(conv.avatar)，否则 atoms.avatar
  var slot = aside.querySelector(".avatar-block > .big-ava");
  paintBigAvatar(slot);

  // 群名：点击就地改名
  var name = aside.querySelector(".name-center > .name-text");
  name.textContent = conv.title || "";
  name.setAttribute("title", "点击重命名群聊");
  name.addEventListener("click", function () {
    startTitleEdit(name);
  });

  boardArea = aside.querySelector(".field > textarea");
  if (boardArea) {
    boardArea.value = typeof conv.announcement === "string" ? conv.announcement : "";
    boardArea.setAttribute("placeholder", "写在这里的话所有成员都看得到");
    boardArea.addEventListener("input", function () {
      boardDirty = true;
      if (boardTimer) clearTimeout(boardTimer);
      boardTimer = setTimeout(function () {
        boardTimer = null;
        saveAnnouncement();
      }, 500);
    });
  }

  // 成员墙：插在「外观」小标题之前（点名叫「外观」的那一块，别插错位置）
  var appearance = null;
  var titles = aside.querySelectorAll(".section-title");
  for (var i = 0; i < titles.length; i++) {
    if (String(titles[i].textContent).trim() === "外观") {
      appearance = titles[i];
      break;
    }
  }
  var wall = buildMemberWall();
  if (appearance && appearance.parentNode) {
    appearance.parentNode.insertBefore(wall[1], appearance);
    appearance.parentNode.insertBefore(wall[0], wall[1]);
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

  // 主题色：跟随默认 + 4 个色块（.seg；解析走 store.resolveAccent）
  var accentSeg = aside.querySelector('.seg[data-role="accent"]');
  paintAccent(effectiveAccent());
  markAccent(accentSeg, conv.accent == null ? null : conv.accent);
  if (accentSeg) {
    accentSeg.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!btn || !accentSeg.contains(btn)) return;
      var next = btn.hasAttribute("data-accent-default") ? null : btn.getAttribute("data-accent");
      Promise.resolve(saveAccent(next)).then(function () {
        markAccent(accentSeg, conv.accent == null ? null : conv.accent);
      });
    });
  }

  // 上下文区块（§2.6 可见性）：放最末尾（成员墙在「外观」之前，这里在所有字段之后）
  await fillContext(aside.querySelector('.field[data-role="ctx"]'));
  return aside;
}

/** 模型通过 set_name / set_persona / set_look 改了自己 → 重读库再重画。
 *  正在编辑群名或成员名、公告板有未落盘改动时不重画，免得冲掉用户没存的内容。
 *  返回 Promise<null>，调用方不必 await（事件回调是同步的）。 */
function refreshFromStore() {
  if (!mounted || nameEditor || boardDirty) return Promise.resolve(null);
  return load().then(function (ok) {
    return ok ? render() : null;
  });
}

function rerender() {
  if (!mounted) return Promise.resolve(null);
  return render();
}

async function render() {
  if (!rootEl) return Promise.resolve(null);
  rootEl.textContent = "";
  boardArea = null;
  selectEl = null;

  if (!conv) {
    panel = null;
    rootEl.appendChild(el("div", "empty-tip", "群聊不存在或已被删除"));
    return Promise.resolve(null);
  }

  panel = await renderPanel();
  rootEl.appendChild(panel);
  return Promise.resolve(null);
}

/* ------------------------------------------------------------- 生命周期 */

var card = {
  id: CARD_ID,
  title: "群聊详情",

  async mount(root, context) {
    rootEl = root;
    ctx = context;
    mounted = true;

    escHandler = function (e) {
      if (e.key !== "Escape") return;
      if (nameEditor) return;
      if (document.querySelector(".modal-mask")) return;
      if (ctx.router && typeof ctx.router.back === "function") ctx.router.back();
    };
    document.addEventListener("keydown", escHandler);

    // 用户改主题色 → 头像底色就地重画（不刷新页面）；卸载时退订
    if (ctx.events && typeof ctx.events.on === "function") {
      settingsOff = ctx.events.on("settings:applied", function (s) {
        liveSettings = s && typeof s === "object" ? s : ctx.settings;
        repaintAvatars();
      });
      // 模型改了自己（名字 / 人格 / 头像 / 壁纸）→ 重读库再重画
      profileOff = ctx.events.on("profile:changed", function (p) {
        if (p && p.convId && p.convId !== convId) return;
        refreshFromStore();
      });
    }

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
    if (boardTimer) {
      clearTimeout(boardTimer);
      boardTimer = null;
    }
    await saveAnnouncement();
    boardArea = null;
    nameEditor = null;
    panel = null;
    selectEl = null;
    clearAccent();
    rootEl = null;
    ctx = null;
  },

  async onEnter(params) {
    var p = params || {};
    convId = p.convId || p.id || null;
    if (!convId) {
      conv = null;
      members = [];
      if (mounted) await render();
      return;
    }
    if (!mounted) return;
    await load();
    await render();
  },

  async onLeave() {
    if (boardTimer) {
      clearTimeout(boardTimer);
      boardTimer = null;
    }
    await saveAnnouncement();
    boardArea = null;
  }
};

export default card;
