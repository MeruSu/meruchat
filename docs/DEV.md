# meruchat 开发文档（唯一事实来源）

> **每个子代理开工前必须读完这份文件**。任何新决定、新文件、新坑，先来这里登记，再动手。
> 最后更新：2026-11-24

---

## 0. 一句话现状

网页版已经能跑（发消息、流式回复、多会话、单置顶、全局设置）。视觉是**粗糙的中间态**，正在把 `C:\Meru\website\su\preview\styles.html`（用户已肉眼确认过的设计稿）迁移进来。APK 能打出来（4.3MB），但装手机上还没验证过。

---

## 1. 目录与归属（谁可以改什么）

工作根目录：`C:\Meru\website\meruchat\webapp\`

| 路径 | 内容 | 谁可以改 |
|---|---|---|
| `index.html` | 壳，只有 `#cards` 容器 + CSS/JS 引用 | dev-a |
| `js/shell.js` | 壳：宽高比布局、卡片挂载、ctx 注入 | dev-a |
| `js/core/util.js` | 纯工具：`uid/now/hashStr/el/errorText` | dev-a |
| `js/core/store.js` | IndexedDB 数据层 | dev-a |
| `js/core/api.js` | `streamChat`（SSE + 20s 空闲超时） | dev-a |
| `js/core/router.js` | 卡片栈 | dev-a |
| `js/core/events.js` | 事件总线 | dev-a |
| `js/core/theme.js` | 把设置写到 `body` | dev-a |
| `js/core/context.js` | 上下文六段拼装 + 折叠/蒸馏（§2.6 唯一实现点） | dev-a |
| `js/core/tools/index.js` | 工具清单唯一出口 `createTools()`：`web_search` / `memo` / `context_info` / `set_name` / `set_persona` / `set_look`（六个） | dev-a |
| `js/core/tools/web-search.js` | `web_search`（tavily → firecrawl → exa → bing） | dev-a |
| `js/core/tools/memo.js` | `memo`（单条、无上限、整段覆盖） | dev-a |
| `js/core/tools/context-info.js` | `context_info`（只读自查上下文长度） | dev-a |
| `js/core/tools/profile.js` | `set_name` / `set_persona` / `set_look`（改「你自己」= 这一轮发言的成员） | dev-a |
| `js/ui/atoms.js` | `avatar/bubble/menu/confirmDialog/promptDialog` | dev-b |
| `js/ui/chat-head.js` | 顶栏组件（私聊/群聊共用） | dev-c |
| `js/ui/conv-menu.js` | 会话动作菜单（私聊/群聊共用，`⋮` 的唯一实现） | dev-c |
| `js/cards/list.js` | 会话列表卡片 | dev-a |
| `js/cards/settings.js` | 全局设置卡片 | dev-a |
| `js/cards/chat-direct.js` | 私聊会话卡片 | dev-c |
| `js/cards/chat-group.js` | 群聊会话卡片 | dev-c |
| `js/cards/detail-direct.js` | 私聊详情卡片 | dev-b |
| `js/cards/detail-group.js` | 群聊详情卡片 | dev-b |
| `css/theme.css` | **只有设计 token**（7 个 `body[data-skin="..."]{--var}` 变量块，全文无组件样式） | dev-a |
| `css/cards.css` | 壳布局 + 卡片公共外观 | dev-a |
| `css/card-list.css` | **列表卡片独有样式** | dev-a |
| `css/card-chat.css` | **聊天卡片独有样式** | dev-c |
| `css/card-detail.css` | **详情卡片独有样式** | dev-b |
| `css/card-settings.css` | **设置卡片独有样式** | dev-a |
| `preview/` | 单卡预览外壳 + 假数据 | dev-a（别人只能读） |
| `js/app.js` | **旧版单文件实现，只读参考，禁止再改** | 谁都不许改 |

**铁律**：改别人的文件前，先在这份文档里登记一行「谁改了什么、为什么」，否则不要动。

---

## 2. 视觉基准：`su/preview/styles.html`

**这是唯一的设计基准**（用户已在 `http://127.0.0.1:8899/styles.html` 肉眼确认过）。
路径：`C:\Meru\website\su\preview\styles.html`（1058 行，单文件自包含）。

### 2.1 三栏结构（必须照搬这套 DOM 语义）

```html
<div class="app">
  <aside class="phone-win sidebar-left">     <!-- 会话列表 -->
    <div class="sl-top"> <button class="sl-settings"><span class="sl-logo"></span></button> </div>
    <div class="conv-list" id="convList"></div>
    <button class="fab">＋</button>
  </aside>

  <main class="phone-win center">            <!-- 聊天 -->
    <div class="chat">
      <div id="wallpaper"></div><div id="dim"></div>
      <div class="chat-head">
        <span class="back">‹</span><div class="ava"></div>
        <div class="who"><span class="name"></span><span class="sub"></span></div>
        <div class="spacer"></div><span class="head-ico">⋮</span>
      </div>
      <div class="chat-body">
        <div class="divider"><span>今天</span></div>
        <div class="row them"><div class="bubble">…</div></div>
        <div class="row me"><div class="bubble">…</div></div>
      </div>
      <div class="chat-foot"><div class="pill">输入消息…</div><button class="send">➤</button></div>
    </div>
  </main>

  <aside class="phone-win sidebar-right">    <!-- 设置 / 详情 -->
    <button class="sr-back">‹</button>
    <div class="sr-scroll"> … </div>
  </aside>
</div>
```

### 2.2 设计 token（从 styles.html 抄，别自己调色）

```
--app-bg #f6f5f4   --chat-bg #ffffff   --text #000
--panel-bg #ffffff --panel-line #e6e6e6 --panel-soft #f6f5f4
--accent #0075de（另有 #00a884 / #7c5cff / #d97757 三色可选）
--bubble-them-bg #f6f5f4   --bubble-me-bg #e8f2fd
--bubble-radius 8px  --bubble-maxw 80%  --bubble-fs 15px --bubble-lh 1.55
--bubble-pad 9px 13px
--meta #615d59    --input-bg #f6f5f4
--frame-radius 8px --frame-border 1px solid #e6e6e6
--font Inter, -apple-system, "Segoe UI", system-ui, sans-serif
```

用户明确的口味（违反会被打回）：
- **不要阴影、不要遮罩**（只允许气泡上那一条极轻的 `--bubble-shadow`）
- **不要可见滚动条**（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`）
- 卡片要**纯白**（`#ffffff`），外面底色 `#f6f5f4`
- 气泡下不显示时间、不显示 ✓✓ 已读
- 设置页不要亮度/深浅/画幅选项，壁纸只留「渐变 / 深色」（**「无」已删除**）
- 颜色块不要文字标签

### 2.2.1 背景图的两层归属（2026-11-24 用户定，必须遵守）

用户原话（m04699）：
> 「私聊详情页 改的是当前聊天的背景」
> 「全局设置页 改的是[未]自定义改过的 默认的背景」

| 在哪改 | 作用范围 | 存哪 |
|---|---|---|
| **私聊详情 / 群聊详情** 卡 | **只影响这一个会话** | `conversations[i].wallpaper` / `.wallpaperDataUrl` |
| **全局设置** 卡 | **默认值**，给所有没单独设过的会话用 | `settings.wallpaper` / `settings.wallpaperDataUrl` |

**解析规则（唯一权威）**：

```js
// 取某个会话实际生效的背景
function resolveWallpaper(conv, settings) {
  const w = (conv && conv.wallpaper) || settings.wallpaper || "gradient";
  const url = w === "custom"
    ? ((conv && conv.wallpaperDataUrl) || settings.wallpaperDataUrl || "")
    : "";
  return { wallpaper: w, dataUrl: url };
}
```

- 取值域：`gradient` | `midnight` | `custom`
- `custom` 但 dataUrl 为空时，**回落到 `gradient`**（不要留白屏）
- 详情页要有「跟随默认」这一项：把 `conversations[i].wallpaper` 置为 `null`，就会用全局设置里的值
- 背景图**不加亮度/暗色遮罩**（用户否定过亮度）

### 2.3 唯一数据口径（用户给定，冻结）

```js
// ——— 用户（全局，原来的 settings）———
User = {
  name: string,                                  // 显示名，默认 "内测用户01"
  avatar: { label, color, image? },              // 你自己的头像
  defaultWallpaper: "aurora"|"forest"|"dusk",    // 默认聊天背景
  accent: "#0075de"|"#00a884"|"#7c5cff"|...,     // 颜色偏好（全局）
}

// ——— 会话（私聊与群聊同一套字段）———
Conversation = {
  id, kind: "direct"|"group",
  title: string,                                 // 标题
  avatar: { label, color, image? },              // 会话头像
  wallpaper: null | "aurora"|"forest"|"dusk",    // 聊天背景；null = 跟随用户默认
  accent:    null | "#0075de"|"#00a884"|...,     // 颜色偏好；null = 跟随用户默认
  pinned, createdAt, updatedAt,
  announcement?,                                 // 只有 group
  agentsMd?,
}
```

成员（Member）：

```js
Member = {
  id, name, avatar: { label, color, image? },
  accent: "#rrggbb" | null,        // 这个成员发言时的气泡颜色，null = 跟随用户默认
  persona, roleTag, sort,
}
```

- 群聊里**谁说的消息就用谁的颜色**：气泡色 = `store.resolveMemberAccent(member, user)` = `member.accent || user.accent || DEFAULT_ACCENT`。
- 群聊会话自身的 `conv.accent` 暂时**不参与渲染**（字段留着）。
- 默认色是**白**：`DEFAULT_ACCENT = "#ffffff"`，`ACCENT_COLORS` = `["#ffffff","#0075de","#00a884","#7c5cff","#d97757"]`（白 默认 / 蓝 / 绿 / 紫 / 橙）。
- `resolveAccent(conv, user)` 的兜底同样是白。

**头像颜色跟着主题色走**（用户定）：

```js
// 头像颜色解析：显式设置优先，否则跟随主题色
resolveAvatarColor(avatar, accent)  // avatar.color || accent || DEFAULT_ACCENT
```

1. `avatar` 有 `image`（上传/自定义图）→ 用图片，忽略颜色。
2. `avatar` 没有 `color`（或为 null）→ 颜色取主题色：
   - **用户自己的头像**：`resolveAvatarColor(user.avatar, user.accent)`。用户把主题色从蓝改绿，自己的头像色必须同步变绿。
   - **会话头像**（私聊/群聊）：`resolveAvatarColor(conv.avatar, resolveAccent(conv, user))` —— 跟**这个会话自己的**主题色。
3. 只有显式 `color` 才会盖住主题色；所以 `user.avatar.color` / `conv.avatar.color` 默认是 **null**，不许写死色值。
4. `settings:applied` 之后，凡是渲染头像的地方都要重算（各自的卡片订阅该事件）。

**详情页主题色控件**（用户定）：
- **私聊详情页永远不出现主题色控件**；私聊的 `conv.accent` 留给将来「AI 自己设置」，字段保留、默认 `null`。
- **群聊详情页保留主题色控件**；群头像在没有图片头像时 = 标题首字 + 主题色底。

### 2.3.1 主题色三件套（2026-11-24 用户定，冻结）

> 用户原话：「每个主题应该对应三个颜色，一个是这个颜色本身，一个是这个颜色的浅色版本作为气泡，一个是这个主题下的『白色』或者说白点色、背景色」

一个主题 = 用**一个 `accent` 派生出的四个 CSS 变量**，全项目唯一派生点是 `theme.deriveTheme(accent)`：

| 变量 | 含义 | 消费方 |
|---|---|---|
| `--accent` | 本色 | 发送键、发言人名、选中态、logo mask、头像底 |
| `--accent-soft` | 浅色版 | **气泡底色**（群里按发送者各自的 soft） |
| `--accent-surface` | 该主题下的「白」 | 卡片底、聊天区底、输入框底 |
| `--accent-on` | 压在本色上的字色 | 头像首字、按钮文字（深/浅自适应） |

派生规则（`js/core/theme.js` 的 `deriveTheme()`，**不许在 CSS 里再叠 `color-mix`**）：
- **浅色主题**（`relativeLuminance(base) > 0.7`，含默认浅灰 `#e5e5ea`）：`base` = 本色；`soft` = 本色混白 **45%**（`#e5e5ea → #f3f3f6`）；`surface` = `#ffffff`；`on` = `#1c1c1e`。判据是 0.7，**不是** `isWhiteish()`（0.95）——那个只管旧数据迁移。
- 彩色主题：`base` = 本色；`soft` = 本色混白 12%；`surface` = 本色混白 97%；`on` = 相对亮度 > 0.6 用 `#1c1c1e`，否则 `#ffffff`。
- **白色主题已下线**（用户：「主题色不要有白色，把那个白色改成浅灰色」「那个描边有点丑，我们不要描边了」）：`DEFAULT_ACCENT = #e5e5ea`（iOS systemGray5），`ACCENT_COLORS` 首项同值；老数据里的 `#ffffff` / 近白一律迁到 `#e5e5ea`（设置级）或 `null`（会话/成员级 = 跟随默认）。**全项目不再有 0.8px 描边这套做法**；气泡与卡面的分界只靠 `soft` 与 `surface` 的色差（这就是 45% 权重的由来）。
- 群聊气泡按发送者取色时，`paintBubble()` 必须**同时写 `--accent` 与 `--accent-soft`** 两个变量。
- 气泡的 `--bubble-shadow`（style-kit 的软影）**保留**，卡片 CSS 不许写 `box-shadow: none` 去抹它。

规则（硬性）：
1. 解析只有这几个函数，全项目唯一入口：`store.resolveWallpaper(conv, user)` → 三个壁纸值之一；`store.resolveAccent(conv, user)` → 色值；`store.resolveMemberAccent(member, user)` → 成员气泡色；`store.resolveAvatarColor(avatar, accent)` → 头像底色。**任何卡片都不许自己读 `conv.wallpaper || user.defaultWallpaper` 再兜底。**
2. 落 DOM 也只有三处：壁纸用 `theme.applyWallpaperLayer(el, w)`（只打 `data-wall`，不写内联 background）；颜色用 `theme.deriveTheme()` 一次写四个变量到卡片根；成员级气泡在气泡元素上写 `--accent` + `--accent-soft`。
3. 事件（名字冻结，payload 冻结）：
   - `conv:changed { id }` — 会话的标题/头像/壁纸/颜色/公告 任一变更
   - `wallpaper-changed { convId }`
   - `settings:applied { user }` — 用户四个字段任一变更后，shell 会重播到 body
   - `settings:changed { patch }` / `toast { text }` 不变
4. `user` 对象就是 `store.ready()` 返回的 `settings`（字段照上面四个），别再造第二个容器。

> §2.2.1 的 `wallpaperDataUrl / custom` 口径与本节冲突，以本节为准（自定义背景图已下线）。

### 2.4 styles.html 里已经写好的、必须复用的组件

| 组件 | 类名 | 说明 |
|---|---|---|
| 头像 | `.ava` / `.c-ava` / `.big-ava` / `.avatar-block` | 圆形，首字，渐变底 |
| 会话行情 | `.conv` / `.conv.active` / `.c-ava` / `.c-main` | 置顶项左侧 2px accent 竖线 |
| 气泡 | `.row.them` / `.row.me` / `.bubble` | them 左、me 右 |
| 代码块 | `.code` / `.code pre` / `.copy` | 带「复制」按钮 |
| 引用块 | `.quote` / `.qname` / `.qtext` | 左侧 accent 竖线 |
| 日期分隔 | `.divider` | 居中胶囊 |
| 输入区 | `.chat-foot` / `.pill` / `.send` | 胶囊 + 圆形发送 |
| 设置色块 | `.swatches` / `.sw.active` / `i` | 4 个圆点 |
| 壁纸层 | `#wallpaper` / `#dim` | 挂在**不滚动的** `.chat` 上 |
| logo | `.sl-logo` | CSS mask 染色 `assets/merusu-logo.png` |

### 2.5 动效规范（2026-11-24 用户要求「把动效搞一下」，冻结）

**唯一动效层：`css/motion.css`。** 它只放三样东西：时长/曲线 token、`@keyframes`、通用动效类（`.anim-*`）。
各 `card-*.css` 与 `cards.css` **只允许引用这里的 token**，不许自己写数字时长、不许自己写 `@keyframes`。

**token（抄，不许改数值）：**

```css
:root {
  --dur-1: 120ms;                                        /* 按下 / hover / 图标切换 */
  --dur-2: 180ms;                                        /* 气泡出现 / 状态过渡 / 遮罩 */
  --dur-3: 260ms;                                        /* 卡片进出 / 弹层面板 / 主题与壁纸 */
  --ease-out: cubic-bezier(0.2, 0, 0, 1);                /* 进场、位移 */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);                 /* 退场 */
  --ease-spring: cubic-bezier(0.34, 1.36, 0.64, 1);      /* 只给气泡用 */
}
```

**硬规则（违反就算不合格）：**

1. **禁止过渡 layout 属性**（`width`/`height`/`top`/`left`/`right`/`margin`/`padding`/`font-size` 一律不许进 `transition`/`@keyframes`，会触发 layout，流式时抖）。**允许**动：`transform` / `opacity` / `filter` / `background-color` / `color` / `border-color`。装饰性淡化可以用 `color-mix`，但 `--accent-soft` / `--accent-surface` / `--accent-on` **仍只能由 `theme.deriveTheme` 派生**（§2.3.1），不许在卡片 CSS 里自己 mix 出这三个变量。
2. **最长 260ms**（`--dur-3`）。用户要"快"，不许出现 300ms 以上的动画。
3. `@media (prefers-reduced-motion: reduce)` 里必须把全部动画时长压到 `0.01ms` 且只保留 opacity 变化。
4. 列表/消息**重绘不许重放动画**：只有"新增节点"能带动效类（用 `.anim-enter` 挂一次，`animationend` 后移除；`renderMessages()` 全量重画时一律不加）。
5. `.chat-body` **不许**加 `scroll-behavior: smooth`（流式吸附会发飘），仍用 JS 直接设 `scrollTop`。
6. 骨架/闪烁类（skeleton、breathing）**不许常驻**：只在"正在流式输出 / 正在加载"期间存在，结束必须移除。

**动效清单与归属（只做这些，不许自行加戏）：**

| # | 动效 | 归属 | 规格 |
|---|---|---|---|
| 1 | 窄屏 push 进场 | dev-a（`shell.js` + `cards.css`） | 新卡 `translateX(24px)→0` + `opacity 0→1`，`--dur-3` `--ease-out` |
| 2 | 窄屏 pop 退场 | dev-a | 被卸的卡 `translateX(-12px)` + `opacity→0`，`--dur-2` `--ease-in`，**`animationend` 后再 `remove()`**（不许立刻删） |
| 3 | 宽屏换右槽 | dev-a | 只做 `opacity 0→1` `--dur-2`，**不许位移**（两张卡一起晃会晕） |
| 4 | 首屏 | dev-a | `.cards` 整体 `opacity 0→1` `--dur-3`，防白闪 |
| 5 | 会话行 hover / active | dev-a（`card-list.css`） | `background-color var(--dur-1) var(--ease-out)`；左侧 2px accent 竖线用 `opacity`/`scaleY` 出现，**不许动 `width`** |
| 6 | 会话列表 stagger | dev-a | 前 8 行 `translateY(4px)→0` + 淡入，`animation-delay: calc(var(--i) * 24ms)`，总时长不超 400ms |
| 7 | FAB 按下 | dev-a | `transform: scale(.94)`，`--dur-1` |
| 8 | 新气泡出现 | dev-c（`chat-*.js` 加类） | `translateY(6px)→0` + 淡入，`--dur-2` `--ease-spring`；**只有新增那条**加 `.anim-enter` |
| 9 | 发送键按下 / `➤↔■` | dev-c | `scale(.92)` `--dur-1`；图标切换 `opacity` 交叉 `--dur-1` |
| 10 | 群聊「正在输入」 | dev-c | 三点或状态点 `opacity 1→.35→1` 无限循环 1.2s，**流式结束必须移除**（同硬规则 6） |
| 11 | 详情卡成员头像 | dev-b | 按下/悬停 `scale(1.06)` `--dur-1`；编辑弹层：遮罩 `opacity` `--dur-2`、面板 `translateY(12px)→0` `--dur-3` |
| 12 | 主题色 / 壁纸切换 | dev-a | 吃 `--accent*` 的元素 `transition: background-color/color var(--dur-3) var(--ease-out)`；壁纸层 `opacity` 交叉淡入 `--dur-3` |

**验收口径**：每一项都要给 `getComputedStyle(el).transitionDuration` / `animationName` 的实测值，并在 `prefers-reduced-motion: reduce` 下复测一次（Emulation.setEmulatedMedia），证明不会动。

---

### 2.6 上下文构成：原生 Billion Context（2026-11-25 用户定，冻结）

用户原话：「上下文构成 agents md + 设定 + 压缩块1，2，3… + memo + 未压缩会话与工具结果　我们要原生有 Billion context」。

**发给模型的消息必须严格按这六段拼，顺序不许改**（稳定的在前，为了 prefix cache 命中尽可能长）：

```
[1] system   AGENTS.md        conversations.agentsMd（会话规则），空则整段省略
[2] system   设定 / 人格      当前成员 persona，空则省略
[3] system   压缩块 1..N      每块一行前缀「【压缩块 k｜原第 a–b 条】」+ 摘要正文，按 index 升序
[4] system   memo            单条备忘（一段自由文本，无 key），原文整段注入
                              memo 全局唯一（不按会话分桶）：`memo` 工具与上下文注入读写的都是同一个全局桶
[5] system   工具与时间       合成一条，永远存在（用户 2026-11-25 要求「在 4-5 位置插入工具列表与当前时间」）：
                              首行「当前时间：2026-11-25 02:30（周三）· Asia/Singapore」
                              次行「可用工具（需要时直接发起工具调用，不要凭空编造工具结果）：」
                              之后每行「- 名字：描述第一句」（超 60 字截断加「…」）；工具清单为空时只出时间那行
[6] 原样消息  未压缩的会话     按 seq 升序；assistant 属于当前成员才是 assistant，别人一律 user + 「名字」：前缀
                              （与 §2.3 群聊角色映射一致）；本轮工具结果夹在其后，见下
```

**唯一实现点**：`js/core/context.js`，导出 `buildContext({ conv, members, responder, messages, blocks, memo, tools, now, timeZone, budget })` → `{ messages, estimated, folded, parts }`。
`tools` 是 `[{ name, description }]`（卡片传本轮真正交给模型的那一份，只保留这两个字段）；`now` 缺省 `new Date()`；`timeZone` 缺省 `Intl.DateTimeFormat().resolvedOptions().timeZone`。`parts` 因此有 `agentsMd / persona / blocks / memo / tools / history` 六个键。
[5] 的正文由 `buildToolAndTimeText(tools, now, timeZone)` 单独产出（已导出，便于单测）。
`memo` 是**字符串**（单条备忘原文），不是 `{key: text}` 对象。
**任何卡片不许自己拼 messages**（`chat-direct.js` 现在的 `buildTranscript()` 必须删掉改调它）。

**token 估算**（浏览器没有 tiktoken，用估算法，只用于触发判断，不用于计费）：CJK 一字算 1，其它字符 4 个算 1，每条消息再加 4。

**折叠（压缩）触发**：
- 设置项 `contextBudget`，默认 **8000**（可调 2000–100000；**0 = 关闭压缩，全量直喂**，行为等同改造前）。
- 每次发新消息前跑一次：`estimated > budget` 且未压缩消息 ≥ 4 条才折叠。
- 取最旧的一批，目标 ≈ `budget / 2` token，至少 2 条、最多 40 条；**同一轮的 tool_call 与 tool_result 必须在同一批**（不许切开）。
- 折叠成功后写 `blocks` 表，并给这批消息打 `foldedBlockId`（**消息本体不删**，UI 照常显示，只是不再喂模型）。
- **摘要失败就什么都不做**（宁可上下文长，不许丢历史），本轮照常发请求。
- 折叠只发生在**发新消息前**，流式过程中绝不折叠。

**压缩块记录**（`blocks` 表，DB_VERSION 3）：

```js
Block = { id, conversationId, index, fromSeq, toSeq, count, summary, tokens, createdAt }
```

- `index` 从 1 递增 = 用户说的「压缩块 1、2、3」。
- **块数上限 8**：新建第 9 块时，把 1–4 块蒸馏成一块（T2），其余顺延重编号。蒸馏会重建整个块区，接受这一次 cache miss。

**摘要提示词固定结构**（`js/core/context.js` 里的 `SUMMARY_PROMPT`，不许各卡片另写）：

```
把下面这段对话压缩成结构化笔记，只输出这五行标题的内容，不要寒暄：
用户目标：
已确定的决定：
未完成事项：
关键事实与数字：
涉及的人与称呼：
```

**工具结果**：只在**本轮**进上下文，超过 `TOOL_RESULT_CONTEXT_MAX = 2000` 字符截断并标 `…（截断，原 N 字）`；跨轮工具结果不落库（现状不变），它们只以摘要形式留在压缩块里。

**设置项**（`store` 的 settings 里加）：`contextBudget`（默认 8000）、`contextCompress`（默认 true，false 时不折叠）。两处都进设置卡。

**可见性**（最小集，只说数字，不做花活）：聊天卡底栏一行 `压缩块 N · 未压缩 M 条 · 约 X.Xk`；详情卡加「上下文」区块，列出各块的序号 / 覆盖范围 / 摘要首 60 字 / token，点开看全文，底部一个「立即压缩」按钮（调 `store.foldOldest()`）。

---

## 3. 卡片契约（接口不许改）

每张卡是 ES module，默认导出：

```js
export default {
  id: 'list',
  title: '会话',
  async mount(root, ctx) {},   // root 是壳给的空容器
  async unmount() {},
  async onEnter(params) {},    // 数据一律在这里读，不要在 mount 里读
  async onLeave() {},
};
```

`ctx`（由 shell 注入，所有卡片共用同一份）：
```js
{
  store,      // core/store.js 实例
  api,        // { streamChat }
  router,     // { stack, push(id,params), back(), replace(), reset(), current() }
  events,     // { on(name,fn)->unsub, emit(name,payload) }
  settings,   // 只读快照 { accent, skin, wallpaper, dim, baseUrl, model, apiKey }
  openSheet(items),          // Promise<key|null>
  prompt(title, value),      // Promise<string|null>
  confirm(textOrOpts),       // Promise<boolean>
}
```

store 的方法（全部已实现，直接用，不要自己写一份）：
`listConversations / getConversation / putConversation / updateConversation / touchConversation / setPinned / deleteConversation / listMembers / getMember / putMember / addMember / updateMember / deleteMember / listMessages / addMessage / clearMessages / deleteMessages / getSettings / setSettings`

两个容易写错的签名（**按这个写**）：

```js
// 新建会话：对象参数（唯一签名）。kind 不能由成员数推断，删到 1 人也仍是群聊。
createConversation({ kind = "direct", title, members = [] }) → Promise<{ conversation, members }>
// 兼容层：第一个参数是字符串时按旧签名 (title, members, kind) 处理，老调用不炸。

// 追加消息：调用方不必给 id / seq / ts（keyPath 是 id，缺 id 会直接 DataError）
addMessage({ convId, role, content, memberId?, id?, seq?, ts? }) → Promise<消息对象>
//   缺 id → uid()；缺 seq → 该会话现有最大 seq + 1；缺 ts → now()；缺 convId → reject
```

事件名（**两种拼写都要监听**，历史原因）：
`conversations-changed`、`members-changed`、`messages-changed`、`conversation-removed`、`conversations:changed`、`route`、`toast`、`settings:changed`、`settings:applied`

---

## 4. 预览（每张卡必须能单独打开）

**开发用真实服务（推荐，凡是要发消息/量 IndexedDB 都用它）**：

```
node dev-server.mjs 8915
```

它同时做两件事：静态文件（一律 `cache-control: no-store`，不会量到旧值）+ 同源反代 `/gw/*` → 本机 magpie `127.0.0.1:3425`（本机网关不发 CORS，浏览器直连会被 preflight 拦死，见坑 7）。

| 链接 | 内容 |
|---|---|
| `http://127.0.0.1:8915/` | 整合版（真 IndexedDB + 真网关），**日常验收主入口** |
| `http://127.0.0.1:8915/phone.html` | **9:19 手机比例预览**：单文件壳，`aspect-ratio:9/19` + 内嵌 `<iframe src="index.html">`（同源，数据/路由/主题全真），底部实时打印 `9:19 · W×H`。用户要"锁比例看整包"时给这个 |
| `http://127.0.0.1:8915/preview/?card=list` | 会话列表卡 |
| `http://127.0.0.1:8915/preview/?card=chat-direct` | 私聊会话卡 |
| `http://127.0.0.1:8915/preview/?card=chat-group` | 群聊会话卡 |
| `http://127.0.0.1:8915/preview/?card=detail-direct` | 私聊详情卡 |
| `http://127.0.0.1:8915/preview/?card=detail-group` | 群聊详情卡 |
| `http://127.0.0.1:8915/preview/?card=settings` | 全局设置卡 |
| `http://127.0.0.1:8915/preview/?all=1` | 六张卡整排（看视觉一致性）。`harness.js:51` 认三种写法：查询参数 `all`、路径以 `/all` 或 `/all.html` 结尾；静态服务不兜底返回 index.html，路径写法会 404，**用 `?all=1`** |

预览走 `preview/mock.js` 的假数据（1 私聊 + 1 群聊 + 8 条消息），**不碰 IndexedDB、不联网**。加 `&scenario=empty` 看空态。

**只做纯样式对照时**（不跑应用）：`preview/serve.mjs` 起在 8914（Node，也发 `no-store`）；`su/preview/styles.html` 的设计稿对照在 8899。注意 **8914 这个 origin 的 IndexedDB 曾经坏过**（`indexedDB.open` 直接 hang），所以不要在 8914 上验真应用，只用来看卡片。

**iframe 里做验收必须用 `contentWindow.eval`**，见 §5 坑 20。

---

## 5. 已踩过的坑（别重踩）

1. **沙箱禁止子进程**：`workspace-write` 下 npm/gradle/flutter 全部跑不了（`ProcessException: 拒绝访问`）。需要 danger-full-access。
2. **DO / Worker 部署后旧实例还在跑旧代码**：必须 `systemctl stop` → 等 80s → `start` 驱逐。否则新路由 404。
3. **本机 schannel 坏**：`Invoke-WebRequest` / python urllib 打 Cloudflare 会报 `Authentication failed` / 1010。用 `node fetch` 或 `curl.exe -x http://127.0.0.1:65532`。
4. **Gradle 走代理**：需要 `GRADLE_OPTS`/`JAVA_TOOL_OPTIONS` 带 `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=65532`，且**不能**在值里出现 `|`（会破坏 bat 解析）。
5. **Android debug keystore**：默认写 `%USERPROFILE%\.android\`，沙箱拒绝。已在 `android/app/build.gradle` 配了项目内 `meruchat-debug.keystore`。
6. **Capacitor 8 要 JDK 21**：`C:\Meru\website\toolchains\jdk21`（本机原本只有 17）。
7. **网关不处理 CORS**：浏览器直连 `gw.ms7.pw/v1` 会 `Failed to fetch`。必须走 `https://gw.ms7.pw/cors/v1`（港机上的 `gw-cors.service`，3426 端口，隧道按 `^/cors/.*` 分流）。
8. **SSE 读流没有 done**：代理可能不关连接，必须用空闲超时兜底（`api.js` 的 `IDLE_TIMEOUT_MS = 20000` + `Promise.race`）。
9. **`atoms.js` 与 `util.js` 不能有同名不同签名的函数**：`confirmDialog` 只保留 atoms 的对象参数版，util 里已删除。
10. **发消息绝不碰 `pinned`**：只调 `store.touchConversation(id)`。置顶只能由用户手动操作。
11. **`css/theme.css` 里没有任何组件样式**：它全文只有 7 个 `body[data-skin="..."]{--var:...}` 变量块（notion/wa/gpt/claude/tg/imessage/night）。写 `card-*.css` 时**不能假设** `.big-ava` / `.avatar-block` / `.field` / `.section-title` / `.swatches` / `.sw` 已有样式，必须自己从 `styles.html` 364-460 行抄全。（曾经的错误假设：有人在 card-detail.css 注释里写"这些类在 theme.css 里已经是逐字拷贝"，实际没有，导致 `.big-ava` 渲染成 118×23px 的绿色方块、圆角 0。）
12. **本机浏览器把所有 <15px 字号钳到 15px**：写 12px 的 `.chat-sub` / `.meta` 会算出 15px。这是浏览器最小字号下限，不是 CSS 写错；真机/别的浏览器上是 12px。**不要为此改设计值**。
13. **预览页每张卡必须是 9:18 竖屏**：`preview/index.html` 的 `.pv-frame{aspect-ratio:9/18}`，单卡模式一张居中，`?all=1` 是三列两行。卡内 `height:100%;overflow-y:auto`，不允许卡片自身撑破外框（撑破过一次，导致三张卡变成 0.38–0.44 的怪比例）。
14. **改完 CSS/JS 后量不到新值 = 缓存，不是代码错**：`python -m http.server` 只发 `Last-Modified` 不发 `ETag`，Chromium 走启发式缓存，ES module 和 CSS 都可能不重新拉（`performance.getEntriesByType('resource')` 里 `transferSize: 0` 就是没拉）。**现在 8914 已经换成 `preview/serve.mjs`（Node，发 `cache-control: no-store`）**，起法：`node preview/serve.mjs 8914`。老的 python 服务器留给 8899（styles.html 对照用）。若换成它还在量旧值，先 `ego_navigate` 到 `about:blank` 再回来。
15. **验收必须看到「实测数字」，不算「看起来对」**：每条视觉要求都要用 `getComputedStyle` / `getBoundingClientRect` 取具体值，写进报告。用户明确驳回过「功能跑通就算通过」。
16. **`.chat-body` 的 `--body-pad` 百分比以 `.chat` 为分母、`.row` 的 margin 百分比以 `.chat-body` 为分母，两者不可互换**：`padding:… var(--body-pad)` 的 8% 按 `.chat` 内容宽解析（346 → 27.69px），而 `.row{margin-left:8%}` 的 8% 按 `.chat-body` 内容宽解析（290.6 → 23.25px），差 `2·p²·W ≈ 4.4px`，再加卡片 1px 描边。所以 `margin-left:calc(11px - var(--body-pad))` 永远到不了 11px（实测 16.2），写死 `calc(11px - 8%)` 也只能抵掉一个基准。**本项目的头像外移用固定 `-16px`**（`css/card-chat.css` 的 `.row.them` / `.row.me`），27.69 − 16 = 11.69px ≈ 头像宽度 1/3（36/3 = 12）。若将来启用别的皮肤或改 `--body-pad`，这 16px 要跟着重算。
17. **`flex:1 1 auto` 的 `.msg-col` 必须显式写 `align-items`**：列宽被撑开之后 flex 默认 `align-items:stretch` 会把短句气泡强行拉满整列（实测 449.7px，而文案只需要 180px）。`.row.them .msg-col` 要 `align-items:flex-start`，`.row.me .msg-col` 要 `align-items:flex-end`。同时 `.msg-col` 的 `max-width` 只有写成 `calc(100% - 44px)`（100% 指 `.row` 宽）才是确定值；写成占 `--bubble-maxw` 的百分比会让 `.bubble` 的百分比失去分母，气泡塌到最小（实测小满那条一度被压成 72×65 折 4 行）。
18. **气泡的视觉边界靠色差不靠线**：用户否掉了 `box-shadow: 0 0 0 0.8px rgba(60,60,67,.29)` 那圈描边，也否掉了「白色主题」（`DEFAULT_ACCENT` 现在是浅灰 `#e5e5ea`）。但**style-kit 的 `--bubble-shadow` 两层软影要保留**（那是厚度不是边框），所以卡片 CSS 里不许写 `box-shadow: none`。浅色主题的 `soft` 权重必须是 0.45（`#e5e5ea` → ≈`#f3f3f5`）；用 0.12 会得到 `#fcfcfc`，在白卡面上等于隐形。
19. **`atoms.js` 的 `close()` 里 mask 会同时带 `anim-fade-in` 和 `anim-fade-out` —— 这是已知且可接受的状态，不要去"修"**：`openOverlay()` 入场挂 `anim-fade-in`，`close()` 再挂 `anim-fade-out` 而没摘前者。实测 `getComputedStyle(mask).animationName` 是 `anim-fade-out`（`css/motion.css` 里 `.anim-fade-out` 定义在 `.anim-fade-in` 之后，同优先级下后写的 `animation` 简写胜出），视觉与退出时机都正确，`pointer-events:none` 也来自 `.anim-fade-out`。真要清理，正确做法是 `close()` 里先 `classList.remove("anim-fade-in")` 再 `add("anim-fade-out")`；但要重跑一遍弹层入场/退场验收，收益不抵风险。**新写的动效代码不要模仿这个写法**，同一个元素身上不要同时留一进一出两个动效类。
20. **在 iframe 里操作页面必须用 `win.eval(...)` 进那一侧的 realm**：`fr.contentDocument.body.appendChild(...)` 与模块内部的 `document.body` 不是同一个 realm，跨 realm append 的节点在页面的模块代码眼里可能取不到（`openOverlay` 造出来的 mask 会"消失"）。ego_eval 里的正确写法是 `await fr.contentWindow.eval("(async () => { ... })()")`，模块 `import()` 与 DOM 操作都写在那一侧。**跨 realm 还会在父页面 body 上留下 `modal-mask` 垃圾节点**（本轮清了 4 个），发现问题先查 `document.body.children`。

---

## 6. 当前进行中 / 已知缺口

- [ ] 视觉迁移：六张卡按 `styles.html` 重做样式（**这是当前最大缺口**）
- [x] 私聊详情：DOM 逐字照搬 styles.html 第三页（833-869 行），删掉主题色块；2026-11-24 dev-b 完成（结构实测见 §7）
- [x] 群聊详情：同一套第三页 DOM + 成员墙 `.member-grid > .m-ava`；2026-11-24 dev-b 完成
- [ ] **操作入口统一在聊天气泡卡的 ⋮ 菜单，详情页不承载操作**（lead 2026-11-24 定）：置顶 / 取消置顶、清空聊天记录、删除会话、删除群聊的入口都放在 `card-chat` 的 `⋮` 菜单（dev-c 负责），详情页保持第三页原样，**不要**在 `.sr-scroll` 末尾加 `.row` 操作行。群聊成员墙的「改名/人格、移除」「添加成员」仍留在详情页（点头像 / 点「成员」小标题）。
- [x] 全局设置：删掉「亮度」滑块；壁纸收成「渐变/深色/自定义」+「上传图片」（用户否定过亮度与「无」）；2026-11-24 dev-a 完成，`settings.js` 照搬第三页 DOM
- [x] 详情页两张卡已在浏览器里点过（2026-11-24 dev-b，9:18 预览框实测）
- [ ] 群聊多成员串行回复没真跑过
- [ ] APK 没在真机上装过
- [ ] 壁纸/主题色切换的实际视觉效果没截图确认

---

## 7. 登记区（新决定写在这里，写清日期 + 谁）

| 日期 | 谁 | 变更 |
|---|---|---|
| 2026-11-24 | lead | 建立本文档；建立 `css/card-*.css` 四个按卡片划分的样式文件；建立 `preview/` 单卡预览 |
| 2026-11-24 | lead | 预览页全部改为 **9:18 竖屏**（`.pv-frame{aspect-ratio:9/18}`），`?all=1` 三列两行 |
| 2026-11-24 | lead | 确认 `theme.css` 只有 token、无组件样式；加了坑 11/12/13 |
| 2026-11-24 | dev-c | 写 `css/card-chat.css`（434 行），视觉照 `styles.html` notion skin；选了方案 A（不动 JS，按真实 DOM 补选择器） |
| 2026-11-24 | dev-a | 写 `css/card-list.css` + `css/card-settings.css` |
| 2026-11-24 | dev-b | 写 `css/card-detail.css`（312 行）——**但基于"theme.css 已有组件样式"的错误前提，头像没生效，待重做** |
| 2026-11-24 | dev-a | 已读（含 §2.2.1 背景图两层归属）。`cards.css` 收成纯壳布局（业务样式全部搬去 `card-*.css`），`theme.css` 收成纯 token（7 套 skin 变量），`card-list.css` / `card-settings.css` 按 styles.html 重写；`settings.js` 删亮度滑块、壁纸收成「渐变/深色」 |
| 2026-11-24 | dev-b | **详情两卡照搬第三页**：`js/cards/detail-direct.js`（401 行）/ `detail-group.js`（580 行）的 DOM 逐字照搬 styles.html 833-869 行，只做四处差异（删主题色 `.swatches` 块、壁纸 `<select>` 换 4 项 + `上传图片` 按钮、群聊插成员墙、文字换变量）。两个 JS 里**不再有任何视觉内联样式**（成员墙头像底色取自 atoms 的 `data-av-grad`，不新造色板）。|
| 2026-11-24 | dev-b | `css/card-detail.css` 从 333 行砍到 **29 行**：只留 `.card.card-detail{背景/height/滚动/隐藏滚动条}` + `.member-grid` / `.member-grid .m-ava`。**第三页的组件样式一律交给 `css/style-kit.css`，不在本文件重写**（上一轮「假设 theme.css 已有组件样式」的坑见 §5 坑 11）。|
| 2026-11-24 | dev-b | **动了 dev-a 的文件 `preview/index.html`（登记在此）**：给预览页补一行 `<link rel="stylesheet" href="../css/style-kit.css" />`（放在 theme.css 之前，与 `index.html` 顺序一致）。原因：预览页原先不加载 style-kit.css，照搬过去的 class 在 `?card=detail-*` 里全部无样式，验收量不到第三页的值。 |
| 2026-11-24 | lead | 三条定案：① `.big-ava` **保持 `width:33%`**，不许再出现 `max-width` 硬像素（预览框 348 宽 => 103，真机 390 宽 => 约 118）；② **详情页不加操作行**，置顶/清空/删除统一放聊天气泡卡的 `⋮` 菜单（dev-c 做，见 §6）；③ 详情卡**去掉 5 个写死 id** 的做法成立（`?all=1` 会同时挂两张详情卡，固定 id 撞车），继续用 `querySelector` 取元素。|
| 2026-11-24 | lead | **主题色三件套（用户定）**：一个 accent 派生 `--accent` / `--accent-soft`（气泡）/ `--accent-surface`（该主题下的白）/ `--accent-on`（字色），唯一派生点 `theme.deriveTheme()`，写入 §2.3.1。白色主题特例：soft 仍为白、靠 0.8px 描边，surface 取 `#f2f2f7`。所有卡片禁止在 CSS 里再写 `color-mix`。 |
| 2026-11-24 | dev-c | **顶栏收成组件** `js/ui/chat-head.js`：`chatHead({ava,name,sub,onBack,onMore})` 返回 styles.html 756-765 行的 `.chat-head` 原样 DOM，`chat-direct.js` / `chat-group.js` 共用一份，任何人要改顶栏只改这一个文件。私聊 `sub`=`在线`，群聊 `sub`=`N 位成员`。群聊原先的叠放头像（`.ava-stack` / `.mini`）**整个删除**，群头像回到单个 `.ava`，与私聊同构。|
| 2026-11-24 | dev-c | 两张聊天卡的 `.chat` 都加 `no-tail`：气泡改用 styles.html 自带开关 `.no-tail .bubble::before{display:none}` + `border-radius:var(--bubble-radius)`，**不要自己写去尾圆角的 CSS**。|
| 2026-11-24 | dev-c | **群聊对方消息带 28px 头像** `.row.them > .msg-ava`（自己那侧 `.row.me` 不放；私聊卡一条头像都没有）。`css/card-chat.css` 因此只剩 4 条选择器：`.row.them`（gap 8px + align-items:flex-start）、`.row.them .msg-ava`（28px 圆形，可换行登记：`.card-chat` 前缀）、`.row.them .bubble{max-width:calc(var(--bubble-maxw,78%) - 36px)}`（让出头像宽度，私聊不受影响）、`.row.them .bubble .who-name`（发言人名）。卡片不写任何视觉值，其余全交给 `css/style-kit.css`。（**已被下面 34px 两段式那一行取代**，仅留作历史）|
| 2026-11-24 | dev-c | **`⋮` 真的能点了**：`chat-head.js` 把 `.head-ico` 从 `span` 换成 `<button type="button" aria-label="更多">⋮</button>`（仍是 `.chat-head` 直接子节点、位置不变，样式仍由 style-kit 的 `.chat-head .head-ico` 给，只在元素上内联一行 `background/border/padding/font/color/cursor` 复位 UA 外观，不新增 CSS）。菜单与行为收在 **`js/ui/conv-menu.js` 的 `openConvMenu({ctx,convId,kind})`**，私聊/群聊共用一份、只靠 `kind` 换文案：置顶项按 `conv.pinned` 显示「置顶 / 取消置顶」，私聊 `重命名 / 删除会话`，群聊 `重命名群 / 删除群聊`，两边都有「清空聊天记录」。清空只删消息不删会话；删除走 `store.deleteConversation` 后 `router.back()`；置顶走 `store.setPinned`（唯一置顶不变量在 store 里）。**事件名对齐列表卡：会话被改 emit `conv:changed`（`{id}`，list.js:162 在听），会话被删 emit `conversation-removed`（`{convId}`，shell.js:397 收回路由栈）；`conversations-changed` / `conversations:changed` 都不要再发。**|
| 2026-11-24 | dev-c | **群聊消息行改成「头像 + 列」两段式**：`.row.them` = `.msg-ava` + `.msg-col(.who-name + .bubble)`，`.row.me` 镜像成 `.msg-col + .msg-ava`；名字一律在**气泡外面**、气泡上方（`.who-name` 的父节点是 `.msg-col`，不在 `.bubble` 里）。头像两侧同尺寸 **36px**（字号 **15px**），自己那侧底色用固定种子（改名不换色），首字与名字来自 `store.getSelf()`，卡里**不自己实现取首字母**。`css/card-chat.css` 因此是 7 条：`.row.them`（gap 8 / flex-start / `margin-left:-16px`）、`.row .msg-ava`（36px，两侧共用）、`.row.them .msg-col`（`max-width:calc(var(--bubble-maxw,78%) - 44px)`）、`.row.them .who-name`、`.row.me`（`margin-right:-16px` + `width:auto`，见下方坑）、`.row.me .msg-col`（名字靠右，同样 `- 44px`）、`.row.me .who-name`。私聊仍然一行头像都没有（`.row .msg-ava` = 0）。|
| 2026-11-24 | lead | **头像外移改成固定像素，不许再用 `calc(11px - var(--body-pad))`**：`.card-chat .row.them{margin-left:-16px}`、`.card-chat .row.me{margin-right:-16px}`。理由：百分比换基准那 4.4px 的坑绕不过去（见 §5 坑 16），而 `style-kit.css` 只读，宁可固定像素。当前唯一发货皮肤 notion（`--body-pad:8%`、卡片内容宽 346）下 27.69 − 16 = **11.69px**，即头像宽度 1/3（36/3 = 12）。|
| 2026-11-24 | lead | 头像再放大 5%（34 → **36px**，34×1.05 = 35.7 取整），连带三处：字号 14 → **15px**；`.row.them/.row.me` 的外移 `-17px` → **`-16px`**（保持头像宽度 1/3 的留白：27.69 − 16 = 11.7）；`.msg-col` 的 `max-width` 扣减 `42px` → **`44px`**（36 头像 + 8 间距）。实测 4 个头像全 36×36、对方左缘与自己右缘 11.69/11.69、`.chat-body` scrollWidth == clientWidth（346==346，无横向溢出）。|
| 2026-11-24 | dev-c | **两处偏差经 lead 确认保留**：① 头像尺寸规则的选择器写成 `.row .msg-ava` 而不是清单里的 `.row.them .msg-ava` —— 自己要也是 36×36 且"同一套样式"，只管对方那侧会让自己的头像退回 15×22.5；② `.row.me` 补 `width:auto` —— style-kit 的 `.row{width:100%}` 下块级长度方程欠约束，浏览器会重置负 `margin-right`，行退不回内容盒外（实测自己那头像离右缘 28.5px），补上后才真正落到 11.69px。|
| 2026-11-24 | dev-a | **list / settings 两卡整段照搬**：`js/cards/list.js`、`js/cards/settings.js` 的 DOM 逐字复制 styles.html 741-749 行（`aside.phone-win.sidebar-left`）与 833-869 行（`aside.phone-win.sidebar-right`），只换文字与变量。`css/card-list.css` 从 256 行砍到 14 行、`css/card-settings.css` 砍到 13 行，各只留 `.card.card-*` 外框（高度撑满 + 隐藏滚动条），组件样式全部交给 `css/style-kit.css`。左侧列表的 `⋮`/图钉/成员数徽标按设计稿删掉，会话菜单改右键 + 550ms 长按，建群改 FAB 长按/右键。`css/assets/merusu-logo.png` 为新增文件（style-kit 的 mask url 相对 `css/` 解析）。|
| 2026-11-24 | dev-a | `cards.css` 补 `.pill{border:none}` 与 `.pill-input{...padding:0;margin:0...}`（textarea UA 默认 2px padding 会让 `.pill` 变 43）。实测 `.pill` 40 ✓；`.chat-foot` = 58.8，因为 `.send` 42×42 + `.chat-foot` 自身 `padding:8px` ×2 + `border-top`0.8，**58.8 是这套 style-kit 的地板，不是 `.pill-input` 的问题**。|
| 2026-11-24 | dev-a | 置顶的可见性：列表**不加图标**（那是发明视觉），改为 `js/cards/list.js:206-214` 渲染前排序 pinned 优先、其次 `updatedAt` 倒序；`:259` 给置顶行加 `data-pinned="1"`（无视觉，供测试与后续用）；`:217` 无活动会话时默认选第一条 = 置顶那条。会话菜单（右键 / 550ms 长按）四项：`置顶|取消置顶`（文字随状态变）、`重命名`、`清空聊天记录`、`删除会话`（群聊叫`删除群聊`，danger），见 `:309-370`。|
| 2026-11-24 | dev-a | settings 卡与设计稿的两处有意差异：① 设计第三页的 `设定 / 人格` textarea 不在本卡（人格只存在于 members 表，属详情卡），换成 `模型与接口` 三个 input；② 设计稿的壁纸 `<select>` 换成 `.seg` 三按钮 + `上传图片`。上传用的 `<input type="file">` **不常驻 DOM**（保 aside 与设计稿一致），选图时才临时挂到 body，change / `unmount` 后摘除。|
| 2026-11-24 | dev-a | **「自己」只有一个来源**：`js/core/store.js` 加 `DEFAULT_SETTINGS.selfName = "内测用户01"`（老数据缺字段时 `getSettings()` 的 merge 会回落），并导出 `getSelf(source?)` → `{name, initial}`，首字符用 `Array.from(name)[0]`（中文/emoji 取完整第一个码位）。模块级 `lastSettings` 快照在每次 `getSettings`/`setSettings` 时更新；传 `source` 是给预览壳 mock store 用的（它不走真实读取路径）。**dev-c 群聊里自己的头像也 import 这一个函数，不许各自实现首字母。** 设置卡：`.big-ava` 文字取 `initial`、`title` 取 `name`，`.name-text` 取 `name`，点 `.name-text` → `ctx.prompt("你的名字", 当前名)` → `apply({selfName})` 写回并发 `settings:changed`。|
| 2026-11-24 | dev-b | **群聊详情「设定 / 人格」换成「公告板」**（lead 定）：`js/cards/detail-group.js` 的 `PANEL_TPL` 里那块 `.field` 改为 `<label class="lbl">公告板</label><textarea rows="4" placeholder="写在这里的话所有成员都看得到">`，位置不变（`name-center` 之后、成员墙之前）；保存走 `saveAnnouncement()` → `ctx.store.updateConversation(conv.id,{announcement,touch:false})`，防抖 500ms，`unmount/onLeave/返回键` 前都会 flush；不再写 `members[0].persona`。私聊 `detail-direct.js` **一行未改**，仍有「设定 / 人格」。**动了 dev-a 的文件 `js/core/store.js`（登记在此）**：`createConversation()` 的对象里加 `announcement: ""`（lead 授权：没有这个字段就加默认值，别新造表）；读取侧 `load()` 另做 `typeof conv.announcement !== "string"` 兜底，老数据不进 IndexedDB 也不会报错。`css/card-detail.css` 未加任何公告板样式（`.field/.lbl/textarea` 全由 style-kit 提供）。 |
| 2026-11-24 | dev-a | **§2.3 口径由用户 m05242/m05286 批次定稿，dev-a 落 store，dev-b/dev-c 同步卡片**。`js/core/store.js`：`User` 加 `name` / `avatar`（`selfName` 保留为同步别名）、`DEFAULT_SETTINGS.avatar = avatarForUser(name)`；`Conversation` 加 `accent`（默认 `null`）；两个解析函数 `resolveWallpaper(conv,user)`（:247）/ `resolveAccent(conv,user)`（:262），并挂到 store 实例上；`getSelf()`（:231）返回 `{name, avatar}`；形状归一 `normalizeSettings`（:119）/ `normalizeConversation`（:149），v1→v2 迁移 `migrateV1ToV2`（:178）幂等。`js/shell.js` 事件归一表补 `conv:changed` / `wallpaper-changed`（与冒号/短横线两套历史命名一起听）。 |
| 2026-11-24 | dev-a | **`store.open()` 永不 settle 的三个洞已补**（真应用 `#cards` 空白的根因）：① upgrade 事务挂 `t2.onabort`/`t2.onerror` 打日志，`onupgradeneeded` 整体 try/catch（`migrateV1ToV2` 里 `c.update()` 抛错时 `req.onerror` 收不到）；② `open()` 改成 pin 住的 promise（`const pin = new Promise(...)`，`opening = pin.catch(...)` 存的是**同一个 promise**，不再有 `onsuccess` 里把 `opening` 置 null 之后再 `return opening` 的竞态）；③ 新增 `OPEN_TIMEOUT_MS = 8000` 超时兜底，超时 reject「IDB 打开超时（可能被旧连接占用）」；`db.onversionchange` 关闭本页连接。实测 8915 干净 origin：`store.ready()` settled、`#cards .card` = 1、`indexedDB.databases()` = `[{name:"meruchat", version:2}]`。 |
| 2026-11-24 | dev-a | **头像颜色跟主题色走**（`resolveAvatarColor(avatar, accent)`，store.js:75）+ `DEFAULT_ACCENT="#ffffff"`（:13）/ `ACCENT_COLORS` 5 色（:16）/ `resolveAccent` 兜底改白（:262）/ 新增 `resolveMemberAccent`（:277）。`avatarForName` / `avatarForUser` / `normalizeAvatar` 一律不再写死色值，`color` 默认 `null`；`getSelf()` 返回的 `avatar.color` 已经是 `resolveAvatarColor(avatar, user.accent)` 的结果。`js/ui/avatar.js` 的 `renderAvatar(node, avatar, {accent})` 也走同一个解析；list.js 会话头像传 `resolveAccent(conv, user)` 并订阅 `settings:applied` 重绘；设置卡大头像传 `accentKeyOf(settings)`。实测：`store.setSettings({accent:"#00a884"})` → `getSelf().avatar.color = "#00a884"`、`.conv .c-ava` 底色 `rgb(0, 168, 132)`。 |
| 2026-11-24 | dev-a | **`createConversation` 改为对象签名 + `addMessage` 补 id/seq 兜底**（lead 报的真应用 bug：`chat-group.js`/`list.js` 用对象调用，标题变 `"[object Object]"`、`kind` 永远 `direct`）。`js/core/store.js:540` 起：`createConversation({kind="direct", title, members=[]})`，第一个参数是字符串时按旧签名 `(title, members, kind)` 兼容；`addMessage`（:718）缺 `id` 补 `uid()`、缺 `seq` 补「该会话最大 seq + 1」、缺 `ts` 补 `now()`、缺 `convId` 直接 reject。DEV.md §3 已写这两个签名。探针新增用例「createConversation 对象签名（+ 旧签名兼容）与 addMessage 兜底 id/seq」，21 passed / 0 failed。 |
| 2026-11-24 | dev-a | **壁纸改名 + 新表 + 搜索设置**：枚举 `gradient/midnight/topo` → **`aurora`（极光）/`forest`（深绿）/`dusk`（暮紫）**，迁移 `gradient→aurora`、`midnight→forest`、`topo→dusk`（`WALLPAPER_ALIASES`）；`settings.defaultWallpaper` 默认 `aurora`；设置卡 `.seg` 文案 `极光/深绿/暮紫`。新增 `memos` 表（`keyPath:["conversationId","key"]`，`{conversationId,key,text,updatedAt}`，text ≤2048 截断 + warn）+ 方法 `memoAll/memoPut/memoGet/memoDelete`（另有 dev-c 的 `memoSet/listMemos` 别名走全局桶）。`settings` 加 `searchUrl`/`searchKey`（设置卡「搜索」组两个 input）。**`pending` 表按 lead m03428 取消**，`agentsMd` 只当普通字符串。壁纸落 DOM 走 `theme.applyWallpaperLayer(el, w)`，图案在 `css/cards.css` 的 `#wallpaper[data-wall=...]`（dusk = `topography.svg` mask + `#7c5cff` + `opacity:.1`）。 |
| 2026-11-24 | dev-b | **私聊详情撤掉「主题色」行**（lead m02952 / 用户原话「私聊详情不要显示 主题色的设置」）：`js/cards/detail-direct.js` 删掉 `.field > .lbl{主题色}` + `.seg[data-role="accent"]` + `ACCENT_LABELS` / `accentButtonsHtml()` / `paintAccent()` / `saveAccent()` / `markAccent()` / `effectiveAccent()` 及 renderPanel 里的接线与 unmount 复位，恢复成 `‹ 返回 + 头像 + 名字 + 设定·人格 + 壁纸`。现状：`data-accent` / `data-role="accent"` 命中 0，「主题色」只剩注释。张聊天卡的主题色控件保留（那是成员/群聊入口）。|
| 2026-11-24 | dev-b | **群成员主题色（`Member.accent`）**：`js/ui/atoms.js` 新增导出 `memberEditDialog({name, persona, accent, accentColors, accentLabels, mount, ...})`，把原来的「改名字 → 改人格」两次 `promptDialog` 合成一张 `.modal`（名字 / 设定·人格 / 主题色三行），主题色是 `.seg`：`跟随默认`（`data-accent-default="1"`，写 `null`）+ `store.ACCENT_COLORS` 每个色一个 `data-member-accent` 色块（文案取卡片给的 `accentLabels`，`atoms` 不内置任何色值）。`mount` 传卡片根，弹层落回 `.card-detail` 内（`.modal-mask` 是 fixed，视觉不变）。`detail-group.js`：`editMember()` 改走它，`saveMember()` 透传 `accent`（`null` = 跟随默认），改完发 `members-changed` + `conv:changed {id: convId}`；成员头像底色 = `store.resolveAvatarColor(avatar, store.resolveMemberAccent(member, user))`。|
| 2026-11-24 | dev-b | **主题三件套接线 + 描边全下线 + 默认色改浅灰**（lead m03186 / m03255）：两张详情卡都 `import * as themeNs from "../core/theme.js"`，主题色不再只写 `--accent`，统一走 `theme.applyTheme(hex, rootEl)`（= `deriveTheme()` 的 `base/soft/surface/on` 五个变量一起落，卸载 `theme.clearTheme(rootEl)`；`theme.js` 未导出时按 `THEME_VARS` / `THEME_VARS_FALLBACK` 兜底）。**卡里没有一行 `color-mix`**。`ACCENT_LABELS` 加 `"#e5e5ea": "灰"`（`#ffffff` 保留同文案，dev-a 改 store 前后都能出名字）。描边全部作废：`markMemberAccent()`（原 `paintMemberRing`）**不再写 `box-shadow`**，只打 `data-accent`；`css/card-detail.css` 里 `.m-ava` 的 inset 发丝线删掉，面与面只靠色差——卡片底 `var(--accent-surface)`、`input/textarea/select` 底 `var(--accent-soft)`、头像字色 `var(--accent-on)`。`atoms.js` 色块小圆点也用去掉 `box-shadow` 的内联背景。|
| 2026-11-24 | dev-b | **动了 dev-a 的文件 `preview/mock.js`（登记在此）**：mock store 原来没有 §2.3 的解析函数，`?all=1` 里列表卡报 `TypeError: this.ctx.store.resolveAccent is not a function`（`js/cards/list.js:273`）。从 `../js/core/store.js` import `resolveAccent` / `resolveWallpaper` / `resolveAvatarColor` / `resolveMemberAccent` 并挂到 mock store 上（预览不复写口径），`?all=1` 的 `#pv-err` 归 0。|
| 2026-11-24 | dev-b | **默认主题色落地后的实测（8915 真应用 `/`，`store.DEFAULT_ACCENT` 已是 `#e5e5ea`）**：群聊详情卡根 `--accent:#e5e5ea / --accent-soft:#f3f3f6 / --accent-surface:#ffffff / --accent-on:#1c1c1e`；卡片底 `rgb(255,255,255)`、公告板 textarea 底 `rgb(243,243,246)`、`.big-ava` 94.5×94.5 `border-radius:50%` 底 `rgb(229,229,234)` 字 `rgb(28,28,30)`；成员墙 `.m-ava` 33×33 → `box-shadow:none`（描边已全下线），自己的色 `rgb(124,92,255)` + 白字、跟随默认的 `rgb(229,229,234)` + `rgb(28,28,30)`。`store.setSettings({accent:"#00a884"})` + `events.emit("settings:applied", next)` 后**不刷新页面**就地重画：三件套变 `#00a884/#e0f5f0/#f7fcfb/#ffffff`、卡片底 `rgb(247,252,251)`、textarea `rgb(224,245,240)`、`accent:null` 的成员从灰变绿、自己带色的两名保持紫；还原 `#e5e5ea` 后全部回原值，`.card-error` 全程 0。**注意 §2.3.1 第 211 行仍写着「白色主题靠 0.8px 描边」，与现状（默认灰、描边作废、浅色分支 `soft=mix(白,base,.45)`/`surface=#ffffff`/`on=INK_DARK`）不符，待 lead 改。**|
| 2026-11-24 | dev-b | **预览壳 `?all=1` 测不了跨卡事件（发现，未改）**：`preview/harness.js:128` 的 `mountCard()` 里 `const events = createEvents()` 是**每张卡一条独立总线**，所以设置卡点的 `settings:applied` 到不了详情卡，`?all=1` 下换主题色页面无任何变化。要在预览里验收「改设置→卡片就地重画」，只有走真应用 `http://127.0.0.1:8915/`（shell 单总线 + `window.__meruchatShell`）。要么把 `createEvents()` 提到 `boot()` 里共享，要么在 harness 里加一条手动 emit 的入口——两处都属 lead/dev-a 的文件，等指示再动。|
| 2026-11-24 | dev-b | **两张详情卡对齐 §2.3，并各加一行「主题色」**：`js/cards/detail-direct.js`（479 行）/ `detail-group.js`（697 行）删掉各自的 `var WALLPAPERS = [...]`，改成 `import * as storeNs from "../core/store.js"`，壁纸解析一律 `storeNs.resolveWallpaper(conv, ctx.settings)`、主题色一律 `storeNs.resolveAccent(conv, ctx.settings)`（`ctx.settings` 就是 §2.3 的 User：`{name,avatar,accent,defaultWallpaper}`），**卡里没有任何 `conv.wallpaper || user.defaultWallpaper` 式自造回落**。壁纸下方新增 `.field > .lbl{主题色}` + `.seg[data-role="accent"]`：`跟随默认`（`data-accent-default="1"`，写入 `null`）+ 4 个色块（`data-accent="#0075de|#00a884|#7c5cff|#d97757"`，文案取自卡内的 `ACCENT_LABELS`，**色值本身来自 `store.ACCENT_COLORS`，不另抄一份**；lead 口头叫 `store.ACCENTS`，实际导出名是 `ACCENT_COLORS`）。选中写 `conv.accent`（`updateConversation(..., {accent, touch:false})`）并发 `conv:changed { id }`；落 DOM 只打卡片根的两个 CSS 变量 `--accent` / `--send-bg`（`unmount` 时 `removeProperty` 复位），**不碰任何气泡内联样式**——气泡由聊天卡按 `--accent` 派生。事件名同步：四处 `conversations-changed` → `conv:changed { id }`（实际共 7 处，含删会话/成员变更各一处）。 |
| 2026-11-24 | dev-a | **主题三件套的唯一派生点落地**：`js/core/theme.js` 新增 `parseColor` / `toHex` / `relativeLuminance` / `mix(a,b,t)` / `isWhiteish` / `inkOn` / **`deriveTheme(accent) → {base,soft,surface,on}`** / `applyTheme(accent, el?)` / `clearTheme(el?)` / `THEME_VARS`（= `--accent/--accent-soft/--accent-surface/--accent-on/--send-bg` 五项）。`applySettings()` 只调 `applyTheme(accentColor(s))` 一次写全五个变量到 `document.documentElement`，自己不再 `setProperty("--accent")`。分支两条：`L > 0.7` 浅色（soft = 混白 **0.45**、surface = `#ffffff`、on = `#1c1c1e`）；否则彩色（soft 0.12 / surface 0.97 / on 按 0.6 亮度）。**判据是 0.7 不是 `isWhiteish()`(0.95)**，`isWhiteish` 只留给 store 的旧数据迁移用。`WHITE_THEME_SURFACE` 与 `body[data-theme-plain]` 已删除。 |
| 2026-11-24 | dev-a | **白色主题下线 → 默认浅灰**：`js/core/store.js` 的 `DEFAULT_ACCENT = "#e5e5ea"`（iOS systemGray5）、`ACCENT_COLORS = ["#e5e5ea","#0075de","#00a884","#7c5cff","#d97757"]`。新增 `import { isWhiteish } from "./theme.js"`（循环引用安全：theme 只在函数体内读 store 的绑定）与内部 `accentOrNull(v)`：设置级 `migrateAccent` 把 `#ffffff`/近白迁到 `#e5e5ea`，会话级 `normalizeConversation.accent` 与成员级 `normalizeMember.accent` 的白/近白迁到 `null`（= 跟随默认）。设置卡 `ACCENTS[0] = { color: "#e5e5ea", label: "灰" }`。`js/ui/avatar.js` 新增 `relativeLuminance` 复用 + `backgroundLuminance`（渐变取各色标平均）+ `avatarInk` + `applyAvatarInk(node, bg)`（只写字色，**不写描边** —— 用户否掉了）；`js/ui/chat-head.js` 改成调同一个 `applyAvatarInk`，顶栏头像不再白底白字。我的两张卡 `card-list.css` / `card-settings.css` 的卡面改读 `var(--accent-surface, var(--panel-bg))`，与详情卡同口径。 |
| 2026-11-24 | dev-a | **三件套 + 浅灰的实测（8915 真应用 `/`）**：根变量 `--accent:#e5e5ea / --accent-soft:#f3f3f6 / --accent-surface:#ffffff / --accent-on:#1c1c1e / --send-bg:#e5e5ea`；五色循环各值：蓝 `#0075de/#e0eefb/#f7fbfe/#ffffff`、绿 `#00a884/#e0f5f0/#f7fcfb/#ffffff`、紫 `#7c5cff/#efebff/#fbfaff/#ffffff`、橙 `#d97757/#faefeb/#fefbfa/#ffffff`。设置卡第一个色块 `data-accent="#e5e5ea"` title「灰」且 `.active`。老数据实测：往 IndexedDB 写 `kv/app.v.accent = "#ffffff"`（还带 `wallpaper`/`skin` 旧键）→ 重载后 `getSettings().accent` = `#e5e5ea`，`wallpaper`/`skin` 键已消失。头像三方实测（`#e5e5ea`）：`.c-ava` 与 `.chat-head .ava` 都是底 `rgb(229,229,234)` + 字 `rgb(28,28,30)` + `outline-style: none`；`#00a884` 时底 `rgb(0,168,132)` + 字白。气泡实测（`#e5e5ea`）：气泡 `rgb(243,243,246)` / 卡面 `rgb(255,255,255)` / 本色 `rgb(229,229,234)` 三者可分，`box-shadow` 仍是 style-kit 的两层软影（未被抹掉）。探针 23 passed / 0 failed（新增「deriveTheme 三件套」「旧 accent 白/近白迁到默认浅灰」两条用例）。 |
| 2026-11-24 | dev-c | **群聊消息头像改为成员口径，随机渐变板整个删除**：`msgAva()` 不再走 `gradOf(hashStr(id))`，改成 `paintMemberAva(box, member, settings)` → 底色 `store.resolveAvatarColor(member.avatar, store.resolveMemberAccent(member, settings))`、字色 `applyAvatarInk(box, bg)`（亮底深字 + `data-ink`，`js/ui/avatar.js` 的唯一实现）。这样「谁的颜色」在**气泡 `--accent`、消息头像、详情卡成员墙**三处恒等。`const AVA_GRADS = [...]` 与 `gradOf()` 以及 `hashStr` 的 import **全部删除**，`chat-group.js` 里 `AVA_GRADS` / `gradOf` / `hashStr` 命中 **0**；自己那侧头像仍走 `paintSelfAva()`（用户全局主题色，不随机）。`renderAccent()` 里新增对方头像的就地重画（`.row.them .msg-ava` 按 `this.messages` 顺序与 `paintMemberAva` 一一对应），换主题色后不刷新页面即生效。实测（8915 / space 36）：`#0075de` 时小满・林森 `rgb(124,92,255)`、阿奇 `rgb(0,117,222)`（`member.accent` 为 null → 跟随用户）；`#e5e5ea` 时阿奇 `rgb(229,229,234)` + 字 `rgb(28,28,30)`。**`deriveTheme(accent).on` 与 `applyAvatarInk` 二选一时用后者**（lead m02259 定：口径统一比重写一行重要，`deriveTheme().on` 作废）。 |
| 2026-11-24 | dev-c | **聊天输入条改吃 `--accent-soft`**：`css/card-chat.css` 第 12 条 `.card-chat .pill{background:var(--accent-soft,#f6f5f4)}`，与详情卡的 `textarea` 同口径（style-kit 的中性灰 `#f6f5f4` 只在变量缺失时兜底）。实测 `#e5e5ea` → `rgb(243,243,246)`、`#0075de` → `rgb(224,238,251)`、`#00a884` → `rgb(224,245,240)`、`#7c5cff` → `rgb(239,235,255)`。浅灰主题下 `.pill` 与用户气泡同色，这是「该主题下的浅色版」应有之义，不是 bug。 |
| 2026-11-24 | dev-c | **气泡保留 style-kit 的 `--bubble-shadow`，只删那圈描边**：`css/card-chat.css` 第 8 条里原先写的 `box-shadow: none` 已删除，气泡厚度回到设计系统自带的两层软影（`0 .8px 2.925px rgba(0,0,0,.02)` + `0 2px 7.8px rgba(0,0,0,.027)`；`wa` 皮肤是单层 `rgba(11,20,26,.13)`，`claude` 皮肤本身 `--bubble-shadow:none`）。用户否掉的是 **0 模糊的传播环** `0 0 0 0.8px rgba(60,60,67,.29)`，不是软影。验收口径：`boxShadow` 等于该皮肤的 `--bubble-shadow`，且**不出现** `0 0 0 0.8px`；实测 10 条气泡逐条正则扫描 `ring=false`。面与面之间仍**不靠线**——边界由 `--accent-soft` 与卡片白面的色差立住（见 §5 坑 18）。 |
| 2026-11-24 | dev-c | **两张聊天卡的 `themeOf()` 兜底按浅色 0.45 对齐**：`theme.js.deriveTheme()` 永远是首选（`isColor(th.base)` 校验通过就用它返回的四件套），只有该导出缺失且抛错时才走本地兜底；兜底的浅色分支从「与白 14% 混」改为 **45%**（`SOFT_ACCENT_WEIGHT_LIGHT` 同值）、`surface` 从写死 `#ffffff` 改为 **3% 本色混白**、`on` 的深色端点从 `#000000` 改为 **`#1c1c1e`**（与 `INK_DARK` 一致）。**兜底只是防 `theme.js` 晚到，不是第二条口径**；`data-plain` 在 `css/**` 与 `js/**` 里命中 **0**（只剩两条注释说明「不加 data-plain」），`color-mix` 在 `css/card-chat.css` 里也是 **0**。 |
| 2026-11-24 | lead | **打包链路的坑（dev-c 登记）**：`scripts/sync-www.mjs` 的 `dirs` 原为 `['js','assets']`，**漏了 `css`**，于是 `www/` 里根本没有 `css/` —— Capacitor 打出来的 APK 会是一个完全无样式的裸页面，而浏览器里一切正常（因为直接读仓库目录）。已补成 `['js','css','assets']` 并重打 APK（4.89 MB，`C:\Meru\website\meruchat\MeruChat-debug.apk`）。**以后新增任何顶层资源目录（图片、字体、i18n）都要同步改这个 `dirs` 列表**，并在 `www/` 里 `Test-Path` 确认文件真的被复制过去。 |
| 2026-11-24 | dev-a | **动效层落地（§2.5 第 1/2/3/4/5/6/7/12 项 + 弹层 + 返回键改版）**。`css/motion.css`（唯一动效层）新增 10 个 keyframes：`anim-card-push` / `anim-card-fade` / `anim-card-pop` / `anim-cards-in` / `anim-fade-in` / `anim-fade-out` / `anim-sheet-in` / `anim-sheet-out` / `anim-row-in` / `anim-wall-fade`，外加 dev-c 要的 `anim-enter` / `anim-typing`；对应 `.anim-*` 类全部在这里（`.anim-fade-out` 自带 `pointer-events:none`）。新增三个 token：`--dur-typing:1.2s`、`--typing-step:150ms`、`--stagger-step:24ms`（唯一允许超过 `--dur-3` 的两处）。`js/shell.js`：`mountInto()` 末尾按宽窄挂 `anim-card-fade`（宽，只 opacity）或 `anim-card-push`（窄，`translateX(24px)`），`unmountSlot()` 挂 `anim-card-pop` 并**在 `animationend` 或 400ms 兜底之后才 remove**（`slots[i]` 已先置 null，DOM 延后摘）；`cleanupOrphans()` 放行 `.anim-card-pop` 的节点（否则收尸会掐掉退场）；同卡片重刷 class 时保留 `anim-*` 前缀类（原写法 `className=` 会抹掉入场动画）；`start()` 首帧给 `.cards` 挂 `anim-cards-in`。`css/card-list.css`：`.conv` 过渡 `background-color` + `border-left-color`（竖线靠**颜色**淡入，宽度仍是 style-kit 的 3px 不动）、`.fab` 补 `transition: transform/filter` + `.fab:active{scale(.94)}`。`js/cards/list.js`：首帧给前 8 行写 `style.setProperty("--i", i)` 并给 `.conv-list` 挂 `anim-stagger`，`staggerDone` 标志保证**remount 与 reload 都不重放**。`js/ui/atoms.js`：`openOverlay()` 入场挂 `anim-fade-in` + `anim-sheet-in`（面板由新增的 `overlay.animatePanel()` 在 append 后挂），`close()` 挂 `anim-fade-out` + `anim-sheet-out`，**`animationend` 或 300ms 兜底之后才 `mask.remove()` 并 resolve**（`closing` 标志保证只 resolve 一次；Esc / 点遮罩 / 点菜单项三条路径同一个 close）。实测（8915，420×820 窄屏 + 1100×760 宽屏）：push `anim-card-push 0.26s cubic-bezier(0.2,0,0,1)`、宽屏 `anim-card-fade 0.18s`、pop 后 30ms 卡仍在 DOM、600ms 后已摘；弹层开 `.anim-fade-in`+`.anim-sheet-in`、关时 +1ms 仍在 DOM 且挂上退场类、**304ms 后 resolve**、之后 `.modal-mask` 数 0；`prefers-reduced-motion` 下 `animation-duration:1e-05s`、`iteration-count:1`、弹层照样 324ms 收干净。 |
| 2026-11-24 | dev-a | **壳的白色圆钮 `.shell-back` 下线**（用户原话「会话页的返回键好丑，不要那个白色的圆圈」）：`js/shell.js` 的 `syncBackButton()` 改成空转（只清理可能残留的节点，不再创建、不再挂 `has-shell-back`），`css/cards.css` 删掉 `.shell-back` 整套样式与 `.cards-narrow.has-shell-back …{visibility:hidden}` 让位规则、删掉 `@media (pointer:coarse)` 里的 `.shell-back` 死代码。窄屏返回键一律由卡片自带的 `.chat-head .back` 承担。实测（420×820）：`document.querySelectorAll(".shell-back").length === 0`、`.card-chat .chat-head .back` 是 `<span class="back">‹</span>`、`visibility:visible`、x=23，点它 `router.stack` 从 `["list","chat-direct"]` → `["list"]`，截图 `C:\Users\DELL\ego-shots\meru-ego\motion-narrow-chat.png`。 |
| 2026-11-24 | dev-a | **`scripts/static-gate.mjs` 的 `CSS_FILES` 加 `css/motion.css`**：动效类（`anim-card-pop` / `anim-stagger` 等）现在只在 motion.css 里有规则，不加会让第 3 项误报「CSS 里找不到这些 class 规则」。 |① 入场只走增量通道 —— 新增 `appendMessage(msg)`（`chat-direct.js:380` / `chat-group.js:501`），由 `markEnter(node)`（`chat-direct.js:126` / `chat-group.js:206`）给新行加 `.anim-enter` 并监听 `animationend` 自摘类；`renderMessages()` 全量重画**一律不加类**（实测重画后 `.anim-enter` = 0）；流式气泡 `startStreamBubble()` 建好即挂一次，delta 只改 textNode。② 发送键拆成两层图标 `<span class="ico ico-send">➤</span><span class="ico ico-stop">■</span>`，`setStreaming()` 不再改 `textContent`、只 `classList.toggle("stop")`，交叉由 CSS 的 opacity 过渡做；按下 `scale(.92)` 走 `:active`（无 JS 计时器）。③ 群聊「正在输入」从顶栏 `.sub` 移到气泡区末尾的 `.typing` 行（`.typing-text` + 三点 `.anim-typing`），`setTyping()` 建/改/删，`clearTyping()` 兜底，清理点 5 处（`setTyping(null)`、`setStreaming(false)`、`stopStream()`、`unmount()`）；顶栏 `.sub` 保持「N 位成员」不变。**`css/card-chat.css` 第 13/14/15 块只引用 `--dur-1` / `--ease-out`，全文件 `\\d+ms` / `animation:` / `@keyframes` 命中 0**（keyframes 由 dev-a 加进 `css/motion.css`）。实测（8915 / space 36）：`.anim-enter` → `animationName:anim-enter`、`duration:0.18s`、`cubic-bezier(0.34,1.36,0.64,1)`、400ms 后类已摘；`.anim-typing` → `1.2s`、`infinite`、delay `0s/0.15s/0.3s`；`.send` → `transition-property:transform`、`0.12s`、`display:grid`；把 reduced-motion 块临时提为无条件后三者分别压到 `1e-05s` / `1e-05s` / `1e-05s` 且 `iteration-count:1`，移除后逐项复原。 |
| 2026-11-24 | dev-c | **工具调用轮不再是空气泡**（lead 报的真应用缺陷）：`finish_reason:"tool_calls"` 那一轮 `content` 为空、`parts` 是 `["reasoning","tool-call"]`，原先被无条件画成一个空 `.bubble`，重启后还在。新增模块级 `toolCallNames(msg)` / `toolLineText(msg)` 与常量 `TOOL_LINE_MAX = 3`（`chat-direct.js:124-149` / `chat-group.js:204-229`）：**没有可见正文 且 有 tool-call part** → 不画 `.bubble`，改画 `.row > .tool-line`，文案 `⚙ 调用了 memo`（多个用「、」连，超过 3 个写「等 N 个工具」）；**有正文的消息正文优先、不画工具条**；既没正文也没 tool-call 的照旧。群聊仍保留 `.msg-ava` + `.who-name`（谁调的看得出），只是把 `.bubble` 换成 `.tool-line`。流式那条：私聊 `runTurn()` 收口时 `!live.full.trim()` → `live.rowEl.remove()`（`chat-direct.js:563`）；群聊在 `bubble.full = text2` 之后 `if (!text2.trim()) bubble.rowEl.remove()`（`chat-group.js:823`）。`css/card-chat.css` 第 16 块一条静态规则 `.card-chat .tool-line{font-size:12px;color:var(--meta,#615d59);opacity:.8;padding:2px 0}`（无时长、无 keyframes、无 layout 过渡）。实测（8915 真应用）：真跑一轮 memo 工具，`.row > .bubble` 6 个**空文本 0 个**、`.tool-line` 3 个文案全是 `⚙ 调用了 memo`、`rowsWithBoth`（同时带气泡与工具条的行）= 0，`memoGet("t2")` = `"ok"`；刷新后同值不变（说明落库渲染路径也修了）。注意 `.tool-line` 的 `font-size:12px` 在本机被浏览器最小字号钳到 **15px**（`getComputedStyle` 读 15px，与 §5 坑 12 同源），设计值未改。 |
| 2026-11-24 | dev-c | **免 key 搜索后端（浏览器只打同源 `/search`，不再要 API Key）**：新建 `server/search.mjs`，`runSearch({query,limit,recency})` → `{results,engine}`，引擎顺序 **ddg-html → bing → ddg-lite**，逐个失败切换，全挂抛 `search_failed`（`err.detail` 里带每个引擎的原因）；`dev-server.mjs` 新增 `/search`（POST `{query,limit,recency}` 或 GET `?q=&limit=`，成功 `{"ok":true,"engine","results"}`，失败 502 `{"ok":false,"error","detail"}`，启动日志第三行 `search       /search -> ddg-html|bing|ddg-lite (keyless)`）；`js/core/tools/web-search.js` 的 `searchUrl` 为空时**回落同源 `/search`**（不再抛 `search_not_configured`），`/` 开头的地址不发 `Authorization`，失败体里的 `detail` 会透给模型；`js/core/store.js:40` 的 `DEFAULT_SETTINGS.searchUrl` 由 `""` 改为 `"/search"`（`normalizeSettings` 那行不动 —— 老数据里的 `""` 靠 web-search 的回落兜住）。解析正则与 `looksRelevant` 抄 `dsh-free-search` 的 `lib/engines/*`（只抄正则与判据，零依赖）。**环境坑**：DDG 在短时间内连续请求会回 **HTTP 202 + anomaly/challenge 反爬页**（`result__a` 依旧 0 条），同一 URL 隔 4s 再打即恢复 200/10 条；故 `server/search.mjs` 对两个 DDG 引擎各重试一次（1200ms 间隔），**Bing 不重试**（它超时就是 8s，重试会顶穿工具 20s 超时）。Bing 对「查询无结果」会回一张完全无关的缓存 SERP（`b_algo` 照常 10 条），靠 `looksRelevant` 判成 0 条交给下一个引擎。 |
| 2026-11-25 | lead | **原生 Billion Context 落地（§2.6）**：`js/core/store.js` 升 **DB_VERSION 3**（新增 `blocks` 表，`keyPath:"id"`，索引 `by_conv` / `by_index`；v1→v2 分支原样保留，真 v2 库实测升级后 11 条消息 / 会话 / memos 全在）；新建 `js/core/context.js`（543 行，`estimateTokens` / `estimateMessages` / `SUMMARY_PROMPT` / `buildContext` / `planFold` / `summarizeBlock` / `foldOldest`，`TOOL_RESULT_CONTEXT_MAX=2000`、`BLOCK_LIMIT=8`、`DISTILL_BLOCKS=4`）。五段顺序实测：`agentsMd → persona → 压缩块 → memo → 未折叠消息`，别人发的 assistant 转成 `user` + 「名字」前缀，`role:"system"` 的历史消息跳过。真应用折叠实测：budget 设 100 → `foldOldest` 用真网关把 5 条消息压成「压缩块 1｜原第 0–4 条」（139 token），5 条消息 `foldedBlockId` 打上、`listUnfoldedMessages` 6 条、`buildContext` 的 `[3]` 段出现该块。**修了 dev-a 引入的一个真 bug**：`summarizeText` 里 `if (!apiKey) throw "缺少 API Key"` —— 本地网关不需要 key，与 `agent.js:223` 同一口径，改成空 key 不发 `authorization`（否则压缩永远失败）。`chat-direct.js` / `chat-group.js` 的 `buildTranscript()` 已删，改调 `prepareContext(responder)`；进栈时走 `prepareContext(member, {fold:false})` 只算统计不折叠。底栏 `.ctx-line` 实测：`压缩块 0 · 未压缩 13 条 · 约 287`，位于 `.chat-foot` 之上（y=683，foot y=708）。 |
| 2026-11-25 | lead | **两个真缺陷修复（验收时发现，都会影响压缩正确性）**：① **`css/theme.css` 重写成「只有 token」后，`js/ui/atoms.js` 依赖的弹层样式整段丢失** —— `css/*.css` 里 `.modal-mask` 命中 **0**，实测 confirm 弹层 `position:static`、`background:rgba(0,0,0,0)`、`rect:{y:647,h:60}`，即所有弹层（confirm / menu / prompt / 成员编辑 / 压缩块摘要）都退化成页面底部的透明文字。修法：新建 **`css/components.css`**（104 行），从根目录未改动的 `theme.css` 第 792–877 行逐行搬回 `.modal*` / `.sheet*` / `.member-row*` / `.empty-tip` / `.confirm-text`，并补 `.sr-scroll > .note` 与 `.card-detail .field > .note` 两条纯文本规则；`index.html` 与 `preview/index.html` 的 `<link>` 顺序追加 `components.css`（末位），`scripts/static-gate.mjs` 的 `CSS_FILES` 加同名项。修后实测 `.modal-mask` = `position:fixed`、`inset:0`、`bg:rgba(0,0,0,.35)`、`z-index:50`，`.modal` 居中 `x=353 y=273 w=420`、`radius:12px`、`box-shadow:…40px`。**以后动 theme.css 必须同时检查 `.modal*` / `.sheet*` 是否还在。**② **`chat-direct.js` 用户消息不写 `seq`，导致同一条消息与回复撞号** —— 本地 `this.messages` 里那条没有 `seq`，紧接着 `runTurn()` 的 `nextSeq(this.messages)` 算出同一个号，实测两条都是 `seq:11`。这会直接毁掉压缩块的 `fromSeq/toSeq` 区间。修法：`userMsg` 里显式 `seq: nextSeq(this.messages)`；实测新发一轮得 `seq 11`（user）与 `seq 12`（assistant），13 条消息 `uniqueSeqs = 13`。群聊本来就走 `takeSeq()` 自增，无此问题。顺带把 `约 X.Xk` 改成 <1000 显示原数（`约 215`，不再是 `约 0.0k`），四张卡同口径。 |
| 2026-11-25 | lead | **群聊一轮工具调用被复制成 N 条相同气泡（真 bug，验收时发现）**：`chat-group.js` 每个成员的收尾循环里原来写的是 `for (const rec of recs) await store.updateMessage(rec.id, { seq: this.takeSeq(), content: text2, status })` —— `recs` 是这一轮 agent 落库的**每一条**记录（step1 那次 tool-call 空正文 + step2 的正文各一条），把 `text2` 写进每一条，于是「完成」被写成两条可见气泡。实测（工具轮验收群，2 成员，各跑一次 memo）库里出现 `seq 10` 与 `seq 11` 两条内容完全相同的 assistant 记录，界面 3 个气泡里 2 个重复。修法：只给**最后一条**写 `content` 与真实 `status`，其余步骤只补 `seq` 并置 `status:"complete"`（工具轮那步的 content 必须保持为空，重画时才由 `.tool-line` 接替）。修后实测：一轮 2 成员各 1 次 memo → 库里 5 条（user / 小满 tool-call / 小满 完成 / 阿奇 tool-call / 阿奇 完成），界面气泡 3 个（用户 1 + 「完成」×2，分属两人）、`.tool-line` 2 个，无重复。 |
| 2026-11-25 | lead | **压缩块在群聊里的真实表现（多成员串行验收）**：2 成员群 + 8 条历史 + `contextBudget` 降到 80 后发一句 → `foldOldest` 在同一轮里连做两次，得到 `压缩块 1（原第 0–2 条，3 条，128 token）` 与 `压缩块 2（原第 3–4 条，2 条，101 token）`，`listUnfoldedMessages` 7 条，底栏 `压缩块 2 · 未压缩 7 条 · 约 807`；每个成员各自 `prepareContext` 时都会尝试折叠（§2.6 按 responder 拼上下文，折叠本身与 responder 无关所以安全）。摘要是真网关产出的五行结构，实测块 1 摘要开头 `用户目标：确定默认主题色、气泡配色及壁纸可选方案。 已确定的决定：默认主题色为浅灰 #e5e5ea…`。**注意**：`contextBudget=80` 会让一轮里连续折叠，正式使用时默认 8000 不会这样。 |
| 2026-11-25 | lead | **底栏 `.ctx-line` 被壁纸层盖住（真 bug，只有截图才看得出来）**：`.ctx-line` 是 `.chat` 的普通子节点，而壁纸层 `#wallpaper` 与 `#dim` 是 `position:absolute; inset:0` 且带 z-index；`.chat-foot` 之所以正常是因为 style-kit 给了它 `z-index:3`。实测 `getComputedStyle(line).zIndex = "auto"`、`color:rgb(97,93,89)`、`opacity:1`、`elementFromPoint` 也返回它自己（DOM 层看得出来），但截图里那块区域是空的 —— 也就是说**纯靠 DOM/计算样式验收会漏掉 z-index 被盖住的这类缺陷**。修法：两卡的 `.ctx-line` 内联样式补 `position:relative;z-index:3`（与 `.chat-foot` 同级）。修后截图 `C:\Users\DELL\ego-shots\meru-ego\0759fe3d5bd3f3911d0de6ba.png` 里「压缩块 0 · 未压缩 11 条 · 约 269」清晰可见。**教训：`.chat` 里新加的任何行都要显式给 z-index > 壁纸层，否则壁纸一开就看不见。** |
| 2026-11-25 | dev-a | **memo 改「单条、无上限、整段覆盖」（用户口径，2026-11-25 直下）**：备忘不再是「key → text 的多条小抄」，就是**一段自由文本**；`memo` 工具只有「更新」一个动作，调用一次 = **整段覆盖**旧文本（不是追加，要保留旧内容必须自己拼回去），`text` 传空串 = 清空。改动 5 个文件：① `js/core/store.js` — 删掉 `MEMO_TEXT_MAX=2048` / `MEMO_KEY_MAX=64` / `memoAll/memoPut/memoGet/memoDelete/memoSet/listMemos/getMemos` 整套，只留 `getMemo(convId?)`（没有就是 `""`，永不 `null`）、`setMemo(text, convId?)`（`String()` 归一 + 去尾部空白，**不截断**，返回 `{text, updatedAt}`）、`clearMemo(convId?)`（`true/false`），`convId` 省略 = 全局桶；新增 `migrateMemosToSingle()` 并在 `ready()` 里 `open → backfillKinds → migrateMemosToSingle → getSettings`；② `js/core/context.js` — `buildContext` 入参 `memos`(对象) → `memo`(字符串)，第 [4] 段 `String(o.memo||"").trim()` 非空才注入「当前备忘：\n+原文」；③ `js/core/tools/memo.js` — 重写成单动作工具，`description` 把「整段覆盖/不是追加」写在最前面，`parameters` 只剩 `text`（`required:["text"]`），返回「已更新备忘（共 N 字符，覆盖了原来的 M 字符）」，`details = {length, previousLength, cleared}`，`need()` 只认 `getMemo/setMemo`（缺了报 `store_method_missing`）；④ `js/core/tools/context-info.js` — `measureFromStore()` 改读 `store.getMemo(convId)` 字符串，memo token 不再拼 `key: ` 前缀；⑤ `docs/DEV.md` 本节与 §2.6 第 [4] 段。**存储路线：沿用 `memos` 表、单条记录固定 key `""`**（主键仍是 `[conversationId, key]`），所以不用建新表、`DB_VERSION` 不动（仍 3）。**迁移**：对每个 scope 把老行按 key `localeCompare` 排序拼成 `key: text` 多行（key 为空串的那条只取 text），写成 `[scope, ""]`，再 `delete` 掉所有非空 key 的老行；唯一一条空串 key 的 scope 直接跳过 → **幂等**（第二次 open 文本与行集合都不变，实测 `idempotentText: true` / `idempotentRows: true`）；迁移整体包 try/catch，失败只 `console.warn` 并保留老记录，绝不挡住打开库。自测（`C:\Meru\website\tmp-memo-selftest.mjs`，内存 IDB + 真 store）：3 条老全局备忘 → 单条 `"alpha: 第一条\nmid: 中间那条\nzeta: 最后一条"`（updatedAt 取最大值 5），会话 `conv-1` 的 2 条 → `"a: 会话A\nb: 会话B"`；`getMemo("no-such-conv") === ""`；3000 字符原样存取（`noTruncation: true`）；`"带尾部空白   \n\n"` → `"带尾部空白"`；`clearMemo()` 先 `true` 后 `false`、之后 `getMemo() === ""`；工具 `description` 命中 `/整段覆盖/` 与 `/替换掉/ + /不是.*追加/`、`params=["text"]`、`executionMode:"sequential"`、缺 `text` 报 `bad_args`、store 缺方法报 `store_method_missing`；`buildContext` 的 [4] 段实测 `"当前备忘：\n偏好：简洁\n约定：不留 TODO"`（`parts.memo=15`），`memo=""` 时该段不出现；`context_info` 现算兜底输出 `组成：压缩块 0 · memo 11 · 历史 0`。门禁：四个文件 `node --check` exit 0、`static-gate.mjs` 通过、`probe-shell-list.mjs` 23 passed、`make-probe.mjs` 16 passed。**卡片调用点由 dev-c 同步改成 `load("getMemo", () => "")` + `buildContext({..., memo: memo || ""})`，本卡不越界改。** |
| 2026-11-25 | lead | **新增只读工具 `context_info`（`js/core/tools/context-info.js`，工具总数 2 → 3）**：`createContextInfoTool({ store, getSettings, getContextStats, convId })`，`name:"context_info"`，无必填参数，可选 `verbose:boolean` 列每个压缩块的区间与 token。数据源优先读卡片算好的 `contextStats`（就是底栏那行），没有才从 `store.listBlocks/listUnfoldedMessages/getMemos` 现算；`fmtTokens` 与底栏同口径（<1000 显原数，否则 `13.2k`）。输出五行：`预算 … · 自动压缩开` / `当前上下文：约 N token（占预算 P%），还剩约 M token` / `压缩块：N 个` / `未压缩消息：N 条（约 T token）` / `组成：AGENTS.md … · 设定 … · 压缩块 … · memo … · 历史 …`，超 80% 预算追加一行提示。`createTools` 现在返回 `[web_search, memo, context_info]`；两卡的调用点补了 `getContextStats: () => this.contextStats || null` 与 `convId: this.convId`（chat-direct.js:528、chat-group.js:730 附近）。**踩坑**：现查兜底返回的空数组 `[]` 是真值，`blocks ? blocks.length : stats.blocks` 会把 stats 里的块数覆盖成 0 —— 已改成「stats.blocks 优先」。实测：真轮次里模型调它并原文回读 `当前上下文：约 299 token（占预算 4%），还剩约 7.7k token / 压缩块 0 个 / 未压缩 13 条 / 组成：AGENTS.md 0 · 设定 24 · 压缩块 0 · memo 22 · 历史 245`。 |
| 2026-11-25 | dev-a | **memo 全局唯一：修「工具写全局桶、上下文注入读会话桶」的真 bug（验收时发现，8917 真应用）**：现象 —— 模型调 `memo` 写入后，下一轮它读不到自己刚写的内容，看到的仍是会话桶里的旧文本。原因 —— 工具端 `setMemo(text)` 不传 convId 写的是**全局桶**，而注入端 `load("getMemo")` 带 convId 读的是**会话桶**，两边永远对不上。用户口径是「memo 只有一条」，所以统一到全局桶：`js/core/tools/context-info.js` 的 `measureFromStore()` 改成 `store.getMemo()` 不带参（`listBlocks` / `listUnfoldedMessages` 仍按 `convId` 查，不动）；`js/cards/chat-direct.js` 与 `chat-group.js` 的注入调用点由 dev-c 同步改成 `store.getMemo()` 不带参数。`docs/DEV.md` §2.6 第 [4] 段补一句「memo 全局唯一（不按会话分桶）：`memo` 工具与上下文注入读写的都是同一个全局桶」。**store 层保留 `convId` 口子**（`getMemo/setMemo/clearMemo(x, convId?)`），只是全项目不再按会话分桶；老的会话桶记录在 `migrateMemosToSingle()` 里照旧合并成一条，不删。 |
| 2026-11-25 | lead | **工具 3 → 6：新增 `set_name` / `set_persona` / `set_look`，上下文加第 [5] 段「工具与时间」（用户 m07704 四条要求）**：① `js/core/tools/profile.js`（244 行）三个工具统一签名 `({ store, convId, getResponder, onChanged })`、`executionMode:"sequential"`，改的永远是**这一轮发言的成员**（`getResponder()` 拿不到就报 `no_responder`，不猜不改别人）。`set_name({name})` 1–24 字（按码点数，不按 UTF-16 长度）；**私聊要同时写 `conv.title`**（私聊顶栏读的是 `conv.title`，见 `chat-direct.js:249-256` 的 `mountHead()`；`detail-direct.js:118-124` 现有改名逻辑也是同时写两处），群聊只写 `member.name` 不动群名。`set_persona({persona})` 整段替换、空串清空。`set_look({avatarColor?, avatarLabel?, wallpaper?})` 至少给一个，颜色校验 `/^#[0-9a-fA-F]{6}$/`、壁纸 `aurora|forest|dusk|default`（`default` → `null` = 跟随默认）；**私聊的头像颜色/首字要同时镜像到 `conv.avatar`**（顶栏读 `conv.avatar`），群聊只写 `member.avatar`。② `js/core/context.js` 第 [5] 段 `buildToolAndTimeText(tools, now, timeZone)`：首行 `当前时间：YYYY-MM-DD HH:MM（周X）· <tz>`，次行工具清单表头，之后每行 `- 名字：描述第一句`（超 `TOOL_LINE_MAX = 60` 字截断加「…」），工具为空时只出时间行；`buildContext` 新增 `opts.tools/opts.now/opts.timeZone`，`parts` 多出 `tools` 键。③ `js/core/tools/index.js` 返回六个工具。④ 两卡（dev-c）把 `tools`（只 `{name,description}`）与 `now: new Date()` 喂进去，并加 `getResponder` / `onChanged`（`chat-direct.js:536`、`chat-group.js:747`；群聊 `currentResponder` 在队列循环里赋值，闭包读可变字段）。**lead 在 dev-a 中途失败后补的两处**：`profile.js` 缺 `loadConversation()` / `isDirect()` 定义（会让 `set_name` 直接 ReferenceError）、`set_look` 的私聊头像镜像。 |
| 2026-11-25 | dev-a | **`profile.js` 落地 + 私聊/群聊镜像口径的实测（承接上面 lead 那条）**：最终 294 行，三个辅助函数 `loadConversation(store, id)`（`store.getConversation` 读不到就返回 `null`，不让工具崩）、`kindOf(conv)`（`"direct"`/`"group"`/`null`）、`isDirect(conv)`（`kindOf !== "group"`；**读不到会话按私聊处理**，老数据没有 `kind`，不镜像会话的话改名等于没改）。`set_name`：私聊 → `updateConversation(convId, {title})` + `updateMember(id, {name, avatar:{...avatar,label:首字}})`；群聊 → 只 `updateMember`，返回文案 `已把你在本群的名字改成「X」（群名不变）`。`set_look`：`avatarColor`/`avatarLabel` 私聊同时写 `conv.avatar`（基于 `conv.avatar` 合并，不整体替换）与 `member.avatar`，群聊只写 `member.avatar`；`wallpaper` 一律 `updateConversation(convId, {wallpaper: v==="default" ? null : v})`。`set_persona` 不碰会话。`onChanged` 的 `kind` 仍是 `"name"|"persona"|"look"|"wallpaper"`，`try/catch` 包住、工具不依赖它。**上下文第 [5] 段**：同一时刻换时区真的换墙上时间 —— `2026-11-25T02:30+08:00` 在 `Asia/Singapore` 得 `2026-11-25 02:30（周三）`、在 `America/New_York` 得 `2026-11-24 13:30（周二）`（用 `Intl.DateTimeFormat.formatToParts` 取数，`Date.getHours()` 只给本机时区、`timeZone` 会被忽略）。工具清单：描述先按行/句末标点取第一句，再按 `TOOL_LINE_MAX=60` 截断加「…」（59 字的描述原样保留、无句号的 80 字描述截成 60+「…」）。自测（`%TEMP%\probe-profile-tools3.mjs`，假 store 记录调用）**43 passed / 0 failed**，覆盖：六段顺序 `规则|你是甲|压缩块|备忘|时间|消息`、`parts` 六键、缺省 `tools` 仍有时间行、`set_name` 私聊两处都写 / 群聊只写成员且群名不变、`set_persona` 整段替换与清空、`set_look` 私聊镜像 `conv.avatar` / 群聊不碰、`default → null`、空参数与非法颜色报 `bad_args`、无 `onChanged` 也能改、无发言人报 `no_responder`、`createTools` 六个且三个 profile 工具 `sequential`。 |
| 2026-11-25 | lead | **两张详情卡订阅 `profile:changed`（补齐模型改自己后详情页不刷新的缺口）**：`grep profile:changed js/` 原先只有 emit（`chat-direct.js:743` / `chat-group.js:1025`），没有任何订阅者 —— 模型调 `set_name/set_persona/set_look` 后，聊天卡当场变、**停在详情页时看不到变化**。两张卡各加三件：模块级 `var profileOff = null`、`function refreshFromStore()`、`mount()` 里 `profileOff = ctx.events.on("profile:changed", …)`、`unmount()` 里退订。`refreshFromStore()` 的守卫分别用 `!mounted || nameEditor || personaDirty`（私聊：名字编辑中/人格未落盘不重画）与 `!mounted || nameEditor || boardDirty`（群聊：再加公告板未落盘），`convId` 不匹配直接 return，内部走既有 `load()` → `render()`（群聊等价于原 `rerender()` 但先重读库）。真应用实测（8917，space 51）：私聊 detail-direct 停在页面上时调 `set_name("验收小名")` → 详情 `.name-text` 当场变、`conv.title` 同步；`set_persona` → textarea 当场变；`set_look({avatarColor:"#00a884",avatarLabel:"验",wallpaper:"dusk"})` → `.big-ava` `rgb(0,168,132)`/文字「验」、壁纸 select 显示「暮紫」；群聊 detail-group 调 `set_name` 把成员「乙」改成「丙丁」→ 成员墙 `.m-ava` 由「乙」变「丙」（`avatarLabel` 取首字），群名「验收群」不变。验收后已把测试会话改名/头像/人格还原（`persona` 复原为 `DEFAULT_PERSONA`）、验收群删除。门禁：两个文件 `node --check` exit 0、`sync-www.mjs` ready、`static-gate.mjs` 通过（含 28 个 js 模块解析）、`probe-shell-list.mjs` 23 passed / 0 failed。 |
