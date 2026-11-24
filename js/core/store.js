// js/core/store.js — 数据层（IndexedDB）
// 逻辑原样搬自旧 js/app.js 的 DB + Store；不 import 旧文件。
// 库名 meruchat，表：conversations / members / messages / kv / memos
// 数据口径唯一来源：docs/DEV.md §2.3（User / Conversation 两套形状 + 两个 resolve 函数）
"use strict";

import { uid, now, hashStr } from "./util.js";
// 旧数据里 accent 停在「白 / 近白」上的要迁移掉：isWhiteish 的唯一实现在 theme.js。
// 循环依赖是安全的：theme.js 只在函数体内读本模块的绑定，不读模块初始化瞬间的值。
import { isWhiteish } from "./theme.js";

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

/** 上下文预算默认值（§2.6）：8000 token；0 = 关闭压缩，全量直喂 */
export const DEFAULT_CONTEXT_BUDGET = 8000;

/** 默认用户（= 原来的全局设置；模型/接口这几项也在同一对象里） */
export const DEFAULT_SETTINGS = {
  name: "内测用户01",
  avatar: { label: "内", color: "#f5a623" },
  accent: DEFAULT_ACCENT,
  defaultWallpaper: "aurora",
  baseUrl: "/gw/v1",
  model: "group/meru",
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
    // 上下文预算（§2.6）：非数字 → 默认；负数归 0（0 = 不限，全量直喂）
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

/** 上下文预算归一：非数字 → 默认 8000；负数 → 0（0 表示不限） */
function normalizeBudget(v) {
  if (typeof v !== "number" || !isFinite(v)) return DEFAULT_CONTEXT_BUDGET;
  if (v < 0) return 0;
  return Math.round(v);
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
const DB_VERSION = 3;
const KV_KEY = "app";

/** 单条 memo 在 memos 表里的固定 key（老的多键记录在 open 时并进这条，见 migrateMemosToSingle） */
const MEMO_SINGLE_KEY = "";
/** 不属于任何会话的备忘（工具层只写全局桶） */
const GLOBAL_SCOPE = "";

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
    let mems = (members || []).map((m, i) => normalizeMember(conv.id, m, i));
    if (!mems.length) {
      mems = [normalizeMember(conv.id, { name: "助手", persona: DEFAULT_PERSONA }, 0)];
    }
    return tx(["conversations", "members"], "readwrite").then((t2) => {
      t2.objectStore("conversations").put(conv);
      mems.forEach((m) => t2.objectStore("members").put(m));
      return txDone(t2).then(() => ({ conversation: conv, members: mems }));
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

  /** 级联删除：会话 + 它的成员 + 它的消息 + 它的备忘 + 它的压缩块；若删掉的是置顶，把最近更新的一条置顶 */
  function deleteConversation(id) {
    return Promise.all([
      dbByIndex("members", "convId", id),
      dbByIndex("messages", "convId", id),
      dbByIndex("memos", "conversationId", id),
      dbByIndex("blocks", "by_conv", id),
    ]).then(([mems, msgs, memoRows, blockRows]) =>
        tx(["conversations", "members", "messages", "memos", "blocks"], "readwrite").then((t) => {
          mems.forEach((m) => t.objectStore("members").delete(m.id));
          msgs.forEach((m) => t.objectStore("messages").delete(m.id));
          memoRows.forEach((m) => t.objectStore("memos").delete([m.conversationId, m.key]));
          blockRows.forEach((b) => t.objectStore("blocks").delete(b.id));
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
  function listMembers(convId) {
    return dbByIndex("members", "convId", convId).then((list) => {
      list.sort((a, b) => (a.sort || 0) - (b.sort || 0));
      return list;
    });
  }

  function putMember(m) {
    // 没 convId 的成员没有归属，落库也没意义
    if (!m || !m.convId) return Promise.reject(new Error("putMember: 缺少 convId"));
    const next = m.id ? m : normalizeMember(m.convId, m, m.sort);
    return dbPut("members", next);
  }

  function addMember(convId, data) {
    return listMembers(convId).then((list) => {
      const m = normalizeMember(convId, data, list.length);
      return dbPut("members", m).then(() => m);
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
      return dbPut("members", a);
    }
    if (!a) return Promise.reject(new Error("updateMember: 缺少 id"));
    return dbGet("members", a).then((cur) => {
      if (!cur) return null;
      return dbPut("members", Object.assign({}, cur, b || {}, { id: cur.id, convId: cur.convId }));
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

  /** 上下文相关设置（§2.6）：缺省 8000 / true */
  function getContextSettings() {
    return getSettings().then((s) => ({
      contextBudget: normalizeBudget(s.contextBudget),
      contextCompress: s.contextCompress !== false,
    }));
  }

  /** 打开库并完成旧数据回填（kind）+ 备忘单条化迁移；shell 启动时调用一次 */
  function ready() {
    return open()
      .then(() => backfillKinds())
      .then(() => migrateMemosToSingle())
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
