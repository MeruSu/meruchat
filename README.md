# meruchat

一个**本地优先**的多成员 AI 聊天应用。纯 HTML / CSS / ES Module，没有构建步骤，数据全部存在浏览器 IndexedDB 里；模型走任意 OpenAI 兼容接口。

A local-first, multi-member AI chat app in plain HTML/CSS/ES modules. No build step, all data in IndexedDB, any OpenAI-compatible endpoint.

---

## 它是什么

- **多会话 + 单一置顶**：一个私聊 / 一个群聊，置顶的那个是每次打开的默认会话。
- **拉群**：一个群里有多个 AI 成员，各自有名字、头像首字、主题色、人格设定，按顺序轮流发言。
- **六个工具**：`web_search`（联网搜索）、`memo`（一条备忘，整段覆盖）、`context_info`（查当前上下文占用）、`set_name` / `set_persona` / `set_look`（AI 改自己的名字 / 人格 / 头像与背景）。
- **原生 Billion Context**：上下文由自己拼装并压缩 —— 六段结构，超预算时把最旧的对话折成「压缩块」，块数到上限再蒸馏。消息本体永不删除。
- **主题色三件套**：每个主题色派生「本色 / 浅色版（气泡）/ 该主题下的白（卡面）」，全部由 `theme.deriveTheme()` 一处算出。
- **跨端**：同一份代码在浏览器、Android（Capacitor）、桌面（Electron）里跑。

## 跑起来

```bash
# 1) 装依赖（只有打包用的 Capacitor / Electron，运行不需要）
npm install

# 2) 起本地服务（静态文件 + 同源反代 /gw/* 到 127.0.0.1:3425）
node dev-server.mjs 8917

# 3) 打开
#    http://127.0.0.1:8917/index.html
#    http://127.0.0.1:8917/phone.html   ← 锁 9:19 的手机比例预览
```

然后在「设置」里填 **Base URL / 模型名 / API Key**（任何 OpenAI 兼容端点；本地默认 `/gw/v1` 指向 `dev-server.mjs` 的反代，需要你自己有一个在 `127.0.0.1:3425` 上说话的网关）。

> 直接双击 `index.html` 打不开 —— ES Module 与 IndexedDB 需要 `http(s)://` 来源。

## 目录

| 路径 | 作用 |
|---|---|
| `index.html` | 唯一页面，只有 `#cards` 容器 |
| `js/shell.js` | 壳：卡片挂载、路由、事件总线、主题应用 |
| `js/cards/` | 六张卡片：会话列表 / 私聊 / 群聊 / 私聊详情 / 群聊详情 / 设置 |
| `js/core/` | store（IndexedDB）、agent（工具循环）、sse（流式解析）、context（上下文拼装与压缩）、theme、router、api |
| `js/core/tools/` | 六个工具的实现 |
| `js/ui/` | 复用组件：头像、顶栏、会话菜单、弹层 |
| `css/` | `style-kit.css`（视觉底座，**冻结勿改**）、`theme.css`（只有 token）、`cards.css`（壳布局）、`motion.css`（动效层）、`card-*.css`（每张卡自己的样式）、`components.css`（弹层） |
| `docs/DEV.md` | **开发文档，唯一事实来源**：数据口径、六段上下文规范、20+ 个已踩的坑 |
| `docs/cards-contract.md` | 卡片接口契约 |
| `docs/packaging.md` | Capacitor / Electron 打包笔记 |
| `probe-shell-list.mjs` | 23 个不依赖浏览器的逻辑测试 |
| `scripts/static-gate.mjs` | 静态门禁：资源引用、class 覆盖、ES Module 解析 |

## 测试

```bash
node probe-shell-list.mjs        # 23 passed
node scripts/static-gate.mjs     # 静态门禁
```

两个都是零依赖脚本，只靠 Node 内置模块。**注意**：只跑 `node --check` 不足以证明浏览器能加载 —— `.js` 按 CommonJS 解析，重复的函数声明在脚本里合法、在模块里报错，所以 `static-gate.mjs` 会把每个文件复制成 `.mjs` 再校验一次。

## 设计口径（改代码前先读 `docs/DEV.md`）

- 卡片纯白、不要阴影、不要可见滚动条。
- 主题色不带白色；默认色是浅灰 `#e5e5ea`。
- 气泡边界靠色差，不靠描边；软阴影保留。
- 六段上下文顺序固定：`AGENTS.md → 设定 → 压缩块 → 备忘 → 工具与时间 → 未压缩消息`。
- 任何卡片都不许自己拼 messages，唯一入口是 `buildContext()`。

## 许可证

**GNU Affero General Public License v3.0**（见 [LICENSE](LICENSE)）。完整条文，不改一字。

这意味着：你可以用、改、分发，但**改了并让别人通过网络使用**时，必须把改动同样以 AGPL-3.0 开放。这是目前最严格的开源协议 —— 它把「SaaS 分叉」这条缝也堵上了。

## 致谢

- `js/core/tools/web-search.js` 里 Bing 结果页的解析正则（`parseBingHtml` / `extractBingUrl`）与 `queryOverlapTokens` / `looksRelevant` 相关性判据，改写自 [dsh-free-search](https://www.npmjs.com/package/dsh-free-search)（MIT）。零依赖，只借了解析规则。
- Tavily / Firecrawl / Exa 三家走各自的公开 HTTP 接口，协议按它们的行为实测写成，没有引入 SDK。
- 视觉底座的部分数值来自作者另外几次设计试验，与第三方无关。
