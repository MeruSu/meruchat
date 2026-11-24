// 卡片：chat-direct（私聊会话页，1 个成员）
// DOM 逐字照搬 C:\Meru\website\su\preview\styles.html 第 753-829 行（用户已验收的那台手机），
// 只把写死的文字换成变量；class 名一个没改，元素一个没增删。
// 样式全部来自 css/style-kit.css（同一套 class），本卡片不写视觉值。
import { chatHead } from "../ui/chat-head.js";
import { openConvMenu } from "../ui/conv-menu.js";
import { el, errorText, now, uid } from "../core/util.js";
import { runAgent, recoverStreaming } from "../core/agent.js";
import { createTools } from "../core/tools/index.js";
import { nextSeq } from "../core/group.js";
// Billion Context：拼上下文与折叠的唯一实现点（DEV.md §2.6）。卡片只调用，不自己拼。
import { buildContext, foldOldest } from "../core/context.js";
// 壁纸只有一个口径：store.js 解析、theme.js 落 DOM（本卡不写内联背景，也不自己认颜色）
import { resolveWallpaper } from "../core/store.js";
import { applyWallpaperLayer } from "../core/theme.js";
import * as themeNs from "../core/theme.js";
import * as storeModule from "../core/store.js";
// 头像字色（含浅色底的描边）唯一实现在 js/ui/avatar.js，换底色时必须跟着重算
import { applyAvatarInk } from "../ui/avatar.js";

/** 只认真正的颜色串：老数据/预览 mock 里的 "notion" 这类皮名字必须挡掉，
 *  否则 --accent 是个非法值，color-mix 会变成「非法于计算时」把气泡底色整条作废。 */
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

/** 工具调用与思考过程一律不显示（用户定的口径）：
 *  只有"这一条有可见正文"的消息才画气泡；只走过工具调用的那一轮直接不画行。
 *  工具/思考阶段的状态只体现在顶栏状态行（见 setBusy）。 */
function hasVisibleText(msg) {
  if (!msg) return false;
  return String(msg.content == null ? "" : msg.content).trim() !== "";
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
  id: "chat-direct",
  title: "私聊",

  async mount(root, ctx) {
    this.root = root;
    this.ctx = ctx || {};
    this.convId = readConvId(this.ctx);
    this.members = [];
    this.messages = [];
    this.conv = null;
    this.streaming = false;
    this.busy = false;
    this.controller = null;
    this.unmounted = false;

    root.innerHTML = "";
    root.classList.add("card-chat");

    if (!this.convId) {
      root.appendChild(el("div", "note", "会话不存在"));
      return;
    }

    this.buildShell(root);
    this.subscribe();
  },

  /** 结构 = styles.html 753-829 行；顶栏走共用组件 chatHead，其余只留变量钩子 */
  buildShell(root) {
    root.innerHTML =
      '<div class="chat no-tail">' +
      '<div id="wallpaper"></div>' +
      '<div id="dim"></div>' +
      '<div class="chat-body" id="chatBody"></div>' +
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

    // 顶栏插在消息区之前，和 styles.html 的 .chat > .chat-head + .chat-body 同序
    this.mountHead();

    this.input = chat.querySelector(".pill-input");
    this.input.rows = 1;
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));
    this.input.addEventListener("input", () => this.autosize());

    this.sendBtn = chat.querySelector(".send");
    this.sendBtn.addEventListener("click", () => this.onSendClick());
  },

  /** 私聊顶栏：对方首字圆 + 对方名字 + 状态行（空闲「在线」/ 干活时「正在输入中…」） */
  mountHead() {
    if (!this.chatEl) return;
    const head = chatHead({
      ava: this.headAva(),
      avaColor: resolveAvaColor(this.conv, this.ctx.settings || {}),
      avaImage: this.conv && this.conv.avatar && this.conv.avatar.image,
      name: this.convTitle(),
      sub: this.subText(),
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

  headAva() {
    return String(this.convTitle()).slice(0, 1).toUpperCase();
  },

  /** 顶栏状态行文案。busy = 这一轮在跑（思考 / 调工具 / 吐字都算）。 */
  subText() {
    return this.busy ? "正在输入中…" : "在线";
  },

  /** 工具调用与思考不显示在消息区，只把顶栏状态行切成「正在输入中…」；false 时切回「在线」 */
  setBusy(on) {
    this.busy = !!on;
    if (this.subEl) this.subEl.textContent = this.subText();
  },

  /** 数据每次进栈都重读（成员/消息可能在详情页改过） */
  async load() {
    if (!this.convId) return;
    const store = this.ctx.store;
    const conv = await store.getConversation(this.convId);
    const members = await store.listMembers(this.convId);
    const messages = await store.listMessages(this.convId);
    if (this.unmounted) return;
    this.conv = conv || null;
    this.members = (members || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    this.messages = (messages || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    this.renderHead();
    this.renderWallpaper();
    this.renderAccent();
    this.renderMessages();
    // 进栈只算统计、不折叠（§2.6：折叠只发生在发新消息前）
    if (typeof this.prepareContext === "function") {
      this.prepareContext(this.member(), {
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

  member() {
    return this.members[0] || null;
  },

  convTitle() {
    if (this.conv && this.conv.title) return this.conv.title;
    const m = this.member();
    return m && m.name ? m.name : "私聊";
  },

  renderHead() {
    this.mountHead();
  },

  /** 壁纸只有一条路：store.js 解析出 aurora/forest/dusk，theme.js 打到 data-wall 上。
   *  本卡不写任何内联背景（内联会盖住 css/cards.css 里的 #wallpaper[data-wall] 规则）。 */
  renderWallpaper() {
    if (!this.wallpaperEl) return;
    applyWallpaperLayer(this.wallpaperEl, resolveWallpaper(this.conv, this.ctx.settings || {}));
    if (this.dimEl) this.dimEl.style.opacity = "0";
  },

  /** 气泡与发言人名的唯一取色口径：谁发的消息，就用谁的主题色。
   *  自己（user）→ 用户全局色（resolveAccent(null, user)，不掺会话色）；
   *  私聊里唯一的 AI → 本会话色（= resolveAccent(this.conv, user)，成员色在私聊由 conv 承担，
   *  会话自己没设色时才回落到用户全局色）。与群聊卡同构，私聊只是少了成员这一级。 */
  accentOf(msg) {
    const user = this.ctx.settings || {};
    if (!msg || msg.role === "user") return resolveAccent(null, user);
    return resolveAccent(this.conv, user);
  },

  /** 会话主题色：卡片根的 --accent 给顶栏/输入条兜底，--send-bg 取**本会话**的主题色（两卡同口径）。 */
  renderAccent() {
    if (!this.root) return;
    const user = this.ctx.settings || {};
    const convAccent = resolveAccent(this.conv, user);
    this.root.style.setProperty("--accent", convAccent);
    // 发送键跟「本会话」的主题色：换会话就换键色，不再取用户全局色
    this.root.style.setProperty("--send-bg", convAccent);
    this.paintHeadAva();
    // 气泡按「谁发的」取色：自己用用户全局色，AI 用本会话色
    const bubbles = this.bodyEl ? Array.prototype.slice.call(this.bodyEl.querySelectorAll(".bubble")) : [];
    let i = 0;
    this.messages.forEach((m) => {
      if (!m || m.status === "streaming") return;
      const b = bubbles[i++];
      if (b) paintBubble(b, this.accentOf(m));
    });
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

  /** 壁纸/设置/会话变化时的就地重绘（不然详情页改完这里还是旧底） */
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
    put(ctx.events.on("settings:applied", () => {
      this.renderAccent();
      this.renderWallpaper();
    }));
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
    visible.forEach((m) => {
      const row = this.messageRow(m);
      if (row) this.bodyEl.appendChild(row);
    });
    this.scrollBottom();
  },

  /** 增量入口：只追加这一条，并给它挂入场动效（唯一的"新增节点"通道） */
  appendMessage(msg) {
    if (!this.bodyEl) return null;
    const row = this.messageRow(msg);
    if (!row) return null;
    const hint = this.bodyEl.querySelector(".note");
    if (hint) hint.remove();
    this.bodyEl.appendChild(row);
    markEnter(row);
    this.scrollBottom();
    return row;
  },

  /** 一条消息 = .row.them / .row.me > (.msg-failed?) + .bubble，不加名字标签、不加消息头像。
   *  没有可见正文的（只走过工具调用 / 只有思考）返回 null：不画行、不留空气泡、也不显示工具名。 */
  messageRow(msg) {
    if (!msg) return null;
    if (!hasVisibleText(msg)) return null;
    const mine = msg.role === "user";
    const row = el("div", mine ? "row me" : "row them");
    const bubbleEl = el("div", "bubble", String(msg.content));
    paintBubble(bubbleEl, this.accentOf(msg));
    row.appendChild(bubbleEl);
    // §2.7.2：只有自己发的失败消息在气泡左侧画红感叹号；AI 的 failed 走原来的文案，不加感叹号
    if (mine && msg.status === "failed") row.insertBefore(this.failedBang(), bubbleEl);
    return row;
  },

  /** 气泡左侧的红感叹号（§2.7.2）：点开去申请页（私聊 request-friend / 群聊 request-join）。
   *  感叹号是 .row 的第一个子节点（自己这侧气泡在最右），所以它天然落在气泡左边。 */
  failedBang() {
    const bang = el("button", "msg-failed", "!");
    bang.type = "button";
    bang.setAttribute("aria-label", "发送失败，点击重新申请");
    bang.addEventListener("click", (e) => {
      e.stopPropagation();
      const type = this.conv && this.conv.kind === "group" ? "request-join" : "request-friend";
      if (!this.ctx || !this.ctx.router || typeof this.ctx.router.push !== "function") return;
      try {
        this.ctx.router.push(type, { convId: this.convId });
      } catch (err) {
        // 申请卡还没注册时不要静默：router.push 对未知卡片是抛错
        this.showError(errorText(err));
      }
    });
    return bang;
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
    if (this.controller) {
      try { this.controller.abort(); } catch (e) { /* 已结束的 signal 忽略 */ }
    }
    this.setBusy(false);
  },

  setStreaming(on) {
    this.streaming = !!on;
    if (!this.sendBtn) return;
    // ➤ ↔ ■ 由 CSS 做 opacity 交叉（.stop 类驱动），不再改 textContent
    this.sendBtn.classList.toggle("stop", !!on);
    this.sendBtn.setAttribute("aria-label", on ? "停止" : "发送");
  },

  async send() {
    if (this.streaming || !this.convId) return;
    const content = this.input ? this.input.value.trim() : "";
    if (!content) return;

    // §2.7.2：发送前先问能不能说话（对方把我删了 → 不发请求，落一条失败消息，气泡左侧画红感叹号）。
    // 老 store 没有 canUserSpeak 时一律当能说，不许把发送功能搞死。
    const store = this.ctx.store;
    const allowed =
      typeof store.canUserSpeak === "function" ? await store.canUserSpeak(this.convId) : true;
    if (!allowed) {
      if (!this.unmounted) await this.failSend(content);
      return;
    }

    this.input.value = "";
    this.autosize();

    const userMsg = {
      id: uid(),
      convId: this.convId,
      memberId: null,
      role: "user",
      content,
      ts: now(),
      // seq 必须在这里定死：否则本地数组里的这条没有 seq，
      // 紧接着 runTurn 里 nextSeq(this.messages) 会算出同一个号，两条消息撞 seq，
      // 压缩块的 fromSeq/toSeq 区间也就跟着错。
      seq: nextSeq(this.messages),
    };
    try {
      await this.ctx.store.addMessage(userMsg);
    } catch (e) {
      this.showError("发送失败: " + errorText(e));
      return;
    }
    this.messages.push(userMsg);
    this.appendMessage(userMsg);

    await this.runTurn();
  },

  /** §2.7.2：不能说话时落一条本地失败消息（role:user + status:failed + failReason:"removed"），
   *  一个请求都不发；落库后重读消息区，让那条气泡带上红感叹号。 */
  async failSend(content) {
    const text = String(content || "").trim();
    if (!text || !this.convId) return;
    const failedMsg = {
      id: uid(),
      convId: this.convId,
      memberId: null,
      role: "user",
      content: text,
      ts: now(),
      seq: nextSeq(this.messages),
      status: "failed",
      failReason: "removed",
    };
    try {
      await this.ctx.store.addMessage(failedMsg);
    } catch (e) {
      this.showError("发送失败: " + errorText(e));
      return;
    }
    this.input.value = "";
    this.autosize();
    // 卡内缓存与库里对齐（失败标记要整段重画才看得见，不走 appendMessage 的增量通道）
    let fresh = null;
    try {
      fresh = await this.ctx.store.listMessages(this.convId);
    } catch (e) {
      /* 读不回来就用手上这条 */
    }
    if (this.unmounted) return;
    this.messages = (fresh && fresh.length ? fresh : this.messages.concat([failedMsg]))
      .slice()
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    this.renderMessages();
  },

  /** 一次发言：走 agent 循环（可多轮工具调用），文本增量直接画在当前气泡上。
   *  落盘由 agent.js 负责：消息在第一个增量之前就以 status:'streaming' 落库，
   *  结束后这里整段重读，画的就是库里的真身。 */
  async runTurn() {
    const member = this.member();
    if (!member) {
      this.showError("该会话没有成员，无法回复");
      return;
    }
    const settings = this.ctx.settings || {};
    const tools = createTools({
      store: this.ctx.store,
      getSettings: () => this.ctx.settings || {},
      // context_info 工具用：读的就是底栏那行统计，不另算一套
      getContextStats: () => this.contextStats || null,
      convId: this.convId,
      // 档案类工具改的是「当前正在说话的成员」：私聊只有一个，就是它
      getResponder: () => this.member(),
      // 工具执行成功后的当场重绘（不刷新、不切卡）
      onChanged: (info) => this.applyProfileChange(info),
      // 夺屏：工具发事件、shell 收（工具自己不调 router，避免和 shell 的 reset+push 切两次）
      emit: (ev, payload) => this.ctx.events.emit(ev, payload),
    });

    this.controller = new AbortController();
    // 折叠本身也要调模型（摘要），所以从这一刻起就算「正在输入中…」
    this.setBusy(true);
    // 折叠 + 拼上下文必须在开流之前完成（§2.6：流式过程中绝不折叠）
    // 工具清单用本轮真正交给模型的那一份，不另拼
    const messages = await this.prepareContext(member, { tools });
    if (this.unmounted || this.controller.signal.aborted) {
      this.controller = null;
      this.setBusy(false);
      return;
    }

    this.setStreaming(true);
    const live = this.startStreamBubble();
    const bubbleFor = (payload) => {
      if (!payload || !payload.text) return;
      live.full = payload.text;
      this.ensureStreamBubble(live);
      if (live.bubble) live.bubble.textContent = live.full;
      this.scrollBottom();
    };

    let failed = null;
    try {
      await runAgent({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        tools,
        signal: this.controller.signal,
        convId: this.convId,
        memberId: member.id,
        seq: nextSeq(this.messages),
        persist: {
          start: (rec) => this.ctx.store.addMessage(rec),
          update: (id, patch) => this.ctx.store.updateMessage(id, patch),
        },
        onEvent: (name, payload) => {
          // 工具调用 / 思考一律不显示，只保证顶栏停在「正在输入中…」
          if (name === "text_delta") bubbleFor(payload);
        },
      });
    } catch (e) {
      failed = e;
    } finally {
      this.controller = null;
      this.setStreaming(false);
      this.setBusy(false);
      this.saveTouch();
    }

    if (failed && failed.name === "AbortError") {
      // 一个字都没出来就停了：不留空气泡，也不留「已停止」
      if (live.rowEl) live.rowEl.remove();
    } else if (failed) {
      this.ensureStreamBubble(live);
      if (live.bubble) {
        live.bubble.textContent = (live.full ? live.full + "\n" : "") + "[回复失败: " + errorText(failed) + "]";
      }
    } else if (!live.full.trim()) {
      // 这一轮只有工具调用、没有正文：气泡本来就没建，什么都不用做
      if (live.rowEl) live.rowEl.remove();
    }
    await this.load();
  },

  /** 只更新会话的 updatedAt。置顶与否只听用户的，发消息绝不碰 pinned。 */
  saveTouch() {
    if (!this.convId) return;
    this.ctx.store.touchConversation(this.convId).catch(() => {});
    if (this.ctx.events) this.ctx.events.emit("conv:changed", { id: this.convId });
  },

  /** 流式气泡：**开流时不建**（思考/工具阶段不该出现任何气泡），
   *  真正有第一个字时才由 ensureStreamBubble 建出来，入场动效此刻挂上。 */
  startStreamBubble() {
    const hint = this.bodyEl ? this.bodyEl.querySelector(".note") : null;
    if (hint) hint.remove();
    return { rowEl: null, bubble: null, full: "" };
  },

  ensureStreamBubble(live) {
    if (!live || live.rowEl) return live;
    const row = el("div", "row them");
    const bubbleEl = el("div", "bubble", "");
    paintBubble(bubbleEl, this.accentOf({ role: "assistant" }));
    row.appendChild(bubbleEl);
    if (this.bodyEl) this.bodyEl.appendChild(row);
    markEnter(row);
    live.rowEl = row;
    live.bubble = bubbleEl;
    return live;
  },

  /** DEV.md §2.6：发新消息前先折叠，再按六段（AGENTS.md / 设定 / 压缩块 / memo / 工具与时间 / 未压缩消息）拼上下文。
   *  this.messages 只负责渲染，喂模型的一律是这里的返回值。 */
  async prepareContext(responder, opts) {
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
    const signal = this.controller ? this.controller.signal : undefined;

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
    // 「压缩块 N」用的是块数，所以自己带上 blocks 数。统计只留给 context_info 工具，不上界面。
    this.contextStats = Object.assign({}, built, { blocks: (blocks || []).length, tools });
    return built.messages;
  },

  /** 只取喂上下文用的两件：名字与说明（参数 schema 不进 [5] 段，太占 token） */
  contextTools(list) {
    return (Array.isArray(list) ? list : [])
      .map((t) => ({ name: String((t && t.name) || ""), description: String((t && t.description) || "") }))
      .filter((t) => t.name);
  },

  /** 档案类/外观类工具改完东西后的当场重绘（不刷新、不切卡）。
   *  info = { memberId, kind }，kind ∈ "name"|"persona"|"look"|"wallpaper"。
   *  私聊只有一个成员对象，改名/换装等于换的这一位自己；群聊卡里改别人不动顶栏。 */
  async applyProfileChange(info) {
    const store = this.ctx.store;
    const kind = String((info && info.kind) || "");
    // 1) 重读成员与会话（改的可能就是这一位）
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

    // 2) 顶栏：名字、外观、或会话自己的主题色变了才重建（重建后 bindHeadMenu 会重新绑手势）
    if (kind === "name" || kind === "look" || kind === "accent") this.renderHead();
    // 3) 气泡与头像：私聊气泡本来就吃 resolveAccent(this.conv, …)，会话色变了必须重画消息
    if (kind === "name" || kind === "persona" || kind === "look" || kind === "accent") {
      this.renderAccent();
      this.renderMessages();
    }
    // 4) 壁纸：只认 look/wallpaper，换颜色跟壁纸无关（同值不重放）
    if (kind === "look" || kind === "wallpaper") this.renderWallpaper();
    // 5) 广播：会话列表/详情卡要跟着换，别自己再造一套会话事件
    if (this.ctx && this.ctx.events && typeof this.ctx.events.emit === "function") {
      this.ctx.events.emit("profile:changed", {
        convId: this.convId,
        memberId: (info && info.memberId) || null,
        kind,
      });
    }
  },

  memberName(memberId) {
    if (!memberId) return this.convTitle();
    const m = this.members.find((x) => x.id === memberId);
    return m && m.name ? m.name : this.convTitle();
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
    this.ctx.router.push("detail-direct", { convId: this.convId });
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
    const r = await openConvMenu({ ctx: this.ctx, convId: this.convId, kind: "direct" });
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
    // 上次被杀/刷新留下的半截 streaming 一律降级成 aborted（内容保留）
    await recoverStreaming(this.ctx.store, this.convId).catch(() => {});
    await this.load();
  },

  async onLeave() {
    this.stopStream();
  },

  async unmount() {
    this.unmounted = true;
    this.stopStream();
    this.unsubscribe();
    this.root = null;
    this.ctx = null;
  },
};

export default card;
