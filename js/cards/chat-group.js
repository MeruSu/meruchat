// 卡片：chat-group（群聊会话页，>=2 个成员）
// 外壳与 chat-direct.js 同构（styles.html 753-829 行），顶栏走共用组件 js/ui/chat-head.js，只多两处群聊特征：
//   1) 两侧都放 .msg-ava 头像（对方在气泡左侧、自己在气泡右侧，同一套 36px 样式）
//   2) 名字在气泡外面：.msg-col 里的 <span class="who-name">名字</span>（两侧都有）
// 样式全部来自 css/style-kit.css，本卡片只有 card-chat.css 里的群聊专属规则。
import { chatHead } from "../ui/chat-head.js";
import { openConvMenu } from "../ui/conv-menu.js";
import { el, errorText, now, uid } from "../core/util.js";
import * as storeModule from "../core/store.js";
import { runAgent, recoverStreaming } from "../core/agent.js";
import { createTools } from "../core/tools/index.js";
import {
  FIRST_BYTE_MS,
  HALT_AFTER_FAILURES,
  SILENT_TOKEN,
  TOTAL_MS,
  isSilent,
  memberSystemPrompt,
  nextSeq,
  orderMembers,
  planQueue,
  stripEnd,
  unrepliedLine,
} from "../core/group.js";
// Billion Context：拼上下文与折叠的唯一实现点（DEV.md §2.6）。卡片只调用，不自己拼。
import { buildContext, foldOldest } from "../core/context.js";
// 壁纸只有一个口径：store.js 解析、theme.js 落 DOM；本卡不写内联背景
import { resolveWallpaper } from "../core/store.js";
import { applyWallpaperLayer } from "../core/theme.js";
import * as themeNs from "../core/theme.js";
// 头像字色（含浅色底的描边）唯一实现在 js/ui/avatar.js，换底色时必须跟着重算
import { applyAvatarInk } from "../ui/avatar.js";

/** 用户自己的身份：唯一来源是 core/store.js 的 getSelf()（dev-a 提供，改设置里的名字会自动变）。
 *  用命名空间 import 是为了在 dev-a 的导出还没落地时也不至于整张卡加载失败；
 *  取首字母的逻辑一律不在这里实现，缺导出时只回落到「我」。 */
function selfIdentity() {
  if (typeof storeModule.getSelf === "function") {
    const self = storeModule.getSelf();
    if (self && self.name) {
      return { name: String(self.name), initial: String(self.initial || self.name.slice(0, 1)) };
    }
  }
  return { name: "我", initial: "我" };
}

/** 头像不再用 6 组随机渐变：谁的颜色必须与成员墙、气泡一致（见 msgAva / paintSelfAva） */

/** 只认真正的颜色串：老数据/预览 mock 里的 "notion" 这类皮名字必须挡掉，
 *  否则 --accent 是非法值，气泡底色会整条作废。 */
function isColor(v) {
  return (
    typeof v === "string" &&
    (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v.trim()) || /^(rgb|hsl)a?\(/i.test(v.trim()))
  );
}

/** 默认主题色：浅灰（白色主题整套下线后用户定的默认值，与 store.DEFAULT_ACCENT 同值）。
 *  浅灰的 soft 与白卡面有色差，气泡边界靠色差立住，不画线。 */
const DEFAULT_ACCENT = "#e5e5ea";

/** 会话自己的主题色：store.resolveAccent 是唯一口径；还没落地时按「会话色 → 全局色 → 默认」回落 */
function resolveAccent(conv, settings) {
  if (typeof storeModule.resolveAccent === "function") {
    const a = storeModule.resolveAccent(conv, settings);
    if (isColor(a)) return a;
  }
  const own = conv && conv.accent;
  if (isColor(own)) return own;
  const dflt = settings && settings.accent;
  if (isColor(dflt)) return dflt;
  return DEFAULT_ACCENT;
}

/** 成员自己的主题色：member.accent > user.accent > 默认白（null/缺失都跟随用户） */
function resolveMemberAccent(member, settings) {
  if (typeof storeModule.resolveMemberAccent === "function") {
    const a = storeModule.resolveMemberAccent(member, settings);
    if (isColor(a)) return a;
  }
  const own = member && member.accent;
  if (isColor(own)) return own;
  const dflt = settings && settings.accent;
  if (isColor(dflt)) return dflt;
  return DEFAULT_ACCENT;
}

/** 把 #abc / #aabbcc / rgb(...) 统一成小写全写 hex；解析不了返回 "" */
function toHex(value) {
  const v = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  if (/^#[0-9a-f]{4}$/.test(v)) return "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  const m = v.match(/^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)/);
  if (!m) return "";
  const hex = (t) => {
    const n = t.indexOf("%") >= 0 ? (parseFloat(t) * 255) / 100 : parseFloat(t);
    const i = Math.max(0, Math.min(255, Math.round(n || 0)));
    return i.toString(16).padStart(2, "0");
  };
  return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
}

/** 顶栏头像：有自定义图用图，有头像色用头像色，否则用会话主题色（dev-a 的 store.resolveAvatarColor 是唯一口径） */
function resolveAvaColor(conv, settings) {
  const theme = resolveAccent(conv, settings);
  if (typeof storeModule.resolveAvatarColor === "function") {
    const c = storeModule.resolveAvatarColor(conv && conv.avatar, theme);
    if (isColor(c)) return c;
  }
  const own = conv && conv.avatar && conv.avatar.color;
  if (isColor(own)) return own;
  return theme;
}

/** 成员头像底色：与详情卡成员墙同一口径（member.avatar 优先，否则成员主题色） */
function resolveMemberAvaColor(member, accent) {
  if (typeof storeModule.resolveAvatarColor === "function") {
    const c = storeModule.resolveAvatarColor(member && member.avatar, accent);
    if (isColor(c)) return c;
  }
  const own = member && member.avatar && member.avatar.color;
  if (isColor(own)) return own;
  return accent;
}

/** 发送键只跟用户的全局主题色走，与会话无关 */
function resolveSendAccent(settings) {
  const a = settings && settings.accent;
  return isColor(a) ? a : DEFAULT_ACCENT;
}

/** 气泡的唯一取色口径：自己的消息用 user.accent，成员的消息用 member.accent（null 跟随用户）。
 *  只写 --accent，不写背景色，由 css/card-chat.css 派生。 */
function accentForMessage(msg, members, settings) {
  if (!msg || msg.role === "user") return resolveAccent(null, settings);
  const member = (members || []).find((m) => m && m.id === msg.memberId);
  return member ? resolveMemberAccent(member, settings) : resolveAccent(null, settings);
}

/** 本色 → 三件套。theme.js 的 deriveTheme 是唯一口径；还没落地时按同一套算法就地算：
 *  浅色版 = 本色与白按 45% 混（与 theme.js 的 SOFT_ACCENT_WEIGHT 同值），
 *  surface = 3% 本色，压在本色上的字按亮度选深/浅。 */
function themeOf(base) {
  const a = isColor(base) ? base : DEFAULT_ACCENT;
  if (typeof themeNs.deriveTheme === "function") {
    try {
      const th = themeNs.deriveTheme(a);
      if (th && isColor(th.base)) {
        return {
          base: th.base,
          soft: isColor(th.soft) ? th.soft : a,
          surface: isColor(th.surface) ? th.surface : "#ffffff",
          on: isColor(th.on) ? th.on : "#ffffff",
        };
      }
    } catch (e) {
      /* 落到下面的兜底 */
    }
  }
  const rgb = toHex(a);
  const r = parseInt(rgb.slice(1, 3), 16);
  const g = parseInt(rgb.slice(3, 5), 16);
  const b = parseInt(rgb.slice(5, 7), 16);
  const mix = (c, w) => Math.round(c * w + 255 * (1 - w)).toString(16).padStart(2, "0");
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    base: a,
    soft: "#" + mix(r, 0.45) + mix(g, 0.45) + mix(b, 0.45),
    surface: "#" + mix(r, 0.03) + mix(g, 0.03) + mix(b, 0.03),
    on: lum > 0.6 ? "#1c1c1e" : "#ffffff",
  };
}

/** 把取色结果落到气泡上：两件套写到气泡自己身上，底色由 CSS 读 --accent-soft。
 *  不加 data-plain、不加描边：浅灰主题的 soft 与白卡面有色差，边界靠色差立住。 */
function paintBubble(bubbleEl, accent) {
  if (!bubbleEl) return;
  const th = themeOf(accent);
  bubbleEl.style.setProperty("--accent", th.base);
  bubbleEl.style.setProperty("--accent-soft", th.soft);
}

/** 自己那侧头像：底色跟用户全局主题色（改主题色立刻变），字色（含浅色底描边）走 avatar.js 的唯一实现 */
function paintSelfAva(box, settings) {
  if (!box) return;
  const th = themeOf(resolveAccent(null, settings || {}));
  box.style.background = th.base;
  applyAvatarInk(box, th.base);
}

/** 成员头像：与成员墙同一口径 —— member.avatar 优先，否则成员主题色（null 跟随用户）。
 *  这样「谁的颜色」在气泡、消息头像、详情卡成员墙三处一致。 */
function paintMemberAva(box, member, settings) {
  if (!box) return;
  const s = settings || {};
  const accent = member ? resolveMemberAccent(member, s) : resolveAccent(null, s);
  const bg = resolveMemberAvaColor(member, accent);
  box.style.background = bg;
  applyAvatarInk(box, bg);
}

/** 工具条最多列几个名字（再多就折成「等 N 个工具」） */
const TOOL_LINE_MAX = 3;

/** 一条消息里所有工具调用的名字（保持出现顺序） */
function toolCallNames(msg) {
  const parts = msg && Array.isArray(msg.parts) ? msg.parts : [];
  const names = [];
  parts.forEach((p) => {
    if (!p || p.type !== "tool-call") return;
    names.push(typeof p.name === "string" && p.name ? p.name : "工具");
  });
  return names;
}

/** 工具条的文案。返回空串表示"这条不该画工具条"：
 *  有可见正文的消息正文优先；没有工具调用的空消息什么都不画（也不画空气泡）。 */
function toolLineText(msg) {
  if (!msg || msg.role === "user") return "";
  const text = msg.content == null ? "" : String(msg.content);
  if (text.trim() !== "") return "";
  const names = toolCallNames(msg);
  if (!names.length) return "";
  if (names.length > TOOL_LINE_MAX) {
    return "⚙ 调用了 " + names.slice(0, TOOL_LINE_MAX).join("、") + " 等 " + names.length + " 个工具";
  }
  return "⚙ 调用了 " + names.join("、");
}

/** 入场动效只挂一次：加 .anim-enter，动画结束后自己摘掉。
 *  DEV.md §2.5 硬规则 4 —— 全量重画一律不加，只有"新增节点"走这里。
 *  .anim-enter 的 keyframes/时长在 css/motion.css（dev-a 拥有），本卡不写。 */
function markEnter(node) {
  if (!node || !node.classList) return;
  node.classList.add("anim-enter");
  const off = (ev) => {
    if (ev && ev.target !== node) return; // 子元素冒泡上来的不算
    node.classList.remove("anim-enter");
    node.removeEventListener("animationend", off);
  };
  node.addEventListener("animationend", off);
}

/** 会话 id：优先栈顶 params（shell 把同一份参数也放在 ctx.__convId） */
function readConvId(ctx) {
  const router = (ctx && ctx.router) || {};
  let params = null;
  if (typeof router.current === "function") {
    const cur = router.current();
    params = (cur && cur.params) || null;
  }
  if (!params && Array.isArray(router.stack) && router.stack.length) {
    const top = router.stack[router.stack.length - 1];
    params = (top && top.params) || null;
  }
  const convId = params && (params.convId || params.id);
  return convId || (ctx && ctx.__convId) || null;
}

const card = {
  id: "chat-group",
  title: "群聊",

  async mount(root, ctx) {
    this.root = root;
    this.ctx = ctx || {};
    this.convId = readConvId(this.ctx);
    this.members = [];
    this.messages = [];
    this.conv = null;
    this.streaming = false;
    this.controller = null;
    this.unmounted = false;
    // 群聊调度状态：epoch 是中断守卫，turn 是当前这一轮（队列 + abort + 光标）
    this.epoch = 0;
    this.turn = null;
    this.lastSpeakerId = null;
    this.maxReplies = null; // null = 用 group.js 的默认 clamp(成员数,1,3)；UI 可调到 1-6
    this.seqCounter = 0;
    // 档案类工具改的是「当前正在说话的那一位」，群里必须跟着光标走，不能取第一个成员
    this.currentResponder = null;

    root.innerHTML = "";
    root.classList.add("card-chat");

    if (!this.convId) {
      root.appendChild(el("div", "note", "群聊不存在"));
      return;
    }

    this.buildShell(root);
    this.subscribe();
  },

  /** 结构 = styles.html 753-829 行；顶栏走共用组件 chatHead，no-tail 关掉气泡小尖尖 */
  buildShell(root) {
    root.innerHTML =
      '<div class="chat no-tail">' +
      '<div id="wallpaper"></div>' +
      '<div id="dim"></div>' +
      '<div class="chat-body" id="chatBody"></div>' +
      '<div class="ctx-line" hidden style="position:relative;z-index:3;padding:0 12px 4px;font-size:12px;line-height:1.4;' +
      'text-align:center;color:var(--meta,#8a8a8e)"></div>' +
      '<div class="chat-foot">' +
      '<div class="pill"><textarea class="pill-input" placeholder="输入消息…"></textarea></div>' +
      '<button class="send" type="button" aria-label="发送">' +
      '<span class="ico ico-send">➤</span><span class="ico ico-stop">■</span>' +
      "</button>" +
      "</div>" +
      "</div>";

    const chat = root.querySelector(".chat");
    this.chatEl = chat;
    this.wallpaperEl = chat.querySelector("#wallpaper");
    this.dimEl = chat.querySelector("#dim");
    this.bodyEl = chat.querySelector("#chatBody");
    this.ctxEl = chat.querySelector(".ctx-line");

    // 顶栏与私聊卡共用同一个组件，插在消息区之前
    this.mountHead();

    this.input = chat.querySelector(".pill-input");
    this.input.rows = 1;
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));
    this.input.addEventListener("input", () => this.autosize());

    this.sendBtn = chat.querySelector(".send");
    this.sendBtn.addEventListener("click", () => this.onSendClick());
  },

  /** 群聊顶栏：群首字圆（单个 .ava，和私聊同构） + 群名 + 状态行「N 位成员」 */
  mountHead() {
    if (!this.chatEl) return;
    const head = chatHead({
      ava: String(this.convTitle()).slice(0, 1).toUpperCase(),
      avaColor: resolveAvaColor(this.conv, this.ctx.settings || {}),
      avaImage: this.conv && this.conv.avatar && this.conv.avatar.image,
      name: this.convTitle(),
      sub: this.members.length ? this.members.length + " 位成员" : "群聊",
      onBack: () => this.goBack(),
      onMore: () => this.openDetail(),
    });
    const old = this.chatEl.querySelector(".chat-head");
    if (old) old.remove();
    this.chatEl.insertBefore(head, this.chatEl.querySelector(".chat-body"));
    this.headEl = head;
    this.avaEl = head.querySelector(".ava");
    this.nameEl = head.querySelector(".who .name");
    this.subEl = head.querySelector(".who .sub");
    this.bindHeadMenu(head);
  },

  /** 数据每次进栈都重读（群成员可能在详情页改过） */
  async load() {
    if (!this.convId) return;
    const store = this.ctx.store;
    const conv = await store.getConversation(this.convId);
    const members = await store.listMembers(this.convId);
    const messages = await store.listMessages(this.convId);
    if (this.unmounted) return;
    this.conv = conv || null;
    this.members = (members || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    // 排序用单调 seq（不用 createdAt：同毫秒会撞），老数据没有 seq 时退回 ts
    this.messages = (messages || [])
      .slice()
      .sort((a, b) => {
        const sa = typeof a.seq === "number" ? a.seq : Infinity;
        const sb = typeof b.seq === "number" ? b.seq : Infinity;
        return sa === sb ? (a.ts || 0) - (b.ts || 0) : sa - sb;
      });
    this.seqCounter = nextSeq(this.messages);
    this.renderHead();
    this.renderWallpaper();
    this.renderAccent();
    this.renderMessages();
    // 进栈只算统计、不折叠（§2.6：折叠只发生在发新消息前）
    const first = this.members[0];
    if (first && typeof this.prepareContext === "function") {
      this.prepareContext(first, [], {
        fold: false,
        tools: createTools({
          store: this.ctx.store,
          getSettings: () => this.ctx.settings || {},
          getContextStats: () => this.contextStats || null,
          convId: this.convId,
        }),
      }).catch(() => {});
    }
  },

  takeSeq() {
    const s = this.seqCounter || nextSeq(this.messages);
    this.seqCounter = s + 1;
    return s;
  },

  convTitle() {
    if (this.conv && this.conv.title) return this.conv.title;
    const names = this.members.map((m) => m.name).filter(Boolean);
    return names.length ? names.join("、") : "群聊";
  },

  renderHead() {
    this.mountHead();
  },

  /** 壁纸只有一条路：store.js 解析、theme.js 打到 data-wall；本卡不写内联背景 */
  renderWallpaper() {
    if (!this.wallpaperEl) return;
    applyWallpaperLayer(this.wallpaperEl, resolveWallpaper(this.conv, this.ctx.settings || {}));
    if (this.dimEl) this.dimEl.style.opacity = "0";
  },

  /** 会话/成员的颜色：卡片根的 --accent 给气泡兜底，--send-bg 单独取用户全局主题色。
   *  两色分离是用户定的口径：换会话/换成员不该换发送键，换全局主题色两处都要跟。 */
  renderAccent() {
    if (!this.root) return;
    const user = this.ctx.settings || {};
    this.root.style.setProperty("--accent", resolveAccent(this.conv, user));
    this.root.style.setProperty("--send-bg", resolveSendAccent(user));
    this.paintHeadAva();
    // 成员改了自己的颜色（或用户改了全局色）之后，已经画出来的气泡要就地重算
    const bubbles = this.bodyEl ? Array.prototype.slice.call(this.bodyEl.querySelectorAll(".bubble")) : [];
    let i = 0;
    this.messages.forEach((m) => {
      if (!m || m.status === "streaming") return;
      const b = bubbles[i++];
      if (b) paintBubble(b, accentForMessage(m, this.members, user));
    });
    // 自己那侧头像跟用户全局主题色走，换色后同样就地重画
    if (this.bodyEl) {
      const mine = this.bodyEl.querySelectorAll(".row.me .msg-ava");
      Array.prototype.forEach.call(mine, (box) => paintSelfAva(box, user));
      // 对方头像跟成员色/用户色走（成员 accent 为 null 时跟随用户），换色后同样重画
      const theirs = Array.prototype.slice.call(this.bodyEl.querySelectorAll(".row.them .msg-ava"));
      let j = 0;
      this.messages.forEach((m) => {
        if (!m || m.status === "streaming" || m.role === "user") return;
        const box = theirs[j++];
        if (box) paintMemberAva(box, this.memberById(m.memberId), user);
      });
    }
  },

  /** 顶栏头像底色：不重建顶栏，只改已经挂着的那颗。
   *  换底色必须同时重算字色，否则白/浅灰主题色下是白底白字、深色主题色下是深字压深底。 */
  paintHeadAva() {
    if (!this.avaEl) return;
    const user = this.ctx.settings || {};
    const image = this.conv && this.conv.avatar && this.conv.avatar.image;
    if (image) {
      this.avaEl.style.backgroundImage = 'url("' + String(image) + '")';
      this.avaEl.style.backgroundSize = "cover";
      this.avaEl.style.backgroundPosition = "center";
      return;
    }
    this.avaEl.style.backgroundImage = "";
    const bg = resolveAvaColor(this.conv, user);
    this.avaEl.style.backgroundColor = bg;
    applyAvatarInk(this.avaEl, bg);
  },

  /** 壁纸/颜色/会话变化时就地重绘（详情页改完立刻生效，不用重载） */
  subscribe() {
    const ctx = this.ctx;
    if (!ctx || !ctx.events || typeof ctx.events.on !== "function") return;
    this.offHandlers = [];
    const put = (off) => {
      if (typeof off === "function") this.offHandlers.push(off);
    };
    put(
      ctx.events.on("wallpaper-changed", (p) => {
        if (p && p.convId && p.convId !== this.convId) return;
        ctx.store
          .getConversation(this.convId)
          .then((c) => {
            this.conv = c || this.conv;
            this.renderWallpaper();
            this.renderAccent();
          })
          .catch(() => {});
      })
    );
    put(
      ctx.events.on("settings:applied", () => {
        this.renderWallpaper();
        this.renderAccent();
      })
    );
    put(
      ctx.events.on("conv:changed", (p) => {
        if (p && p.id && p.id !== this.convId) return;
        ctx.store
          .getConversation(this.convId)
          .then((c) => {
            this.conv = c || this.conv;
            this.renderWallpaper();
            this.renderAccent();
          })
          .catch(() => {});
      })
    );
    // 成员改名/改色后 store 会把成员列表重新发一遍（detail-group 在听的不是这个，所以再兜一次 conv:changed）
    put(
      ctx.events.on("members-changed", (p) => {
        if (p && p.convId && p.convId !== this.convId) return;
        this.renderHead();
        ctx.store
          .listMembers(this.convId)
          .then((list) => {
            this.members = list || [];
            this.renderMessages();
            this.renderAccent();
          })
          .catch(() => {});
      })
    );
  },

  unsubscribe() {
    (this.offHandlers || []).forEach((off) => {
      try {
        off();
      } catch (e) {
        /* 已经退订过就算了 */
      }
    });
    this.offHandlers = [];
  },

  renderMessages() {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = "";
    // 全量重画：一个动效类都不加（DEV.md §2.5 硬规则 4，撤销/清空/切会话都走这里）
    const visible = this.messages.filter((m) => m && m.status !== "streaming");
    if (!visible.length) {
      this.bodyEl.appendChild(el("div", "note", "发条消息开始聊天"));
      return;
    }
    visible.forEach((m) => this.bodyEl.appendChild(this.messageRow(m)));
    this.scrollBottom();
  },

  /** 增量入口：只追加这一条，并给它挂入场动效（唯一的"新增节点"通道） */
  appendMessage(msg) {
    if (!this.bodyEl) return null;
    const hint = this.bodyEl.querySelector(".note");
    if (hint) hint.remove();
    const row = this.messageRow(msg);
    this.bodyEl.appendChild(row);
    markEnter(row);
    this.scrollBottom();
    return row;
  },

  /** 一条消息 = .row.them / .row.me > .msg-ava + .msg-col(.who-name + .bubble)
   *  头像两侧对称：对方在气泡左侧、自己在气泡右侧；名字始终在气泡外面、气泡上方。
   *  没有可见正文、只走过工具调用的那一轮：把 .bubble 换成一行 .tool-line（群里仍带头像与名字，谁调的一目了然）。 */
  messageRow(msg) {
    const mine = msg.role === "user";
    const row = el("div", mine ? "row me" : "row them");
    const name = mine ? selfIdentity().name : this.memberName(msg.memberId);
    const col = el("div", "msg-col");
    col.appendChild(el("span", "who-name", name));
    const toolText = toolLineText(msg);
    if (toolText) {
      col.appendChild(el("div", "tool-line", toolText));
    } else {
      const bubbleEl = el("div", "bubble", msg.content == null ? "" : String(msg.content));
      paintBubble(bubbleEl, accentForMessage(msg, this.members, this.ctx.settings || {}));
      col.appendChild(bubbleEl);
    }
    const ava = mine ? this.selfAva() : this.msgAva(msg.memberId, name);
    if (mine) {
      row.appendChild(col);
      row.appendChild(ava);
    } else {
      row.appendChild(ava);
      row.appendChild(col);
    }
    return row;
  },

  /** 消息头像：与成员墙同一口径（见 paintMemberAva），尺寸/圆角/字号由 card-chat.css 给 */
  msgAva(memberId, name) {
    const member = this.memberById(memberId);
    const label = String(name || this.memberName(memberId));
    const box = el("div", "msg-ava", label.slice(0, 1).toUpperCase());
    paintMemberAva(box, member, this.ctx.settings || {});
    return box;
  },

  /** 自己那侧的头像：首字取自 store.getSelf().initial，底色跟用户全局主题色（不随机、不改名换色） */
  selfAva() {
    const self = selfIdentity();
    const box = el("div", "msg-ava", self.initial);
    paintSelfAva(box, this.ctx.settings || {});
    return box;
  },

  memberName(memberId) {
    if (!memberId) return this.convTitle();
    const m = this.memberById(memberId);
    return m && m.name ? m.name : this.convTitle();
  },

  memberById(memberId) {
    if (!memberId) return null;
    return this.members.find((x) => x && x.id === memberId) || null;
  },

  scrollBottom() {
    if (this.bodyEl) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  },

  autosize() {
    if (!this.input) return;
    this.input.style.height = "auto";
    const h = Math.min(this.input.scrollHeight || 0, 120);
    this.input.style.height = h ? h + "px" : "auto";
  },

  onKeydown(e) {
    if (e.key !== "Enter") return;
    // 输入法组合中不拦截
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey) return;
    e.preventDefault();
    this.send();
  },

  onSendClick() {
    if (this.streaming) {
      this.stopStream();
      return;
    }
    this.send();
  },

  stopStream() {
    // 中断语义（抄 pi 的 epoch 守卫）：abort() 不保证在飞的异步回调不再触发一次，
    // 所以每次中断都把 epoch +1；所有 delta 回调与落盘都比对 epoch，不等就丢弃。
    this.epoch += 1;
    const turn = this.turn;
    if (turn) {
      turn.queue.length = 0;
      try {
        turn.abort.abort();
      } catch (e) {
        /* 已结束的 signal 忽略 */
      }
      if (turn.bubble) this.markCanceled(turn.bubble);
    }
    if (this.controller) {
      try { this.controller.abort(); } catch (e) { /* 已结束的 signal 忽略 */ }
    }
    this.clearTyping();
    if (this.subEl && this.members.length) this.subEl.textContent = this.members.length + " 位成员";
  },

  /** 已生成内容永不删除：半截气泡改标记为「已停止」并保留 */
  markCanceled(bubble) {
    if (!bubble || !bubble.rowEl || !bubble.rowEl.isConnected) return;
    if (!bubble.full) {
      bubble.rowEl.remove(); // 一个字都没出来，不留空气泡
      return;
    }
    bubble.bubble.textContent = bubble.full + "\n（已停止）";
  },

  setStreaming(on) {
    this.streaming = !!on;
    if (!on) this.clearTyping();
    if (!this.sendBtn) return;
    // ➤ ↔ ■ 由 CSS 做 opacity 交叉（.stop 类驱动），不再改 textContent
    this.sendBtn.classList.toggle("stop", !!on);
    this.sendBtn.setAttribute("aria-label", on ? "停止" : "发送");
  },

  async send() {
    if (this.streaming || !this.convId) return;
    const content = this.input ? this.input.value.trim() : "";
    if (!content) return;

    this.input.value = "";
    this.autosize();

    const userMsg = {
      id: uid(),
      convId: this.convId,
      memberId: null,
      role: "user",
      content,
      ts: now(),
      seq: this.takeSeq(),
    };
    try {
      await this.ctx.store.addMessage(userMsg);
    } catch (e) {
      this.showError("发送失败: " + errorText(e));
      return;
    }
    this.messages.push(userMsg);
    this.appendMessage(userMsg);

    await this.runGroupTurn(content);
  },

  /** 一轮群聊：先算谁接话（planQueue），再按顺序一个个跑 agent 循环。
   *  串行是刻意的：前端一次只该有一条流，否则中断语义会互相打架。 */
  async runGroupTurn(text) {
    if (!this.members.length) {
      this.showError("该会话没有成员，无法回复");
      return;
    }
    const plan = planQueue({
      text,
      members: this.members,
      lastSpeakerId: this.lastSpeakerId,
      maxReplies: this.maxReplies,
    });
    if (!plan.queue.length) {
      this.showError("没有可接话的成员");
      return;
    }

    const turn = {
      epoch: this.epoch,
      queue: plan.queue.slice(),
      abort: new AbortController(),
      cursor: null,
      bubble: null,
    };
    this.turn = turn;
    this.setStreaming(true);

    const stale = () => this.epoch !== turn.epoch || this.unmounted;
    const tools = createTools({
      store: this.ctx.store,
      getSettings: () => this.ctx.settings || {},
      // context_info 工具用：读的就是底栏那行统计，不另算一套
      getContextStats: () => this.contextStats || null,
      convId: this.convId,
      // 档案类工具改的是「当前正在说话的成员」：跟着上面的光标走，不是第一个成员
      getResponder: () => this.currentResponder,
      // 工具执行成功后的当场重绘（不刷新、不切卡）
      onChanged: (info) => this.applyProfileChange(info),
    });
    const store = this.ctx.store;
    let failures = 0;
    const unreplied = [];

    while (turn.queue.length) {
      if (stale()) break;
      const member = turn.queue.shift();
      // 正在输入是**单值**：就是 cursor 指向的这一个，不要每个成员各自闪
      turn.cursor = member.id;
      this.currentResponder = member;
      this.setTyping(member);

      const settings = this.ctx.settings || {};
      // 每个成员的公私上下文不同（responder.id 决定哪条 assistant 算自己），所以逐个拼
      const messages = await this.prepareContext(member, unreplied.slice());
      if (stale()) break;

      const bubble = this.startStreamBubble(member);
      turn.bubble = bubble;

      let out = null;
      let failure = null;
      try {
        out = await runAgent({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          messages,
          tools,
          signal: turn.abort.signal,
          convId: this.convId,
          memberId: member.id,
          firstByteTimeoutMs: FIRST_BYTE_MS,
          maxTotalMs: TOTAL_MS,
          abortStatus: "canceled",
          errorStatus: "failed",
          persist: {
            start: (rec) => store.addMessage(rec),
            // 落盘前也比对 epoch：旧流不许把 complete 写回去盖掉 canceled
            update: (id, patch) => store.updateMessage(id, stale() ? { status: "canceled" } : patch),
          },
          onEvent: (name, payload) => {
            if (stale()) return;
            if (name === "text_delta" && payload && typeof payload.text === "string") {
              bubble.full = payload.text;
              bubble.textNode.nodeValue = bubble.full;
              this.scrollBottom();
            } else if (name === "tool_execution_start" && payload) {
              this.setTyping(member, payload.name);
            } else if (name === "tool_execution_end" && payload && payload.isError) {
              this.setTyping(member, payload.name + " 失败");
            }
          },
        });
      } catch (e) {
        failure = e;
      }

      if (stale()) break;

      if (failure && failure.name !== "AbortError") {
        failures += 1;
        bubble.bubble.textContent =
          (bubble.full ? bubble.full + "\n" : "") + "[回复失败: " + errorText(failure) + "]";
        // 失败成员的沉默不能当成默认同意
        unreplied.push(unrepliedLine(member.name));
        if (failures >= HALT_AFTER_FAILURES) {
          this.showError("连续 " + failures + " 条回复失败，本轮已停止（像是网络或供应商的问题）");
          break;
        }
        this.setTyping(null);
        continue;
      }

      if (failure && failure.name === "AbortError") break;

      const status = out && out.status ? out.status : "complete";
      const raw = out && typeof out.text === "string" ? out.text : bubble.full;
      const sealed = stripEnd(raw);
      const text2 = sealed.text;

      // 静默：模型只输出静默标记时这一条不该变成可见消息
      if (isSilent(text2)) {
        if (!bubble.full) bubble.rowEl.remove();
        const recs = (out && out.messages) || [];
        for (const rec of recs) await store.deleteMessages(rec.id).catch(() => {});
        if (plan.reason === "rotate") unreplied.push(unrepliedLine(member.name));
        this.setTyping(null);
        continue;
      }

      bubble.full = text2;
      bubble.textNode.nodeValue = text2;
      // 这一轮只有工具调用、没有正文：空气泡当场移除，重画时由 .tool-line 接替
      if (!text2.trim()) bubble.rowEl.remove();
      // 落盘顺序按 call 顺序、seq 单调递增（agent 内部按 step 落，这里统一重编号）。
      // 正文只写进**最后一条**：工具调用那几步的 content 必须保持为空，
      // 否则同一条回复会被复制成 N 条一模一样的可见消息（重画时只该有一条气泡 + 若干 .tool-line）。
      const recs = (out && out.messages) || [];
      for (let i = 0; i < recs.length; i++) {
        const patch = { seq: this.takeSeq() };
        if (i === recs.length - 1) {
          patch.content = text2;
          patch.status = status === "terminated" ? "complete" : status;
        } else {
          patch.status = "complete";
        }
        await store.updateMessage(recs[i].id, patch).catch(() => {});
      }
      if (text2) this.lastSpeakerId = member.id;
      if (status === "terminated" || sealed.end) break;
      this.setTyping(null);
    }

    this.turn = null;
    this.currentResponder = null;
    this.setTyping(null);
    this.setStreaming(false);
    this.saveTouch();
    await this.load();
  },

  /** 正在输入（单值，只表示"当前这一位在说话"）：气泡区末尾的一行 .typing，流式结束必须移除。
   *  顶栏状态行始终保持「N 位成员」不动（lead 定）。 */
  setTyping(member, extra) {
    if (!this.bodyEl) return;
    const old = this.bodyEl.querySelector(".typing");
    if (!member) {
      if (old) old.remove();
      return;
    }
    const name = String(member.name || "成员");
    const label = "「" + name + "」正在输入" + (extra ? " · " + extra : "");
    if (old) {
      // 已经在闪了：只换文字，不重建节点（重建会让动画从头开始，闪一下）
      const text = old.querySelector(".typing-text");
      if (text) text.textContent = label;
      return;
    }
    const row = el("div", "typing");
    row.appendChild(el("span", "typing-text", label));
    const dots = el("span", "typing-dots");
    for (let i = 0; i < 3; i++) dots.appendChild(el("span", "anim-typing", "·"));
    row.appendChild(dots);
    this.bodyEl.appendChild(row);
    this.scrollBottom();
  },

  /** 流式中断/结束、卸载、切页都要保证 .typing 不残留（DEV.md §2.5 硬规则 6） */
  clearTyping() {
    if (!this.bodyEl) return;
    const old = this.bodyEl.querySelector(".typing");
    if (old) old.remove();
  },

  /** DEV.md §2.6：每个成员发言前各自折叠 + 拼一次上下文（responder.id 决定哪条 assistant 算自己的）。
   *  群规则并进 [2] 设定那一段（memberSystemPrompt 已含 persona），**不新增 system 段**。
   *  this.messages 只负责渲染，喂模型的一律是这里的返回值。 */
  async prepareContext(member, extraUserLines, opts) {
    const noFold = !!(opts && opts.fold === false);
    const store = this.ctx.store;
    // [5] 段的工具清单：调用方把本轮真正交给模型的那一份传进来；
    // 兜底是同一份 createTools 的产物（卡片不另拼清单）
    const tools =
      opts && Array.isArray(opts.tools)
        ? opts.tools
        : createTools({ store, getSettings: () => this.ctx.settings || {}, convId: this.convId });
    const settings = this.ctx.settings || {};
    const budget = Number(settings.contextBudget == null ? 8000 : settings.contextBudget) || 0;
    const compress = settings.contextCompress !== false;
    const signal = this.turn && this.turn.abort ? this.turn.abort.signal : undefined;
    const responder = Object.assign({}, member || {}, {
      persona: memberSystemPrompt({
        member: member || {},
        members: this.members,
        userName: selfIdentity().name,
      }),
    });

    // 1) 折叠最旧的一批。失败什么都不做（宁可上下文长，不许丢历史），本轮照常发请求。
    if (!noFold && compress && budget > 0 && typeof foldOldest === "function") {
      try {
        await foldOldest({
          store,
          conv: this.conv,
          responder,
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          signal,
        });
      } catch (e) {
        /* 折叠失败不挡发送 */
      }
    }

    // 2) 重读库里的原料，交给 buildContext 拼六段
    const load = (name, fallback) =>
      typeof store[name] === "function" ? store[name](this.convId) : Promise.resolve(fallback());
    const [messages, blocks, memo] = await Promise.all([
      load("listUnfoldedMessages", () => this.messages.slice()),
      load("listBlocks", () => []),
      // memo 是全局唯一的一条（用户口径），不按会话分桶：工具写的就是这一条
      typeof store.getMemo === "function" ? store.getMemo() : Promise.resolve(""),
    ]);

    const built = buildContext({
      conv: this.conv,
      members: this.members,
      responder,
      messages: (messages || []).slice().sort((a, b) => (a.seq || a.ts || 0) - (b.seq || b.ts || 0)),
      blocks: blocks || [],
      memo: memo || "",
      budget,
      compress,
      // [5] 段：这份工具清单就是本轮交给模型的那一份，时间取此刻
      tools,
      now: new Date(),
    });
    // listUnfoldedMessages 已经把折叠过的滤掉了，built.folded 永远是 0；
    // 底栏要显示的「压缩块 N」是块数，所以自己带上 blocks 数
    this.contextStats = Object.assign({}, built, { blocks: (blocks || []).length, tools });
    this.renderCtxLine();

    // 3) 「谁还没回」这几行仍挂在末尾（§2.6 的第 [5] 段尾部），不新增 system 段
    const out = built.messages.slice();
    const tail = (extraUserLines || []).filter(Boolean);
    if (tail.length) out.push({ role: "user", content: tail.join("\n") });
    return out;
  },

  /** 只取喂上下文用的两件：名字与说明（参数 schema 不进 [5] 段，太占 token） */
  contextTools(list) {
    return (Array.isArray(list) ? list : [])
      .map((t) => ({ name: String((t && t.name) || ""), description: String((t && t.description) || "") }))
      .filter((t) => t.name);
  },

  /** 档案类/外观类工具改完东西后的当场重绘（不刷新、不切卡）。
   *  info = { memberId, kind }，kind ∈ "name"|"persona"|"look"|"wallpaper"。
   *  改了别人：只重画成员与他的气泡头像，不动顶栏（顶栏展示的是群名与成员数）。 */
  async applyProfileChange(info) {
    const store = this.ctx.store;
    const kind = String((info && info.kind) || "");
    const targetId = (info && info.memberId) || null;
    const current = this.turn && this.turn.cursor ? this.turn.cursor : null;
    const mine = !targetId || targetId === current || this.members.length <= 1;

    // 1) 重读成员与会话
    try {
      const [members, conv] = await Promise.all([
        typeof store.listMembers === "function" ? store.listMembers(this.convId) : Promise.resolve(this.members),
        typeof store.getConversation === "function"
          ? store.getConversation(this.convId)
          : Promise.resolve(this.conv),
      ]);
      if (this.unmounted) return;
      this.conv = conv || this.conv;
      this.members = (members || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    } catch (e) {
      /* 读不到就按内存里这份重画，别把界面卡住 */
    }

    // 2) 顶栏只在自己的外观/群名变了时重建（重建后 bindHeadMenu 会重新绑手势，见 mountHead）
    if (mine && (kind === "name" || kind === "look" || kind === "wallpaper")) this.renderHead();
    // 3) 壁纸：look/wallpaper 走唯一的 resolveWallpaper + applyWallpaperLayer（同值不重放）
    if (kind === "look" || kind === "wallpaper") this.renderWallpaper();
    // 4) 头像与气泡底色：改名/换装都要重画（消息头像按成员口径取色）
    if (kind === "name" || kind === "persona" || kind === "look") {
      this.renderMessages();
      this.renderAccent();
    }
    // 5) 广播：会话列表/详情卡要跟着换，别自己再造一套会话事件
    if (this.ctx && this.ctx.events && typeof this.ctx.events.emit === "function") {
      this.ctx.events.emit("profile:changed", { convId: this.convId, memberId: targetId, kind });
    }
  },

  /** 底栏统计：压缩块 N · 未压缩 M 条 · 约 X.Xk；budget=0 时首段换成「全量直喂」 */
  renderCtxLine() {
    if (!this.ctxEl) return;
    const st = this.contextStats;
    if (!st) {
      this.ctxEl.hidden = true;
      return;
    }
    const all = Array.isArray(st.messages) ? st.messages : [];
    const n = all.filter((m) => m && m.role !== "system").length;
    const est = Number(st.estimated) || 0;
    const k = est < 1000 ? String(est) : (est / 1000).toFixed(1) + "k";
    const blocks = Number(st.blocks != null ? st.blocks : st.folded) || 0;
    const settings = this.ctx.settings || {};
    const budget = Number(settings.contextBudget == null ? 8000 : settings.contextBudget) || 0;
    const live = budget > 0 && settings.contextCompress !== false;
    this.ctxEl.textContent =
      (live ? "压缩块 " + blocks + " · 未压缩 " + n + " 条" : "全量直喂 · " + n + " 条") + " · 约 " + k;
    this.ctxEl.hidden = false;
  },

  /** 只更新会话的 updatedAt。置顶与否只听用户的，发消息绝不碰 pinned。 */
  saveTouch() {
    if (!this.convId) return;
    this.ctx.store.touchConversation(this.convId).catch(() => {});
    if (this.ctx.events) this.ctx.events.emit("conv:changed", { id: this.convId });
  },

  /** 流式气泡：与 messageRow 同构（.msg-ava + .msg-col > .who-name + .bubble），只是文本节点留空待填。
   *  气泡在 delta 开始前建出来，入场动效此刻挂上；delta 只改 textNode，不碰类。 */
  startStreamBubble(member) {
    const hint = this.bodyEl ? this.bodyEl.querySelector(".note") : null;
    if (hint) hint.remove();
    const name = member && member.name ? member.name : "";
    const row = el("div", "row them");
    row.appendChild(this.msgAva(member && member.id, name));
    const col = el("div", "msg-col");
    col.appendChild(el("span", "who-name", name));
    const bubbleEl = el("div", "bubble");
    paintBubble(
      bubbleEl,
      accentForMessage({ role: "assistant", memberId: member && member.id }, this.members, this.ctx.settings || {})
    );
    const textNode = document.createTextNode("");
    bubbleEl.appendChild(textNode);
    col.appendChild(bubbleEl);
    row.appendChild(col);
    if (this.bodyEl) this.bodyEl.appendChild(row);
    markEnter(row);
    this.scrollBottom();
    return { rowEl: row, bubble: bubbleEl, textNode: textNode, full: "" };
  },

  showError(text) {
    if (!this.bodyEl || !text) return;
    if (this.ctx.events) this.ctx.events.emit("toast", { text });
    this.bodyEl.appendChild(el("div", "note", text));
    this.scrollBottom();
  },

  goBack() {
    this.ctx.router.back();
  },

  /** 顶栏 ⋮：进详情卡（会话菜单改走长按/右键，与列表卡手势一致） */
  openDetail() {
    if (!this.convId) return;
    this.ctx.router.push("detail-group", { convId: this.convId });
  },

  /** 会话菜单的手势入口：右键 + 550ms 长按（与 js/cards/list.js 的会话菜单同款）。
   *  指针移动超过 8px 或抬起即取消，避免滚动/拖拽误触。 */
  bindHeadMenu(head) {
    if (!head) return;
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu();
    });
    let timer = null;
    let moved = false;
    let x0 = 0;
    let y0 = 0;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      moved = false;
      x0 = e.clientX;
      y0 = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (!moved) this.openMenu();
      }, 550);
    });
    head.addEventListener("pointermove", (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - x0) > 8 || Math.abs(e.clientY - y0) > 8) {
        moved = true;
        cancel();
      }
    });
    head.addEventListener("pointerup", cancel);
    head.addEventListener("pointercancel", cancel);
    head.addEventListener("pointerleave", cancel);
  },

  /** 顶栏 ⋮：菜单项与行为都在 js/ui/conv-menu.js，私聊/群聊共用同一份实现 */
  async openMenu() {
    const r = await openConvMenu({ ctx: this.ctx, convId: this.convId, kind: "group" });
    if (!r || !r.key) {
      if (r && r.error) this.showError(r.error);
      return;
    }
    if (r.conv) this.conv = r.conv;
    if (r.cleared) {
      this.messages = [];
      this.renderMessages();
    }
    if (r.renamed || r.pinnedChanged) this.renderHead();
    if (r.error) this.showError(r.error);
  },

  /** shell 先 mount 再 onEnter(params)，首次进栈的数据读在这里 */
  async onEnter(params) {
    const id = params && (params.convId || params.id);
    if (id) this.convId = id;
    if (this.unmounted) return;
    this.stopStream();
    this.setStreaming(false);
    await this.load();
  },

  async onLeave() {
    this.stopStream();
  },

  async unmount() {
    this.unmounted = true;
    this.stopStream();
    this.clearTyping();
    this.unsubscribe();
    this.root = null;
    this.ctx = null;
  },
};

export default card;
