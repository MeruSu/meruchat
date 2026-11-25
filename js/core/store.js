// js/core/store.js — 数据层（IndexedDB）
// 逻辑原样搬自旧 js/app.js 的 DB + Store；不 import 旧文件。
// 库名 meruchat，表：conversations / members / messages / kv / memos / blocks / relations / group_members
// 群成员 = 会话引用（共享账本，docs/DEV.md §2.8）：members 里一个 AI 只有一行，群侧只挂 group_members 引用。
// 数据口径唯一来源：docs/DEV.md §2.3（User / Conversation 两套形状 + 两个 resolve 函数）
"use strict";

import { uid, now, hashStr } from "./util.js";
// 旧数据里 accent 停在「白 / 近白」上的要迁移掉：isWhiteish 的唯一实现在 theme.js。
// 循环依赖是安全的：theme.js 只在函数体内读本模块的绑定，不读模块初始化瞬间的值。
import { isWhiteish } from "./theme.js";

/** 结构化错误（工具层按 err.code 分支；与 js/core/tools/*.js 里的同形状，不改全局 Error） */
function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 壁纸枚举（唯一权威口径，别处不许自造字符串）：极光 / 深绿 / 暮紫 */
export const WALLPAPERS = ["aurora", "forest", "dusk"];

/** 默认主题色（用户定：浅灰 #e5e5ea = iOS systemGray5；白色主题已下线） */
export const DEFAULT_ACCENT = "#e5e5ea";

/** 主题色候选（settings.accent / conv.accent / member.accent 都只存色值） */
export const ACCENT_COLORS = ["#e5e5ea", "#0075de", "#00a884", "#7c5cff", "#d97757"];

/** 旧枚举 → 新枚举（用户已存的旧选择不能丢） */
const WALLPAPER_ALIASES = {
  gradient: "aurora",
  midnight: "forest",
  topo: "dusk",
  aurora: "aurora",
  forest: "forest",
  dusk: "dusk",
};

/** 上下文预算默认值（§2.6）：100000 token，到预算只提醒模型自己折；0 = 关闭压缩，全量直喂 */
export const DEFAULT_CONTEXT_BUDGET = 100000;

/** 预算上限（§2.6）：模型窗口 100 万，再往上填没有意义 */
export const MAX_CONTEXT_BUDGET = 1000000;

/**
 * 默认接口地址。
 * 网页版跑在 dev-server 上，`/gw/v1` 是同源反代（见 dev-server.mjs）。
 * 装成 App 之后没有那个反代：Capacitor 的 origin 是 `https://localhost`（androidScheme:"https"），
 * 同源请求会打到 App 自己身上，所以默认走云端网关的 `/cors/` 前缀（magpie 不自己发 CORS 头）。
 * 用户随时可以在设置页改掉。
 */
function defaultBaseUrl() {
  try {
    const loc = globalThis.location;
    if (loc && loc.protocol === "https:" && loc.hostname === "localhost") return "https://gw.ms7.pw/cors/v1";
  } catch (e) {}
  return "/gw/v1";
}

/**
 * 默认模型。
 * 本机 magpie 的 `group/meru` 是本地别名（100 万上下文）；云端网关没有这个别名，
 * 那边叫 `auto/...`（自动路由）或 `provider/model`。App 默认用云端的 auto。
 */
function defaultModel() {
  try {
    const loc = globalThis.location;
    if (loc && loc.protocol === "https:" && loc.hostname === "localhost") return "auto/deepseek-v4.1-flash";
  } catch (e) {}
  return "group/meru";
}

/** 默认用户（= 原来的全局设置；模型/接口这几项也在同一对象里） */
export const DEFAULT_SETTINGS = {
  name: "内测用户01",
  avatar: { label: "内", color: "#f5a623" },
  accent: DEFAULT_ACCENT,
  defaultWallpaper: "aurora",
  baseUrl: defaultBaseUrl(),
  model: defaultModel(),
  apiKey: "",
  searchUrl: "/search",
  searchKey: "",
  dim: 0,
  // 上下文（§2.6）：预算 token 数 / 是否自动压缩
  contextBudget: DEFAULT_CONTEXT_BUDGET,
  contextCompress: true,
};

/** 头像底色板（会话与用户共用；渲染统一走 js/ui/avatar.js） */
export const AVATAR_COLORS = [
  "#f5a623",
  "#5ac8fa",
  "#35c759",
  "#a06bff",
  "#ff6b9d",
  "#00b8a9",
];

/** 名字 → 头像对象 {label, color}（颜色默认 null = 跟随主题色，见 resolveAvatarColor） */
export function avatarForName(name) {
  const label = String(name == null ? "" : name).trim() || "?";
  return { label, color: null };
}

/** 用户头像：label 存首字（§2.3 口径），颜色默认 null = 跟随用户主题色 */
function avatarForUser(name) {
  const full = String(name == null ? "" : name).trim() || DEFAULT_SETTINGS.name;
  const ch = Array.from(full)[0] || "?";
  return { label: ch, color: null };
}

// 默认头像与默认名字同源（改默认名只改上面那处）
DEFAULT_SETTINGS.avatar = avatarForUser(DEFAULT_SETTINGS.name);

/**
 * 头像底色（**唯一权威解析**）：显式 color 优先，否则跟随传入的主题色。
 * 有 image 时颜色无所谓（渲染器会用图片）。
 * @param {{color?: string|null, image?: string}} [avatar]
 * @param {string} [accent]
 * @returns {string}
 */
export function resolveAvatarColor(avatar, accent) {
  const own = avatar && avatar.color;
  if (typeof own === "string" && own) return own;
  if (typeof accent === "string" && accent) return accent;
  return DEFAULT_ACCENT;
}

/** 任意 avatar 形状归一（label 必填、color 默认 null = 跟随主题色） */
function normalizeAvatar(a, baseLabel) {
  const src = a && typeof a === "object" ? a : null;
  const out = {
    label: (src && typeof src.label === "string" && src.label.trim()) || baseLabel,
    color: (src && typeof src.color === "string" && src.color) || null,
  };
  if (src && typeof src.image === "string" && src.image) out.image = src.image;
  return out;
}

/** 老数据里的壁纸值 → 新枚举（gradient→aurora / midnight→forest / topo→dusk；未知值丢弃回 null） */
function migrateWallpaperValue(v) {
  const k = typeof v === "string" ? WALLPAPER_ALIASES[v] : null;
  return k || null;
}

/** 老设置里的主题色：可能是色值也可能是 skin 名 */
const OLD_SKIN_COLORS = {
  notion: "#0075de",
  wa: "#00a884",
  gpt: "#10a37f",
  claude: "#d97757",
  tg: "#0088cc",
  imessage: "#34c759",
  night: "#7c5cff",
  purple: "#7c5cff",
};

/**
 * 老设置里的主题色：可能是色值也可能是 skin 名。
 * 另外把停在「白 / 近白」上的旧值迁到默认浅灰 —— 白色主题已下线（用户：主题色不要有白色）。
 */
function migrateAccent(a) {
  const v = String(a == null ? "" : a).trim();
  if (!v) return DEFAULT_SETTINGS.accent;
  const hex = v.charAt(0) === "#" ? v : OLD_SKIN_COLORS[v] || "";
  if (!hex) return DEFAULT_SETTINGS.accent;
  if (isWhiteish(hex)) return DEFAULT_ACCENT;
  return hex;
}

/** 设置形状归一（= User 对象）：老字段（selfName / wallpaper / wallpaperDataUrl / skin）就地迁到新口径 */
function normalizeSettings(old) {
  const s = Object.assign({}, old || {});
  const name = String(s.name || s.selfName || "").trim() || DEFAULT_SETTINGS.name;
  const out = Object.assign({}, DEFAULT_SETTINGS, s, {
    name,
    // 老数据只有 selfName；留着给还没改完的卡片读，值永远等于 name
    selfName: name,
    avatar: normalizeAvatar(s.avatar, avatarForUser(name).label),
    accent: migrateAccent(s.accent),
    // 老字段 wallpaper 只有 gradient/midnight/custom，映射后仍可能是 null
    defaultWallpaper: migrateWallpaperValue(s.defaultWallpaper || s.wallpaper) || "aurora",
    baseUrl: typeof s.baseUrl === "string" && s.baseUrl ? s.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: typeof s.model === "string" && s.model ? s.model : DEFAULT_SETTINGS.model,
    apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
    searchUrl: typeof s.searchUrl === "string" && s.searchUrl ? s.searchUrl : DEFAULT_SETTINGS.searchUrl,
    searchKey: typeof s.searchKey === "string" ? s.searchKey : "",
    dim: typeof s.dim === "number" ? s.dim : 0,
    // 上下文预算（§2.6）：非数字 → 默认 100000；负数归 0（0 = 不限，全量直喂）
    contextBudget: normalizeBudget(s.contextBudget),
    contextCompress: s.contextCompress === undefined ? DEFAULT_SETTINGS.contextCompress : !!s.contextCompress,
  });
  // 老键不再保留，避免出现「第二处主题色/第二处壁纸」
  delete out.wallpaper;
  delete out.wallpaperDataUrl;
  delete out.skin;
  return out;
}

/** 会话 / 成员自己挑的主题色：非色值或白/近白 → null（= 跟随用户默认） */
function accentOrNull(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.charAt(0) !== "#") return null;
  if (isWhiteish(s)) return null; // 旧数据里的「白」= 默认，迁移成跟随默认
  return s;
}

/** 上下文预算归一：非数字 → 默认 100000；负数 → 0（0 表示不限）；上限 1000000 */
function normalizeBudget(v) {
  if (typeof v !== "number" || !isFinite(v)) return DEFAULT_CONTEXT_BUDGET;
  if (v < 0) return 0;
  return Math.min(MAX_CONTEXT_BUDGET, Math.round(v));
}

/**
 * 会话形状归一（私聊与群聊同一形状，只靠 kind 区分）。
 * 老数据可能用 name / subject 存标题、用字符串存壁纸、没有 avatar/accent/agentsMd。
 * 幂等：对已经归一过的记录再跑一次得到同样的值。
 */
function normalizeConversation(c) {
  if (!c) return c;
  const title = String(c.title || c.name || c.subject || "未命名").trim() || "未命名";
  const avatar = normalizeAvatar(c.avatar, avatarForName(title).label);
  const kind = c.kind === "group" ? "group" : "direct";
  const out = {
    id: c.id,
    kind,
    title,
    avatar,
    wallpaper: migrateWallpaperValue(c.wallpaper),
    // 颜色偏好：null = 跟随用户默认；旧数据里的白/近白一律视为「跟随默认」（白色主题已下线）
    accent: accentOrNull(c.accent),
    pinned: !!c.pinned,
    // 软删除（§2.7.3）：会话列表不显示，群里的成员照旧存在；与硬删除 deleteConversation 不是一回事
    removedByUser: !!c.removedByUser,
    createdAt: c.createdAt || 0,
    updatedAt: c.updatedAt || c.createdAt || 0,
  };
  if (kind === "group") {
    out.announcement = typeof c.announcement === "string" ? c.announcement : "";
  }
  // 会话级规则文本：所有会话都有这一项（默认空串，只当普通字符串用）
  out.agentsMd = typeof c.agentsMd === "string" ? c.agentsMd : "";
  return out;
}

/**
 * v1 → v2：把会话记录与设置改写成新形状。
 * 跑在 upgrade 事务里，只能用游标回调，不能 await。
 */
function migrateV1ToV2(t2) {
  if (!t2) return;
  try {
    const convs = t2.objectStore("conversations");
    const cur = convs.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      c.update(normalizeConversation(c.value));
      c.continue();
    };
  } catch (err) {
    console.warn("[store] 会话迁移失败", err);
  }
  try {
    const kv = t2.objectStore("kv");
    const r = kv.get(KV_KEY);
    r.onsuccess = () => {
      const row = r.result;
      if (row && row.v) kv.put({ k: KV_KEY, v: normalizeSettings(row.v) });
    };
  } catch (err) {
    console.warn("[store] 设置迁移失败", err);
  }
}

/** 私聊默认成员人格 */
export const DEFAULT_PERSONA = "你是一位乐于帮忙的对话成员，回答简洁、用用户的语言。";

const DB_NAME = "meruchat";
const DB_VERSION = 5;
const KV_KEY = "app";

/** 单条 memo 在 memos 表里的固定 key（老的多键记录在 open 时并进这条，见 migrateMemosToSingle） */
const MEMO_SINGLE_KEY = "";
/** 不属于任何会话的备忘（工具层只写全局桶） */
const GLOBAL_SCOPE = "";

/** 关系里的「用户」这一侧：peerId 用这个常量，不参与会话 id 命名空间 */
export const USER_PEER = "user";
/** 踢人 / 删用户 / 申请进群 / 好友申请共用的冷却（用户定：3 分钟） */
export const COOLDOWN_MS = 180000;

// ---- 「自己」的唯一取值入口（设置页大头像、群聊里自己的头像都用它） ----
// 模块级快照：任何 store 实例读/写设置时都会更新它，所以 getSelf() 可以同步返回。
let lastSettings = null;

/**
 * 取当前用户身份（**唯一入口**：设置页大头像、群聊里自己的头像都用它）。
 * 返回值形状 `{name, avatar}`，与 §2.3 的 User 对齐；avatar 是统一的
 * `{label, color, image?}`，label 存名字首字。
 * 不传参时用模块级快照（真实 store 读/写设置时更新）；预览壳的 mock store
 * 不经过真实读取路径，所以可以把自己那份 settings 传进来。
 * @param {{name?: string, selfName?: string, avatar?: object}} [source]
 * @returns {{name: string, avatar: {label: string, color: string, image?: string}}}
 */
export function getSelf(source) {
  const s = source || lastSettings;
  const name = String((s && (s.name || s.selfName)) || "").trim() || DEFAULT_SETTINGS.name;
  const avatar = normalizeAvatar(s && s.avatar, avatarForUser(name).label);
  // 自己的头像颜色跟着自己的主题色走（用户改主题色 → 头像同步变色）
  return { name, avatar: Object.assign({}, avatar, { color: resolveAvatarColor(avatar, s && s.accent) }) };
}

/**
 * 某个会话实际生效的壁纸（**唯一权威解析**，卡片/主题层都 import 这里）。
 * conv.wallpaper 为 null/缺失/未知值 → 一律回落到 user.defaultWallpaper；
 * defaultWallpaper 本身也不认识 → aurora。不抛错。
 * @param {{wallpaper?: string|null}} [conv]
 * @param {{defaultWallpaper?: string}} [user]
 * @returns {"aurora"|"forest"|"dusk"}
 */
export function resolveWallpaper(conv, user) {
  const own = conv && conv.wallpaper;
  if (WALLPAPERS.indexOf(own) >= 0) return own;
  const fallback = user && user.defaultWallpaper;
  if (WALLPAPERS.indexOf(fallback) >= 0) return fallback;
  return "aurora";
}

/**
 * 某个会话实际生效的主题色（**唯一权威解析**）。
 * conv.accent 为 null/缺失 → user.accent；再不行 → 默认色。不抛错。
 * @param {{accent?: string|null}} [conv]
 * @param {{accent?: string}} [user]
 * @returns {string} 形如 "#0075de"
 */
export function resolveAccent(conv, user) {
  const own = conv && conv.accent;
  if (typeof own === "string" && own) return own;
  const fallback = user && user.accent;
  if (typeof fallback === "string" && fallback) return fallback;
  return DEFAULT_ACCENT;
}

/**
 * 某个成员发言时的气泡颜色（**唯一权威解析**）。
 * member.accent → user.accent → DEFAULT_ACCENT。群聊里「谁说的就用谁的颜色」。
 * @param {{accent?: string|null}} [member]
 * @param {{accent?: string}} [user]
 * @returns {string}
 */
export function resolveMemberAccent(member, user) {
  const own = member && member.accent;
  if (typeof own === "string" && own) return own;
  const fallback = user && user.accent;
  if (typeof fallback === "string" && fallback) return fallback;
  return DEFAULT_ACCENT;
}

/**
 * 建立数据层实例。同一个页面只建一个（shell 里建）。
 * @returns {object} store
 */
export function createStore() {
  /** @type {IDBDatabase|null} */
  let db = null;
  let opening = null;
  /** 上次 open 是否被旧连接挡住（诊断用，见 blocked 状态） */
  let lastBlocked = false;

  /** 关闭本页持有的连接（升级库、换库、测试前都要先关） */
  function close() {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
    db = null;
    opening = null;
  }

  /** open() 的兜底超时：IDB 在「旧连接占用/库状态坏掉」时可能一个事件都不发，永远不 settle */
const OPEN_TIMEOUT_MS = 8000;

function open() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;

    // 关键：把 promise 本身 pin 住并立刻赋给 opening，
    // 不能在 onsuccess 里把 opening 置 null 之后再 `return opening`（那时已是 null）。
    const pin = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        opening = null;
        reject(new Error("IDB 打开超时（可能被旧连接占用）：请关掉其它标签页后刷新"));
      }, OPEN_TIMEOUT_MS);

      function done(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      }

      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        done(reject, err);
        return;
      }

      req.onupgradeneeded = (e) => {
        try {
          const d = e.target.result;
          const t2 = e.target.transaction;
          // upgrade 事务自己出错/被中止时，req 上不一定有事件：这里必须留痕
          if (t2) {
            t2.onabort = () =>
              console.error("[store] 升级事务被中止：", t2.error && t2.error.name);
            t2.onerror = (ev) =>
              console.error("[store] 升级事务出错：", ev && ev.target && ev.target.error);
          }
          if (!d.objectStoreNames.contains("conversations")) {
            const cs = d.createObjectStore("conversations", { keyPath: "id" });
            cs.createIndex("updatedAt", "updatedAt");
          }
          if (!d.objectStoreNames.contains("members")) {
            const ms = d.createObjectStore("members", { keyPath: "id" });
            ms.createIndex("convId", "convId");
          }
          if (!d.objectStoreNames.contains("messages")) {
            const gs = d.createObjectStore("messages", { keyPath: "id" });
            gs.createIndex("convId", "convId");
            gs.createIndex("ts", "ts");
          }
          if (!d.objectStoreNames.contains("kv")) {
            d.createObjectStore("kv", { keyPath: "k" });
          }
          // v2：备忘（按会话分桶，单条 ≤2048）
          if (!d.objectStoreNames.contains("memos")) {
            const mo = d.createObjectStore("memos", { keyPath: ["conversationId", "key"] });
            mo.createIndex("conversationId", "conversationId");
          }
          // v3：压缩块（§2.6）。老库只加表，不动已有数据。
          if (!d.objectStoreNames.contains("blocks")) {
            const bs = d.createObjectStore("blocks", { keyPath: "id" });
            bs.createIndex("by_conv", "conversationId");
            bs.createIndex("by_index", ["conversationId", "index"]);
          }
          // v4：会话间关系（§2.7）。老库只加表，不动已有数据。
          if (!d.objectStoreNames.contains("relations")) {
            const rs = d.createObjectStore("relations", { keyPath: ["convId", "peerId"] });
            rs.createIndex("by_conv", "convId");
            rs.createIndex("by_peer", "peerId");
          }
          // v5：群成员 = 会话引用（§2.8）。老库只加表，数据由 migrateGroupMembers 搬。
          if (!d.objectStoreNames.contains("group_members")) {
            const gm = d.createObjectStore("group_members", { keyPath: ["groupId", "memberConvId"] });
            gm.createIndex("by_group", "groupId");
          }
          // v1 → v2 数据迁移：会话形状 + 设置字段（幂等，可在 upgrade 事务里跑）
          if (e.oldVersion && e.oldVersion < 2) {
            migrateV1ToV2(t2);
          }
        } catch (err) {
          // 升级里抛异常会让整个 upgrade 事务 abort；这里抛出去也只会走到 req.onerror
          console.error("[store] 升级失败：", err);
          throw err;
        }
      };

      req.onsuccess = (e) => {
        const d = e.target.result;
        db = d;
        d.onversionchange = () => {
          try {
            d.close();
          } catch (_) {}
          if (db === d) db = null;
          console.warn("[store] 数据库需要升级：已关闭本页连接，请刷新页面");
        };
        done(resolve, d);
      };

      req.onblocked = () => {
        lastBlocked = true;
        console.warn("[store] 数据库被旧连接占用：请关掉其它标签页或刷新本页");
      };

      req.onerror = (e) => {
        const err = (e.target && e.target.error) || new Error("IDB 打开失败");
        done(reject, err);
      };
    });

    // 失败后清空，下一次调用可以重试
    opening = pin.catch((err) => {
      opening = null;
      throw err;
    });
    return pin;
  }

  function tx(stores, mode) {
    return open().then((d) => d.transaction(stores, mode));
  }

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function txDone(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // ---- generic CRUD ----
  function dbGet(store, key) {
    return tx(store, "readonly").then((t) => req(t.objectStore(store).get(key)));
  }
  function dbPut(store, value) {
    return tx(store, "readwrite").then((t) => {
      t.objectStore(store).put(value);
      return txDone(t).then(() => value);
    });
  }
  function dbDel(store, key) {
    return tx(store, "readwrite").then((t) => {
      t.objectStore(store).delete(key);
      return txDone(t);
    });
  }
  function dbAll(store) {
    return tx(store, "readonly").then((t) => req(t.objectStore(store).getAll()));
  }
  function dbByIndex(store, index, value) {
    return tx(store, "readonly").then((t) => req(t.objectStore(store).index(index).getAll(value)));
  }
  function kvGet(k, dflt) {
    return dbGet("kv", k).then((row) => (row ? row.v : dflt));
  }
  function kvSet(k, v) {
    return dbPut("kv", { k, v });
  }

  // ---- 内存里的设置快照（单一真源，避免并发读-改-写互相覆盖） ----
  let settingsCache = null;

  function normalizeMember(convId, data, sort) {
    data = data || {};
    const name = String(data.name || "成员").trim() || "成员";
    return {
      id: data.id || uid(),
      convId,
      name,
      avatar: normalizeAvatar(data.avatar, avatarForName(name).label),
      // 这个成员发言时的气泡色；null = 跟随用户默认（§2.3）；旧的白/近白也归到 null
      accent: accentOrNull(data.accent),
      persona: data.persona || "",
      roleTag: typeof data.roleTag === "string" ? data.roleTag : "",
      model: data.model || "",
      sort: typeof data.sort === "number" ? data.sort : sort || 0,
      // 会话进群复制出来的成员行（§2.7）：记来源会话与来源成员，被踢时据此知道通知谁。
      // 老成员行没有这两项 → null（预期，不是缺字段）。
      originConvId: typeof data.originConvId === "string" ? data.originConvId : null,
      originMemberId: typeof data.originMemberId === "string" ? data.originMemberId : null,
    };
  }

  // ================================================================ 会话
  function listConversations() {
    return dbAll("conversations").then((list) => {
      list.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return list.map(normalizeConversation);
    });
  }

  function getConversation(id) {
    return dbGet("conversations", id).then(normalizeConversation);
  }

  /** 活会话（过滤掉 removedByUser）—— 会话列表卡用这个；排序完全复用 listConversations */
  function listActiveConversations() {
    return listConversations().then((list) => list.filter((c) => !c.removedByUser));
  }

  /** 软删除（§2.7.3）：列表不再显示，群里的成员照旧存在（与 deleteConversation 的硬删除不是一回事） */
  function softDeleteConversation(id) {
    // 软删除不改 updatedAt：它不该把会话顶到列表最前（虽然列表此时也不显示它）
    return updateConversation(id, { removedByUser: true, touch: false }).then(() => ({ ok: true }));
  }

  /** 撤销软删除 */
  function restoreConversation(id) {
    return updateConversation(id, { removedByUser: false, touch: false }).then(() => ({ ok: true }));
  }

  function putConversation(c) {
    // 若没写 kind，按成员数推断一次再落库
    if (c && c.kind !== "direct" && c.kind !== "group") {
      return listMembers(c.id).then((mems) => {
        const next = Object.assign({}, c, { kind: mems.length >= 2 ? "group" : "direct" });
        return dbPut("conversations", next);
      });
    }
    return dbPut("conversations", c);
  }

  /**
   * 旧数据兜底：没有 kind 的会话按成员数推断一次（1 → direct，≥2 → group）并写回。
   * @returns {Promise<number>} 回填条数
   */
  function backfillKinds() {
    return dbAll("conversations").then((list) => {
      const missing = list.filter((c) => c.kind !== "direct" && c.kind !== "group");
      if (!missing.length) return 0;
      return Promise.all(
        missing.map((c) =>
          listMembers(c.id).then((mems) => {
            c.kind = mems.length >= 2 ? "group" : "direct";
            return dbPut("conversations", c);
          })
        )
      ).then(() => missing.length);
    });
  }

  /**
   * 新建会话（**对象参数是唯一签名**，见 docs/DEV.md §3）。
   * kind 是会话形态，不能由成员数推断（删到 1 人也仍是群聊）。
   *
   *   createConversation({ kind = "direct", title, members = [] })
   *     → Promise<{ conversation, members }>
   *
   * 兼容层：第一个参数是字符串时按旧签名 (title, members, kind) 处理，老调用不会炸。
   * @param {{kind?: "direct"|"group", title?: string, members?: Array} | string} options
   * @param {Array} [legacyMembers]
   * @param {"direct"|"group"} [legacyKind]
   */
  function createConversation(options, legacyMembers, legacyKind) {
    let kind;
    let title;
    let members;
    if (typeof options === "string" || options == null) {
      // 旧签名：(title, members, kind)
      title = options;
      members = legacyMembers;
      kind = legacyKind;
    } else {
      kind = options.kind;
      title = options.title;
      members = options.members;
    }
    const t = now();
    const kindOf = kind === "group" ? "group" : "direct";
    const name = String(title || "").trim() || (kindOf === "group" ? "新群聊" : "新会话");
    const conv = {
      id: uid(),
      kind: kindOf,
      title: name,
      avatar: avatarForName(name),
      // 背景/颜色：null = 跟随用户默认（§2.3）
      wallpaper: null,
      accent: null,
      pinned: false,
      createdAt: t,
      updatedAt: t,
      // 会话级规则文本（普通字符串，默认空）
      agentsMd: "",
    };
    if (kindOf === "group") {
      // 群公告板（仅群聊详情页用）
      conv.announcement = "";
    }
    const specs = (members || []).slice();
    if (!specs.length) specs.push({ name: "助手", persona: DEFAULT_PERSONA });

    // 私聊：会话自带一个身份行，成员行的 convId = 本会话（§2.8，不变）
    if (kindOf === "direct") {
      const mems = specs.map((m, i) => normalizeMember(conv.id, m, i));
      return tx(["conversations", "members"], "readwrite").then((os) => {
        os.objectStore("conversations").put(conv);
        mems.forEach((m) => os.objectStore("members").put(m));
        return txDone(os).then(() => ({ conversation: conv, members: mems }));
      });
    }

    // 群聊：成员是**已有私聊会话的引用**（§2.8 共享账本）。
    //   先把要引用的会话与身份行全部读出来（不能在写事务里 await 别的事务，那会让外层事务自动提交），
    //   再开一个事务统一写：群会话 + （缺的）私聊家会话 + 身份行 + group_members 引用。
    const plans = [];
    const planOne = (spec, i) => {
      const wanted = String((spec && (spec.memberConvId || spec.convId)) || "").trim();
      if (!wanted) {
        plans.push({ sort: i, spec, home: null, row: null });
        return Promise.resolve(null);
      }
      return dbGet("conversations", wanted).then((home) => {
        if (!home || home.kind !== "direct") {
          plans.push({ sort: i, spec, home: null, row: null });
          return null;
        }
        // 复用的会话必须已经有身份行，否则给它补一行（老库极少数情况）
        return memberRowForConv(home.id).then((row) => {
          plans.push({ sort: i, spec, home, row: row || null });
          return null;
        });
      });
    };
    return specs
      .reduce((p, spec, i) => p.then(() => planOne(spec, i)), Promise.resolve(null))
      .then(() => tx(["conversations", "members", "group_members"], "readwrite"))
      .then((os) => {
        const convOs = os.objectStore("conversations");
        const memOs = os.objectStore("members");
        const gmOs = os.objectStore("group_members");
        convOs.put(conv);
        const out = plans.map((plan) => {
          let home = plan.home;
          let row = plan.row;
          if (!home) {
            // 没有可引用的会话 → 给这个 AI 建一个私聊（它的「家」）
            const title = String(plan.spec.name || "").trim() || "新会话";
            home = {
              id: uid(),
              kind: "direct",
              title,
              avatar: plan.spec.avatar || avatarForName(title),
              wallpaper: null,
              accent: (plan.spec && plan.spec.accent) || null,
              pinned: false,
              createdAt: t,
              updatedAt: t,
              agentsMd: "",
            };
            convOs.put(home);
          }
          if (!row) {
            row = normalizeMember(home.id, plan.spec || {}, 0);
            memOs.put(row);
          }
          gmOs.put({ groupId: conv.id, memberConvId: home.id, sort: plan.sort });
          return Object.assign({}, row, { sort: plan.sort });
        });
        return txDone(os).then(() => ({
          conversation: conv,
          members: out.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)),
        }));
      });
  }

  function updateConversation(id, patch) {
    return dbGet("conversations", id).then((c) => {
      if (!c) throw new Error("会话不存在");
      const touch = !(patch && patch.touch === false);
      const next = Object.assign({}, c, patch, { updatedAt: touch ? now() : c.updatedAt });
      delete next.touch;
      // 改名后头像要跟着新名字走（调用方没显式给 avatar 时）
      if (patch && typeof patch.title === "string" && !(patch && patch.avatar)) {
        next.avatar = avatarForName(next.title);
      }
      return dbPut("conversations", next);
    });
  }

  function touchConversation(id) {
    return dbGet("conversations", id).then((c) => {
      if (!c) return;
      c.updatedAt = now();
      return dbPut("conversations", c);
    });
  }

  /** 单一置顶不变量：置顶某条时先清掉其它所有置顶 */
  function setPinned(id, pinned) {
    return dbAll("conversations").then((list) =>
      tx("conversations", "readwrite").then((t) => {
        const os = t.objectStore("conversations");
        list.forEach((c) => {
          if (c.pinned) {
            c.pinned = false;
            os.put(c);
          }
        });
        const target = list.filter((c) => c.id === id)[0];
        if (target && pinned) {
          return req(os.get(id)).then((cur) => {
            if (!cur) return txDone(t);
            cur.pinned = true;
            cur.updatedAt = now();
            os.put(cur);
            return txDone(t);
          });
        }
        return txDone(t);
      })
    );
  }

  /**
   * 级联删除：会话 + 它的成员 + 它的消息 + 它的备忘 + 它的压缩块 + 它的关系；
   * 若删掉的是置顶，把最近更新的一条置顶。
   */
  function deleteConversation(id) {
    return Promise.all([
      dbByIndex("members", "convId", id),
      dbByIndex("messages", "convId", id),
      dbByIndex("memos", "conversationId", id),
      dbByIndex("blocks", "by_conv", id),
      // relations 双向清：自己作为主体的关系 + 别人指向它的关系（别人踢它的记录也清）
      dbByIndex("relations", "by_conv", id),
      dbByIndex("relations", "by_peer", id),
      // group_members 双向清（§2.8）：删群 → 该群所有引用；删私聊 → 各群里指向它的引用
      // （memberConvId 没有索引，表很小，整表扫一遍最省事）
      dbAll("group_members"),
    ]).then(([mems, msgs, memoRows, blockRows, relOwn, relPeer, gmRows]) =>
        tx(["conversations", "members", "messages", "memos", "blocks", "relations", "group_members"], "readwrite").then((t) => {
          mems.forEach((m) => t.objectStore("members").delete(m.id));
          msgs.forEach((m) => t.objectStore("messages").delete(m.id));
          memoRows.forEach((m) => t.objectStore("memos").delete([m.conversationId, m.key]));
          blockRows.forEach((b) => t.objectStore("blocks").delete(b.id));
          relOwn.concat(relPeer).forEach((r) => t.objectStore("relations").delete([r.convId, r.peerId]));
          (gmRows || []).forEach((r) => {
            if (r.groupId === id || r.memberConvId === id) {
              t.objectStore("group_members").delete([r.groupId, r.memberConvId]);
            }
          });
          t.objectStore("conversations").delete(id);
          return txDone(t);
        })
      )
      .then(() =>
        dbAll("conversations").then((list) => {
          if (list.length && !list.some((c) => c.pinned)) {
            const sorted = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return setPinned(sorted[0].id, true);
          }
        })
      );
  }

  // ================================================================ 成员
  /**
   * 取某个「归属私聊会话」的身份行。
   * group_members 里存的是 memberConvId（= 那条成员行的 convId），不是成员行 id，
   * 所以主路径走 convId 索引；先按 id 直取只是兜底（老库里成员行 id 恰好等于会话 id 的情况）。
   */
  function memberRowForConv(memberConvId) {
    if (!memberConvId) return Promise.resolve(null);
    return dbGet("members", memberConvId).then(
      (row) => row || dbByIndex("members", "convId", memberConvId).then((list) => (list && list[0]) || null)
    );
  }

  /**
   * 会话的成员列表（§2.8 共享账本）。
   *   私聊（或读不到 kind 的老数据）→ members 按 convId 索引查（老行为，不变）。
   *   群聊 → group_members 的 by_group 拿 memberConvId 列表，逐个读身份行；
   *          引用指向的会话被删了 → 跳过那一行（不报错），按 group_members.sort 排序。
   * 返回对象形状与老实现一致：{ id, convId, name, persona, avatar, accent, roleTag, model, sort }，
   * 其中 id 是**成员行 id**、convId 是它的**归属私聊 id**、sort 用 **group_members.sort**。
   */
  function listMembers(convId) {
    if (!convId) return Promise.resolve([]);
    return getConversation(convId).then((conv) => {
      if (!conv || conv.kind !== "group") {
        return dbByIndex("members", "convId", convId).then((list) => {
          list.sort((a, b) => (a.sort || 0) - (b.sort || 0));
          return list;
        });
      }
      return dbByIndex("group_members", "by_group", convId).then((refs) => {
        const sorted = (refs || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
        return Promise.all(
          sorted.map((ref) =>
            memberRowForConv(ref.memberConvId).then((row) => {
              if (!row) return null; // 归属会话已被删 → 这条引用作废，跳过
              const s = typeof ref.sort === "number" ? ref.sort : row.sort;
              return Object.assign({}, row, { sort: s });
            })
          )
        ).then((list) => list.filter(Boolean));
      });
    });
  }

  function putMember(m) {
    // 没 convId 的成员没有归属，落库也没意义
    if (!m || !m.convId) return Promise.reject(new Error("putMember: 缺少 convId"));
    const next = m.id ? m : normalizeMember(m.convId, m, m.sort);
    return dbPut("members", next);
  }

  /**
   * 给会话加一个成员。
   *   私聊 → 直接写一条身份行（convId = 本会话，老行为）。
   *   群聊 → §2.8：给这个 AI 建一个私聊（它的「家」）+ 身份行，再在群里挂一条引用。
   *          群里**不再**写 convId === 群 id 的身份行（那会在有引用时读不出来）。
   * @returns {Promise<object>} 成员行（group 时带上群内 sort）
   */
  function addMember(convId, data) {
    if (!convId) return Promise.reject(new Error("addMember: 缺少 convId"));
    return getConversation(convId).then((conv) => {
      if (!conv || conv.kind !== "group") {
        return listMembers(convId).then((list) => {
          const m = normalizeMember(convId, data, list.length);
          return dbPut("members", m).then(() => m);
        });
      }
      return listMembers(convId).then((list) => {
        const t = now();
        const title = String((data && data.name) || "").trim() || "新会话";
        const home = {
          id: uid(),
          kind: "direct",
          title,
          avatar: (data && data.avatar) || avatarForName(title),
          wallpaper: null,
          accent: (data && data.accent) || null,
          pinned: false,
          createdAt: t,
          updatedAt: t,
          agentsMd: "",
        };
        const m = normalizeMember(home.id, data || {}, 0);
        const sort = list.length;
        return tx(["conversations", "members", "group_members"], "readwrite").then((os) => {
          os.objectStore("conversations").put(home);
          os.objectStore("members").put(m);
          os.objectStore("group_members").put({ groupId: convId, memberConvId: home.id, sort });
          return txDone(os).then(() => Object.assign({}, m, { sort }));
        });
      });
    });
  }

  /**
   * 身份行的 name / avatar 是**唯一真源**（§2.8）。「家会话」的标题与头像只是它的显示，
   * 所以改成员时把这两个字段镜像回家会话，否则会话列表还会显示旧名字（群里已叫新名）。
   * 只镜像 direct 家会话；群会话的标题是群名，跟成员无关。
   */
  function mirrorIdentityToHome(row, patch) {
    if (!row || !row.convId) return Promise.resolve(null);
    const touched = patch && (patch.name !== undefined || patch.avatar !== undefined);
    if (!touched) return Promise.resolve(null);
    return dbGet("conversations", row.convId).then((home) => {
      if (!home || home.kind !== "direct") return null;
      const next = Object.assign({}, home);
      if (patch.name !== undefined) next.title = row.name;
      if (patch.avatar !== undefined) next.avatar = row.avatar;
      if (next.title === home.title && next.avatar === home.avatar) return null;
      return dbPut("conversations", next);
    });
  }

  /**
   * 更新成员。支持两种调用：
   *   updateMember(member)      —— 整条落库（detail 卡片用的就是这种）
   *   updateMember(id, patch)   —— 读-改-写
   */
  function updateMember(a, b) {
    if (a && typeof a === "object") {
      if (!a.id) return Promise.reject(new Error("updateMember: 缺少 id"));
      if (!a.convId) return Promise.reject(new Error("updateMember: 缺少 convId"));
      return dbPut("members", a).then((row) => {
        // 整条落库时没有 patch 概念：name/avatar 一律镜像（幂等，同值不写）
        return mirrorIdentityToHome(row, { name: row.name, avatar: row.avatar }).then(() => row);
      });
    }
    if (!a) return Promise.reject(new Error("updateMember: 缺少 id"));
    return dbGet("members", a).then((cur) => {
      if (!cur) return null;
      const row = Object.assign({}, cur, b || {}, { id: cur.id, convId: cur.convId });
      return dbPut("members", row).then(() => mirrorIdentityToHome(row, b || {}).then(() => row));
    });
  }

  function deleteMember(id) {
    return dbDel("members", id);
  }

  // ================================================================ 消息
  function listMessages(convId) {
    return dbByIndex("messages", "convId", convId).then((list) => {
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      // 老记录没有 foldedBlockId = 未折叠（§2.6）
      return list.map((m) => (m.foldedBlockId === undefined ? Object.assign({}, m, { foldedBlockId: null }) : m));
    });
  }

  /**
   * 追加一条消息。调用方不必给 id / seq（keyPath 是 id，缺 id 会直接 DataError）：
   *   - id 缺失 → uid()
   *   - seq 缺失 → 该会话现有消息的最大 seq + 1
   *   - ts 缺失 → now()
   * @param {object} m {convId, role, content, memberId?, id?, seq?, ts?}
   */
  function addMessage(m) {
    const src = Object.assign({}, m || {});
    if (!src.convId) return Promise.reject(new Error("addMessage: 缺少 convId"));
    src.id = src.id || uid();
    if (typeof src.ts !== "number") src.ts = now();
    // 新消息一律未折叠（§2.6）
    if (src.foldedBlockId === undefined) src.foldedBlockId = null;
    if (typeof src.seq === "number") return dbPut("messages", src);
    return listMessages(src.convId).then((list) => {
      let max = -1;
      list.forEach((x) => {
        if (typeof x.seq === "number" && x.seq > max) max = x.seq;
      });
      src.seq = max + 1;
      return dbPut("messages", src);
    });
  }

  function updateMessage(id, patch) {
    return dbGet("messages", id).then((m) => {
      if (!m) return;
      return dbPut("messages", Object.assign(m, patch));
    });
  }

  /** 按 id 批量删消息（chat 卡片的「删除这条」用） */
  function deleteMessages(ids) {
    const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
    if (!list.length) return Promise.resolve(0);
    return tx("messages", "readwrite").then((t) => {
      const os = t.objectStore("messages");
      list.forEach((id) => os.delete(id));
      return txDone(t).then(() => list.length);
    });
  }

  /** 清空某会话的全部消息（保留会话与成员） */
  function clearMessages(convId) {
    return dbByIndex("messages", "convId", convId).then((list) => {
      if (!list.length) return 0;
      return tx("messages", "readwrite").then((t) => {
        const os = t.objectStore("messages");
        list.forEach((m) => os.delete(m.id));
        return txDone(t).then(() => list.length);
      });
    });
  }

  /** clearMessages 的契约别名（detail 卡片的回退链会试这个名字） */
  function deleteMessagesByConv(convId) {
    return clearMessages(convId);
  }

  // ================================================================ 设置
  function getSettings() {
    return kvGet(KV_KEY, null).then((s) => {
      const merged = normalizeSettings(s);
      settingsCache = merged;
      lastSettings = merged;
      return merged;
    });
  }

  function setSettings(patch) {
    const base = settingsCache || DEFAULT_SETTINGS;
    const next = normalizeSettings(Object.assign({}, base, patch || {}));
    settingsCache = next;
    lastSettings = next;
    return kvSet(KV_KEY, next).then(() => next);
  }

  /**
   * 老库的一次性口径修正：8000 是旧默认值，设置页现在不再暴露这个字段。
   * 存量库里凡是**恰好等于旧默认 8000** 的，都当作没改过，抬到新默认 100000。
   * 用户显式设过别的值（300000 / 0 / 50000…）一律不动，幂等。
   */
  function migrateLegacyBudget() {
    const LEGACY_DEFAULT = 8000;
    return getSettings().then((s) => {
      if (s.contextBudget !== LEGACY_DEFAULT) return 0;
      return setSettings({ contextBudget: DEFAULT_CONTEXT_BUDGET }).then(() => 1);
    });
  }

  // ================================================================ 备忘（memos）
  // 用户口径（2026-11-25）：备忘**只有一条**，是一段自由文本，**无长度上限**。
  // 表形状不变：{ conversationId, key, text, updatedAt }，主键 [conversationId, key]；
  // 单条记录固定用 key = MEMO_SINGLE_KEY（空串），所以不用建新表、不用升 DB_VERSION。
  // 老的「key → text 多条」在 open 时由 migrateMemosToSingle() 并成一条（幂等）。

  /** 读该 scope 的备忘；没有就是空串（**永不返回 null**） */
  function getMemo(convId) {
    const scope = convId == null ? GLOBAL_SCOPE : convId;
    return dbGet("memos", [scope, MEMO_SINGLE_KEY]).then((row) => (row && typeof row.text === "string" ? row.text : ""));
  }

  /** 整段覆盖写该 scope 的备忘；不截断，只做 String() 归一 + 去掉尾部空白 */
  function setMemo(text, convId) {
    const scope = convId == null ? GLOBAL_SCOPE : convId;
    const row = {
      conversationId: scope,
      key: MEMO_SINGLE_KEY,
      text: String(text == null ? "" : text).replace(/\s+$/, ""),
      updatedAt: now(),
    };
    return dbPut("memos", row).then(() => ({ text: row.text, updatedAt: row.updatedAt }));
  }

  /** 删掉该 scope 的备忘；删到了 true，本来没有 false */
  function clearMemo(convId) {
    const scope = convId == null ? GLOBAL_SCOPE : convId;
    return dbGet("memos", [scope, MEMO_SINGLE_KEY]).then((row) => {
      if (!row) return false;
      return dbDel("memos", [scope, MEMO_SINGLE_KEY]).then(() => true);
    });
  }

  /**
   * 老数据迁移（幂等）：把每个 scope 里「一个 key 一行」的老记录并成一条固定 key 的空串记录。
   * 拼法：按 key 排序，逐行 `key: text`（key 为空串的那条只取 text 本身）。
   * 只写一条空串 key 时，拼出来的就是它自己的文本，第二次跑什么都不改 —— 所以幂等。
   * @returns {Promise<number>} 被合并的 scope 数（0 = 无需迁移）
   */
  function migrateMemosToSingle() {
    return open()
      .then((d) => d.transaction("memos", "readwrite"))
      .then(
        (t) =>
          new Promise((resolve, reject) => {
            const os = t.objectStore("memos");
            const r = os.getAll();
            let merged = 0;
            r.onsuccess = () => {
              const rows = r.result || [];
              const byScope = {};
              rows.forEach((row) => {
                const scope = row.conversationId == null ? GLOBAL_SCOPE : row.conversationId;
                (byScope[scope] = byScope[scope] || []).push(row);
              });
              Object.keys(byScope).forEach((scope) => {
                const list = byScope[scope];
                // 已经是单条（只有一条空串 key）→ 不动
                if (list.length === 1 && list[0].key === MEMO_SINGLE_KEY) return;
                const sorted = list.slice().sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")));
                const text = sorted
                  .map((row) => {
                    const k = String(row.key == null ? "" : row.key);
                    const v = String(row.text == null ? "" : row.text);
                    return k ? k + ": " + v : v;
                  })
                  .filter((line) => line !== "")
                  .join("\n");
                const stamp = list.reduce((n, row) => Math.max(n, row.updatedAt || 0), 0) || now();
                os.put({ conversationId: scope, key: MEMO_SINGLE_KEY, text, updatedAt: stamp });
                sorted.forEach((row) => {
                  if (row.key !== MEMO_SINGLE_KEY) os.delete([row.conversationId == null ? GLOBAL_SCOPE : row.conversationId, row.key]);
                });
                merged += 1;
              });
            };
            t.oncomplete = () => resolve(merged);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
          })
      )
      .catch((err) => {
        // 迁移失败不能挡住打开库：老记录原样留着，下次再试
        console.warn("[store] 备忘合并失败（老记录保留）：", err && err.message ? err.message : err);
        return 0;
      });
  }

  // ================================================================ 群成员迁移（v4 → v5，§2.8.3）
  /**
   * 老模型 → 共享账本。老模型里「群成员」是 convId === groupId 的成员行；
   * 新模型里成员行只属于私聊，群侧只挂 group_members 引用。
   *
   * 对每个 group 的每条老成员行：
   *   1. 找同名私聊会话（kind==="direct" && title === member.name）→ 有就复用；
   *   2. 没有就新建一条 direct 会话（title/avatar/accent 照抄这条成员行），
   *      把成员行的 convId 改成新会话 id —— **成员行 id 不变**，历史消息的 memberId 继续有效；
   *   3. 写 group_members{groupId, memberConvId: 新会话 id, sort: member.sort}。
   *
   * 幂等：迁移后没有成员行的 convId 再指向群，第二次跑什么都不做；
   * 同一批里两个群有同名成员 → 第二个复用第一个刚建的私聊（directByTitle 随手更新）。
   * 单条失败只 console.warn 跳过，**绝不挡住打开库**（所以整体 resolve 而不是 reject）。
   *
   * @param {IDBTransaction} [txIn] 已有的事务（可选；不给就自己开一个 readwrite 事务）
   * @returns {Promise<number>} 迁移掉的成员行数（0 = 无需迁移）
   */
  function migrateGroupMembers(txIn) {
    const warn = (msg, err) => console.warn(msg, err && err.message ? err.message : err);
    const run = txIn
      ? Promise.resolve(txIn)
      : open().then((d) => d.transaction(["conversations", "members", "group_members"], "readwrite"));
    return run
      .then(
        (t) =>
          new Promise((resolve) => {
            const convsOs = t.objectStore("conversations");
            const memsOs = t.objectStore("members");
            const gmOs = t.objectStore("group_members");
            let convs = null;
            let mems = null;
            let migrated = 0;
            let started = false;

            const start = () => {
              if (started || !convs || !mems) return;
              started = true;
              try {
                const groupIds = {};
                const directByTitle = {};
                convs.forEach((c) => {
                  if (!c || !c.id) return;
                  if (c.kind === "group") {
                    groupIds[c.id] = true;
                  } else if (c.kind === "direct") {
                    const ttl = String(c.title || "").trim();
                    if (ttl && !directByTitle[ttl]) directByTitle[ttl] = c.id;
                  }
                });
                mems.forEach((m) => {
                  // 只搬「convId 指向群」的老成员行；新模型的成员行 convId 指向私聊，天然跳过
                  if (!m || !m.id || !m.convId || !groupIds[m.convId]) return;
                  try {
                    const groupId = m.convId;
                    const name = String(m.name || "").trim() || "成员";
                    let homeId = directByTitle[name];
                    if (!homeId) {
                      homeId = uid();
                      const stamp = now();
                      const home = {
                        id: homeId,
                        kind: "direct",
                        title: name,
                        avatar: m.avatar || avatarForName(name),
                        wallpaper: null,
                        accent: accentOrNull(m.accent),
                        pinned: false,
                        createdAt: stamp,
                        updatedAt: stamp,
                        agentsMd: "",
                      };
                      convsOs.put(home);
                      convs.push(home);
                      directByTitle[name] = homeId;
                    }
                    memsOs.put(Object.assign({}, m, { convId: homeId }));
                    gmOs.put({
                      groupId,
                      memberConvId: homeId,
                      sort: typeof m.sort === "number" ? m.sort : 0,
                    });
                    migrated += 1;
                  } catch (err) {
                    warn("[store] 群成员迁移：单条成员行跳过：", err);
                  }
                });
              } catch (err) {
                warn("[store] 群成员迁移失败（老数据保留）：", err);
              }
            };

            const cReq = convsOs.getAll();
            const mReq = memsOs.getAll();
            cReq.onsuccess = () => {
              convs = cReq.result || [];
              start();
            };
            cReq.onerror = () => {
              warn("[store] 群成员迁移：读会话失败：", cReq.error);
              convs = [];
              start();
            };
            mReq.onsuccess = () => {
              mems = mReq.result || [];
              start();
            };
            mReq.onerror = () => {
              warn("[store] 群成员迁移：读成员失败：", mReq.error);
              mems = [];
              start();
            };

            t.oncomplete = () => resolve(migrated);
            t.onerror = () => {
              warn("[store] 群成员迁移事务出错（老数据保留）：", t.error);
              resolve(migrated);
            };
            t.onabort = () => {
              warn("[store] 群成员迁移事务被中止（老数据保留）：", t.error);
              resolve(migrated);
            };
          })
      )
      .catch((err) => {
        warn("[store] 群成员迁移失败（老数据保留）：", err);
        return 0;
      });
  }

  // ================================================================ 压缩块（blocks）
  // 表形状（§2.6）：{ id, conversationId, index, fromSeq, toSeq, count, summary, tokens, createdAt }
  // index 从 1 递增 = 用户说的「压缩块 1、2、3」。

  /** 某会话的压缩块，按 index 升序 */
  function listBlocks(convId) {
    return dbByIndex("blocks", "by_conv", convId).then((list) =>
      list.sort((a, b) => (a.index || 0) - (b.index || 0))
    );
  }

  /** 写一条压缩块（自带 id 就用，否则 uid()） */
  function putBlock(block) {
    if (!block || !block.conversationId) {
      return Promise.reject(new Error("putBlock: 缺少 conversationId"));
    }
    const row = Object.assign({}, block, { id: block.id || uid() });
    return dbPut("blocks", row).then(() => row);
  }

  /** 清空某会话所有块，并把该会话所有消息的 foldedBlockId 置回 null */
  function deleteBlocks(convId) {
    return Promise.all([dbByIndex("blocks", "by_conv", convId), dbByIndex("messages", "convId", convId)]).then(
      ([blocks, msgs]) => {
        const folded = msgs.filter((m) => m.foldedBlockId != null);
        if (!blocks.length && !folded.length) return 0;
        return tx(["blocks", "messages"], "readwrite").then((t) => {
          const bs = t.objectStore("blocks");
          const ms = t.objectStore("messages");
          blocks.forEach((b) => bs.delete(b.id));
          folded.forEach((m) => {
            m.foldedBlockId = null;
            ms.put(m);
          });
          return txDone(t).then(() => blocks.length);
        });
      }
    );
  }

  /** 未折叠的消息（= 还要喂给模型的那部分），按 seq 升序 */
  function listUnfoldedMessages(convId) {
    return listMessages(convId).then((list) =>
      list.filter((m) => m.foldedBlockId == null).sort((a, b) => (a.seq || 0) - (b.seq || 0))
    );
  }

  /** 把一批消息标记成已折叠（消息本体不删，UI 照常显示） */
  function markFolded(convId, ids, blockId) {
    const list = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
    if (!list.length) return Promise.resolve(0);
    return dbByIndex("messages", "convId", convId).then((msgs) => {
      const want = {};
      list.forEach((id) => {
        want[id] = true;
      });
      const hit = msgs.filter((m) => want[m.id]);
      if (!hit.length) return 0;
      return tx("messages", "readwrite").then((t) => {
        const os = t.objectStore("messages");
        hit.forEach((m) => {
          m.foldedBlockId = blockId == null ? null : blockId;
          os.put(m);
        });
        return txDone(t).then(() => hit.length);
      });
    });
  }

  // ================================================================ 关系（relations 表，§2.7）
  // 表形状：{ convId, peerId, state: "ok"|"removed", until, at, byConvId }，主键 [convId, peerId]。
  //   主体会话 = convId（私聊=该会话，群聊=群）；对方 = peerId（另一个会话 id，或常量 USER_PEER）。
  // 冷却判定**只认** `state === "removed" && until > now()`；冷却过了只代表「允许重新申请」，
  // 不代表自动恢复 —— 恢复只能靠 clearRelation（接受申请 / 恢复好友时调）。

  /** 关系形状归一：state 只接受 ok / removed，其它一律 ok；数字字段非法就补默认 */
  function normalizeRelation(convId, peerId, data) {
    const src = data && typeof data === "object" ? data : {};
    return {
      convId,
      peerId,
      state: src.state === "removed" ? "removed" : "ok",
      until: typeof src.until === "number" && isFinite(src.until) ? src.until : 0,
      at: typeof src.at === "number" && isFinite(src.at) ? src.at : now(),
      byConvId: typeof src.byConvId === "string" ? src.byConvId : "",
    };
  }

  /** 读一条关系；没有就返回 null（不造默认行，避免污染） */
  function getRelation(convId, peerId) {
    if (!convId || !peerId) return Promise.resolve(null);
    return dbGet("relations", [convId, peerId]).then((row) =>
      row ? normalizeRelation(convId, peerId, row) : null
    );
  }

  /** 写一条关系（读-改-写，缺字段补默认）；每次写入都刷新 at（除非 patch 显式给了） */
  function setRelation(convId, peerId, patch) {
    if (!convId || !peerId) {
      return Promise.reject(codeError("bad_args", "setRelation 需要 convId 与 peerId"));
    }
    const p = patch && typeof patch === "object" ? patch : {};
    return dbGet("relations", [convId, peerId]).then((cur) => {
      const merged = Object.assign({}, cur || {}, p, { convId, peerId });
      if (typeof p.at !== "number") merged.at = now();
      const row = normalizeRelation(convId, peerId, merged);
      return dbPut("relations", row).then(() => row);
    });
  }

  /** 删掉一条关系（接受申请、恢复好友时用）；删到了 true，本来没有 false */
  function clearRelation(convId, peerId) {
    if (!convId || !peerId) return Promise.resolve(false);
    return dbGet("relations", [convId, peerId]).then((row) => {
      if (!row) return false;
      return dbDel("relations", [convId, peerId]).then(() => true);
    });
  }

  /** 冷却查询：remainingMs <= 0 表示可以重新申请 / 进群（removed 仍可能是 true，只是冷却到期） */
  function relationCooldown(convId, peerId) {
    return getRelation(convId, peerId).then((r) => {
      const removed = !!r && r.state === "removed";
      const until = r && typeof r.until === "number" ? r.until : 0;
      const remainingMs = removed ? Math.max(0, until - now()) : 0;
      return { removed, until, remainingMs };
    });
  }

  /**
   * 用户在这个会话还能不能说话：relations(convId, "user").state === "removed" → false。
   * 注意：冷却过期也仍然是 false —— 冷却只决定「能不能重新申请」，不决定「能不能直接说话」。
   */
  function canUserSpeak(convId) {
    if (!convId) return Promise.resolve(false);
    return getRelation(convId, USER_PEER).then((r) => !(r && r.state === "removed"));
  }

  /** 把用户从会话里删掉 / 踢出：state:"removed" + until = now + COOLDOWN_MS */
  function removeUserFromConversation(convId) {
    if (!convId) return Promise.reject(codeError("bad_args", "removeUserFromConversation 需要 convId"));
    const until = now() + COOLDOWN_MS;
    return setRelation(convId, USER_PEER, { state: "removed", until, byConvId: convId }).then(() => ({
      ok: true,
      until,
    }));
  }

  /** 恢复用户（接受好友申请 / 入群申请时调）：删掉那条 relation */
  function restoreUserInConversation(convId) {
    if (!convId) return Promise.reject(codeError("bad_args", "restoreUserInConversation 需要 convId"));
    return clearRelation(convId, USER_PEER).then(() => ({ ok: true }));
  }

  // ---- 会话之间：进群 / 拉人 / 踢人（§2.8 共享账本） ----
  // members 里一个 AI 只有一行（convId = 它的归属私聊），群侧**只挂引用** group_members，
  // 所以「进群」= 写一行引用、「踢出」= 删那行引用 —— **绝不复制/删除身份行**。

  /**
   * 把一个会话挂进群（§2.8）。只写一行 `group_members`，不复制成员、不改任何身份字段。
   * @param {{groupId:string, convId:string, sort?:number}} opts
   * @returns {Promise<{ok:true, member:object}>} member = 那条身份行（形状同 listMembers），sort 是群侧顺序
   */
  function joinConversationToGroup(opts) {
    const groupId = opts && opts.groupId;
    const convId = opts && opts.convId;
    const wantSort = opts && typeof opts.sort === "number" ? opts.sort : null;
    if (!groupId) return Promise.reject(codeError("bad_args", "joinConversationToGroup 需要 groupId"));
    if (!convId) return Promise.reject(codeError("bad_args", "joinConversationToGroup 需要 convId"));
    if (groupId === convId) {
      return Promise.reject(codeError("already_in_group", "自己所在的会话不能进自己：" + groupId));
    }
    let nextSort = 0;
    return getConversation(groupId)
      .then((group) => {
        if (!group || group.kind !== "group") {
          throw codeError("not_a_group", "目标不是群聊：" + groupId);
        }
        return getConversation(convId);
      })
      .then((conv) => {
        // 只有私聊会话能进群：群聊不能再被挂进另一个群（身份行只属于一条私聊）
        if (!conv) throw codeError("not_direct", "会话不存在：" + convId);
        if (conv.kind === "group") throw codeError("not_direct", "只有私聊会话能进群：" + convId);
        return relationCooldown(groupId, convId);
      })
      .then((cd) => {
        if (cd.remainingMs > 0) {
          const err = codeError("cooldown", "还要等 " + Math.ceil(cd.remainingMs / 1000) + " 秒");
          err.remainingMs = cd.remainingMs;
          err.until = cd.until;
          throw err;
        }
        return dbGet("group_members", [groupId, convId]);
      })
      .then((ref) => {
        if (ref) throw codeError("already_in_group", "这个会话已经在群里了：" + convId);
        return dbByIndex("group_members", "by_group", groupId);
      })
      .then((refs) => {
        // sort 取「现有最大值 + 1」，不是人数：踢过人之后人数会小于最大 sort，
        // 用人数会跟留下的成员撞号（实测重新进群后两个成员都是 sort 2）。
        const maxSort = (refs || []).reduce(
          (n, r) => (typeof r.sort === "number" && r.sort > n ? r.sort : n),
          -1
        );
        nextSort = wantSort != null ? wantSort : maxSort + 1;
        return listMembers(convId);
      })
      .then((src) => {
        if (!src.length) throw codeError("not_direct", "这个会话还没有成员行：" + convId);
        const me = src[0];
        return tx(["group_members", "relations"], "readwrite").then((t) => {
          t.objectStore("group_members").put({ groupId, memberConvId: convId, sort: nextSort });
          // 进群成功 → 这对关系的冷却作废
          t.objectStore("relations").delete([groupId, convId]);
          return txDone(t).then(() => ({
            ok: true,
            member: Object.assign({}, me, { sort: nextSort }),
          }));
        });
      });
  }

  /** 拉人进群（同一路径：都是「把已有私聊会话挂进群」） */
  function inviteConversationToGroup(opts) {
    return joinConversationToGroup(opts);
  }

  /**
   * 把一个会话从群里踢出（§2.8）：**只删 group_members 那一行** + 写 3 分钟冷却。
   * 身份行与私聊原样保留（被踢的 AI 回私聊照样能说话）。
   * 幂等：本来就不在群里 → removed:false，冷却照写。
   * @returns {Promise<{ok:true, removed:boolean, until:number}>}
   */
  function kickConversationFromGroup(opts) {
    const groupId = opts && opts.groupId;
    const convId = opts && opts.convId;
    const byConvId = opts && typeof opts.byConvId === "string" ? opts.byConvId : "";
    if (!groupId) return Promise.reject(codeError("bad_args", "kickConversationFromGroup 需要 groupId"));
    if (!convId) return Promise.reject(codeError("bad_args", "kickConversationFromGroup 需要 convId"));
    const until = now() + COOLDOWN_MS;
    return dbGet("group_members", [groupId, convId]).then((ref) =>
      tx(["group_members", "relations"], "readwrite").then((t) => {
        if (ref) t.objectStore("group_members").delete([groupId, convId]);
        t.objectStore("relations").put(
          normalizeRelation(groupId, convId, { state: "removed", until, at: now(), byConvId })
        );
        return txDone(t).then(() => ({ ok: true, removed: !!ref, until }));
      })
    );
  }

  /**
   * 群侧删除成员的**唯一入口**（§2.8.2）：按成员行 id 删引用。
   * 先查出这条成员行的归属私聊（convId），再删 [groupId, convId] 那一行；
   * **不删身份行**（删身份行只允许在私聊里 deleteMember）。
   * @returns {Promise<{ok:true, removed:boolean}>}
   */
  function removeGroupMember(groupId, memberId) {
    if (!groupId) return Promise.reject(codeError("bad_args", "removeGroupMember 需要 groupId"));
    if (!memberId) return Promise.reject(codeError("bad_args", "removeGroupMember 需要 memberId"));
    return dbGet("members", memberId).then((row) => {
      if (!row || !row.convId) return { ok: true, removed: false };
      // 与 kickConversationFromGroup 同一条路径：UI 里「从群里移除」也要写 3 分钟冷却，
      // 否则点两下就能把人加回来，冷却形同虚设（用户 m09102 要求踢人给 cd）。
      return kickConversationFromGroup({ groupId, convId: row.convId });
    });
  }

  /**
   * 把某个群的成员顺序规整成 0..n-1（按现有 sort 稳定排序，同 sort 按引用写入顺序）。
   * 修「重复 sort / 空洞 sort」这类脏数据：老库迁移、以及早期用人数算 sort 的历史数据都可能带进来。
   * 幂等：已经规整过就一行都不写。
   * @returns {Promise<number>} 改写了几条引用
   */
  function normalizeGroupMemberSort(groupId) {
    if (!groupId) return Promise.resolve(0);
    return dbByIndex("group_members", "by_group", groupId).then((refs) => {
      const list = (refs || []).slice();
      if (list.length < 2) return 0;
      const ordered = list
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          const sa = typeof a.r.sort === "number" ? a.r.sort : a.i;
          const sb = typeof b.r.sort === "number" ? b.r.sort : b.i;
          return sa - sb || a.i - b.i;
        })
        .map((x) => x.r);
      const dirty = ordered.filter((r, i) => r.sort !== i);
      if (!dirty.length) return 0;
      return tx("group_members", "readwrite").then((t) => {
        const os = t.objectStore("group_members");
        ordered.forEach((r, i) => {
          if (r.sort !== i) os.put(Object.assign({}, r, { sort: i }));
        });
        return txDone(t).then(() => dirty.length);
      });
    });
  }

  /** 上下文相关设置（§2.6）：缺省 100000 / true */
  function getContextSettings() {
    return getSettings().then((s) => ({
      contextBudget: normalizeBudget(s.contextBudget),
      contextCompress: s.contextCompress !== false,
    }));
  }

  /** 打开库并完成旧数据回填（kind）+ 备忘单条化迁移 + 群成员迁移；shell 启动时调用一次 */
  function ready() {
    return open()
      .then(() => backfillKinds())
      .then(() => migrateMemosToSingle())
      .then(() => migrateGroupMembers())
      .then(() => migrateLegacyBudget())
      // 迁移完顺手把每个群的成员顺序规整一遍（规整过就一行不写，幂等）：
      // 老库的 sort 可能重复，早期「按人数算 sort」的历史数据也带进来过重复。
      .then(() => dbAll("conversations"))
      .then((list) =>
        (list || [])
          .filter((c) => c && c.kind === "group")
          .reduce((p, c) => p.then(() => normalizeGroupMemberSort(c.id)), Promise.resolve(0))
      )
      .then(() => getSettings())
      .then((s) => ({ settings: s }));
  }

  return {
    ready,
    // 会话
    listConversations,
    getConversation,
    putConversation,
    createConversation,
    updateConversation,
    touchConversation,
    setPinned,
    deleteConversation,
    backfillKinds,
    // 成员
    listMembers,
    putMember,
    updateMember,
    addMember,
    deleteMember,
    // 消息
    listMessages,
    addMessage,
    updateMessage,
    deleteMessages,
    clearMessages,
    deleteMessagesByConv,
    // 设置
    getSettings,
    setSettings,
    // 压缩块（blocks 表，§2.6）
    listBlocks,
    putBlock,
    deleteBlocks,
    listUnfoldedMessages,
    markFolded,
    // 上下文（§2.6）
    getContextSettings,
    // 备忘（memos 表）—— 用户口径：只有一条、无上限、整段覆盖
    getMemo,
    setMemo,
    clearMemo,
    migrateMemosToSingle,
    // 关系（relations 表，§2.7）—— 冷却 / 删用户 / 软删除
    getRelation,
    setRelation,
    clearRelation,
    relationCooldown,
    canUserSpeak,
    removeUserFromConversation,
    restoreUserInConversation,
    joinConversationToGroup,
    inviteConversationToGroup,
    kickConversationFromGroup,
    // 群成员 = 会话引用（group_members 表，§2.8）：群侧删成员的唯一入口 + 迁移 + 顺序规整
    removeGroupMember,
    migrateGroupMembers,
    normalizeGroupMemberSort,
    softDeleteConversation,
    restoreConversation,
    listActiveConversations,
    // 壁纸/颜色解析（唯一权威，别处 import 这些函数）
    resolveWallpaper: (conv, user) => resolveWallpaper(conv, user),
    resolveAccent: (conv, user) => resolveAccent(conv, user),
    resolveMemberAccent: (member, user) => resolveMemberAccent(member, user),
    // 诊断/生命周期（升级库、测试前先 close）
    close,
    get blocked() {
      return lastBlocked;
    },
    // 暴露给卡片用的小工具（与旧实现同语义）
    normalizeMember,
    uid,
    now,
  };
}

export default createStore;
