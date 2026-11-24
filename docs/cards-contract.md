# MeruChat 卡片模块契约（v2）

目标：把当前单文件 `js/app.js` 拆成**互不重叠的卡片模块**，三个人可以同时开发、各自只碰自己的文件。

## 一、显示单位 = 卡片

整个界面由「卡片」组成，一屏显示 1 张或 2 张卡片。

| 卡片 id | 文件 | 职责 |
|---|---|---|
| `list` | `js/cards/list.js` | 会话列表（含 logo、新建私聊 FAB、建群入口） |
| `chat-direct` | `js/cards/chat-direct.js` | 私聊会话页（1 个成员） |
| `chat-group` | `js/cards/chat-group.js` | 群聊会话页（≥2 个成员） |
| `detail-direct` | `js/cards/detail-direct.js` | 私聊详情页（成员设定/人格、重命名、置顶、清空、删除） |
| `detail-group` | `js/cards/detail-group.js` | 群聊详情页（成员增删改、群名、置顶、删除） |
| `settings` | `js/cards/settings.js` | 全局设置（主题色、壁纸、亮度、**模型 / API Base URL / API Key**） |

**模型与 API Key 只在全局设置里改**，任何会话卡片都不出现模型配置。

## 二、布局规则（按窗口宽高比）

设 `r = window.innerWidth / window.innerHeight`：

- `r < 1`（竖屏/窄）：**只显示 1 张卡片**，全屏铺满，导航用卡片栈（进入下一张时上一张隐藏）。
- `r >= 1`（横屏/宽）：**并排显示 2 张卡片**，等宽，中间 gap 12px，外边距 8px。
  - 左卡片 = 导航栈的栈底，右卡片 = 栈顶（没有栈顶时右卡片显示空态/默认卡片）。
- 窗口尺寸变化时实时切换（`resize` 监听，节流 100ms）。

卡片外观统一：圆角 12px、1px 边框、无外阴影（沿用现有 `theme.css` 的 token）、内部独立滚动、滚动条隐藏。

## 三、卡片接口

每张卡片是一个 ES module，默认导出一个对象：

```js
export default {
  id: 'list',                     // 唯一 id，与文件名对应
  title: '会话',                   // 可选，shell 用于无障碍标签
  async mount(root, ctx) {},      // root 是 shell 给的空容器；ctx 见下
  async unmount() {},             // 清理监听/定时器
  async onEnter(params) {},       // 卡片被推入栈时调用，params 由 router.push 传入
  async onLeave() {},             // 被弹出/被覆盖时调用
};
```

`ctx` 由 shell 注入，**所有卡片共用**，不要各自 new 一套：

```js
ctx = {
  store,          // js/core/store.js：数据层（IndexedDB）
  api,            // js/core/api.js：streamChat(...)
  router,         // js/core/router.js：push(cardId, params) / back() / replace(...)
  events,         // 简单 EventEmitter：emit(name, payload) / on(name, fn)
  settings,       // 当前全局设置（只读快照，改动走 store.setSettings）
}
```

## 四、路由

- `router.push('chat-direct', { convId })` — 进入私聊会话
- `router.push('detail-direct', { convId })` — 会话右上角 `⋮` → 详情
- 群聊同理：`chat-group` / `detail-group`
- 点左栏 logo → `router.push('settings')`
- 栈深度：宽屏时栈最多 2 层（list 固定为底），窄屏时任意深度。

## 五、文件归属（谁可以改什么）

| 负责人 | 可改文件 |
|---|---|
| dev-a | `index.html`、`css/theme.css`、`js/shell.js`、`js/core/router.js`、`js/cards/list.js`、`js/cards/settings.js` |
| dev-c | `js/cards/chat-direct.js`、`js/cards/chat-group.js` |
| dev-b | `js/cards/detail-direct.js`、`js/cards/detail-group.js`、`js/ui/atoms.js`（头像/气泡/菜单/确认框） |

**共享只读**：`js/core/store.js`、`js/core/api.js`、`js/core/events.js`（dev-a 建立后其他人只调用，不改）。

## 六、验收

- 桌面宽屏（≥1:1）：左 list + 右当前会话，两块等宽、无横向滚动。
- 手机竖屏（<1:1）：单卡片全屏，进入会话后返回可回列表。
- 全局设置里能改模型/API，改完立刻生效；聊天页不出现任何模型配置项。
- 每张卡片 `node --check` 通过；无 console 报错。
