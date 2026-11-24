// js/core/tools/profile.js — 三个「改你自己」的工具：set_name / set_persona / set_look
// 口径（DEV.md §2.6、用户 2026-11-25 定）：改的是**这一轮正在发言的成员**，
// 既不是用户（settings 里的自己），也不是群里别的成员。
// 三个工具都依赖 getResponder() 拿当前发言人（id / convId / name / persona / avatar）；
// 改完统一走 onChanged 通知 UI 立即刷新 —— 但工具本身不依赖 onChanged 存在。
"use strict";

const NAME_MIN = 1;
const NAME_MAX = 24;
const AVATAR_LABEL_MAX = 2;
const AVATAR_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const WALLPAPERS = ["aurora", "forest", "dusk"];

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** 缺方法就说清楚，不做「假装改上了」的降级 */
function need(store, name) {
  if (!store || typeof store[name] !== "function") {
    throw codeError("store_method_missing", "数据层缺少 " + name + "()：profile 工具没法改成员（见 DEV.md §2.6）");
  }
}

/** 取当前发言人；拿不到就明确报错（不猜、不乱改别人的成员） */
function responderOf(getResponder) {
  let r = null;
  try {
    r = typeof getResponder === "function" ? getResponder() : null;
  } catch (e) {
    r = null;
  }
  if (!r || !r.id) {
    throw codeError("no_responder", "现在没有正在发言的成员：这些工具只能改「你自己」，拿不到当前成员就不改");
  }
  return r;
}

/** 改完通知 UI；UI 挂了也不许把工具搞失败 */
function notify(onChanged, payload) {
  try {
    if (typeof onChanged === "function") onChanged(payload);
  } catch (e) {
    /* 忽略 */
  }
}

/** 名字首字（与 store.js 的 avatarForName 同口径：Array.from 取 [#0]） */
function firstChar(name) {
  const arr = Array.from(String(name == null ? "" : name).trim());
  return arr.length ? arr[0] : "?";
}

/** 数「字」：按字符（码点）数，不按 UTF-16 长度 */
function charLength(text) {
  return Array.from(String(text == null ? "" : text)).length;
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }
}

/**
 * 取会话对象：私聊的顶栏读 conv.title / conv.avatar，改自己名字、改头像都要一并写会话。
 * 用 store.getConversation；读不到（没有该方法 / 抛错 / 没有这个会话）返回 null，
 * 调用方据此回落成「按私聊处理」。
 */
async function loadConversation(store, id) {
  if (!id) return null;
  if (store && typeof store.getConversation === "function") {
    try {
      const c = await store.getConversation(id);
      if (c) return c;
    } catch (e) {
      /* 读不到就回落 */
    }
  }
  return null;
}

/**
 * 判定会话类型：'direct' / 'group' / null（读不到会话 → null）。
 * 老数据没有 kind 字段 → 当私聊（历史数据里只有单人群）。
 */
function kindOf(conv) {
  if (!conv || !conv.id) return null;
  return conv.kind === "group" ? "group" : "direct";
}

/** 私聊顶栏读 conv.title / conv.avatar（chat-direct.js:253），群聊读群名，所以只有 kind=direct 才镜像会话。
 *  读不到会话时按私聊处理：老数据没有 kind 字段，改名字仍要让顶栏跟着变。 */
function isDirect(conv) {
  return kindOf(conv) !== "group";
}

// ================================================================ set_name
export function createSetNameTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "set_name",
    description:
      "修改**你自己**（这一轮发言的成员）的显示名称，不是用户、也不是群里别的成员。" +
      "名称 1–24 字；头像里的首字会跟着变成新名字的第一个字。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "你的新显示名称，1–24 字" },
      },
      required: ["name"],
    },
    async execute(id, args, signal) {
      checkAbort(signal);
      const me = responderOf(getResponder);
      const raw = args && typeof args.name === "string" ? args.name.trim() : "";
      const len = charLength(raw);
      if (!raw) throw codeError("bad_args", "set_name 需要 name（1–24 字）");
      if (len < NAME_MIN || len > NAME_MAX) {
        throw codeError("bad_args", "name 要 " + NAME_MIN + "–" + NAME_MAX + " 字（当前 " + len + " 字）");
      }

      need(store, "updateMember");
      const previousName = String(me.name == null ? "" : me.name);
      const avatar = Object.assign({}, me.avatar || {}, { label: firstChar(raw) });
      const conv = await loadConversation(store, convId || me.convId);
      const direct = isDirect(conv);
      // 私聊顶栏读 conv.title，群聊顶栏读群名（不能因为改自己名字把群名改掉）
      if (direct) {
        need(store, "updateConversation");
        await store.updateConversation((conv && conv.id) || convId || me.convId, { title: raw });
      }
      await store.updateMember(me.id, { name: raw, avatar });
      notify(onChanged, { memberId: me.id, kind: "name" });

      return {
        content: [
          {
            type: "text",
            text: direct ? "已把你的显示名称改成「" + raw + "」" : "已把你在本群的名字改成「" + raw + "」（群名不变）",
          },
        ],
        details: { name: raw, previousName },
      };
    },
  };
}

// ================================================================ set_persona
export function createSetPersonaTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "set_persona",
    description:
      "修改**你自己**（这一轮发言的成员）的设定/人格，不是用户、也不是群里别的成员。" +
      "**这是整段替换**：新的 persona 会覆盖旧的，不是追加；要保留旧内容请自己拼进新文本。" +
      "下次发言就会按新的设定来，传空字符串 = 清空设定。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        persona: { type: "string", description: "你的新设定/人格全文（整段替换旧设定，不是追加）；空字符串 = 清空" },
      },
      required: ["persona"],
    },
    async execute(id, args, signal) {
      checkAbort(signal);
      const me = responderOf(getResponder);
      if (!args || typeof args.persona !== "string") {
        throw codeError("bad_args", "set_persona 需要 persona（字符串，可传空字符串表示清空）");
      }
      const persona = args.persona;

      need(store, "updateMember");
      const previousLength = String(me.persona == null ? "" : me.persona).length;
      await store.updateMember(me.id, { persona });
      notify(onChanged, { memberId: me.id, kind: "persona" });

      const length = persona.length;
      const head = persona
        ? "已更新设定/人格（" + length + " 字，原来的 " + previousLength + " 字被替换）"
        : "已清空设定/人格";
      return {
        content: [{ type: "text", text: head }],
        details: { length, previousLength, cleared: !persona },
      };
    },
  };
}

// ================================================================ set_look
export function createSetLookTool({ store, convId, getResponder, onChanged } = {}) {
  return {
    name: "set_look",
    description:
      "修改**你自己**（这一轮发言的成员）的外形：头像颜色、头像首字，以及这个会话的聊天背景（壁纸）。" +
      "不是用户、也不是群里别的成员。三个参数至少给一个；没给的项保持原样。" +
      "头像颜色用 #rrggbb；壁纸传 default 表示跟随全局默认。",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        avatarColor: { type: "string", description: "你的头像颜色，#rrggbb，例如 #7c5cff" },
        avatarLabel: { type: "string", description: "你头像里的字，1–2 字（留空 = 自动用名字首字）" },
        wallpaper: {
          type: "string",
          enum: ["aurora", "forest", "dusk", "default"],
          description: "这个会话的聊天背景：极光 aurora / 深绿 forest / 暮紫 dusk / default = 跟随全局默认",
        },
      },
      required: [],
    },
    async execute(id, args, signal) {
      checkAbort(signal);
      const me = responderOf(getResponder);
      const a = args || {};

      const hasColor = a.avatarColor != null && a.avatarColor !== "";
      const hasLabel = a.avatarLabel != null && a.avatarLabel !== "";
      const hasWall = a.wallpaper != null && a.wallpaper !== "";
      if (!hasColor && !hasLabel && !hasWall) {
        throw codeError("bad_args", "set_look 至少给一个：avatarColor / avatarLabel / wallpaper");
      }

      const patch = {};
      const done = [];
      let color = null;
      let label = null;
      let wallpaper = null;

      if (hasColor) {
        const c = String(a.avatarColor).trim();
        if (!AVATAR_COLOR_RE.test(c)) {
          throw codeError("bad_args", "avatarColor 要 #rrggbb（六位十六进制），收到「" + c + "」");
        }
        color = c;
        patch.avatar = Object.assign({}, me.avatar || {}, { color: c });
        done.push("头像颜色改成 " + c);
      }
      if (hasLabel) {
        const l = Array.from(String(a.avatarLabel).trim()).slice(0, AVATAR_LABEL_MAX).join("");
        if (!l) throw codeError("bad_args", "avatarLabel 不能是空白");
        label = l;
        patch.avatar = Object.assign({}, patch.avatar || me.avatar || {}, { label: l });
        done.push("头像首字改成「" + l + "」");
      }
      if (patch.avatar) {
        need(store, "updateMember");
        // 私聊顶栏头像读的是 conv.avatar（chat-direct.js:251-252）：不同步过去，改了等于没改；群聊不碰 conv.avatar
        const conv = await loadConversation(store, convId || me.convId);
        if (isDirect(conv)) {
          need(store, "updateConversation");
          const target = (conv && conv.id) || convId || me.convId;
          if (target) {
            const next = Object.assign({}, (conv && conv.avatar) || {});
            if (color) next.color = color;
            if (label) next.label = label;
            await store.updateConversation(target, { avatar: next });
          }
        }
        await store.updateMember(me.id, { avatar: patch.avatar });
        notify(onChanged, { memberId: me.id, kind: "look" });
      }

      if (hasWall) {
        const w = String(a.wallpaper).trim();
        if (WALLPAPERS.indexOf(w) < 0 && w !== "default") {
          throw codeError("bad_args", "wallpaper 只能是 aurora / forest / dusk / default，收到「" + w + "」");
        }
        need(store, "updateConversation");
        const target = convId || me.convId;
        if (!target) throw codeError("bad_args", "set_look 改壁纸需要 convId（当前拿不到会话）");
        wallpaper = w === "default" ? null : w;
        await store.updateConversation(target, { wallpaper });
        notify(onChanged, { memberId: me.id, kind: "wallpaper" });
        done.push(w === "default" ? "聊天背景恢复成跟随全局默认" : "聊天背景改成 " + w);
      }

      return {
        content: [{ type: "text", text: "已更新：" + done.join("；") }],
        details: { avatarColor: color, avatarLabel: label, wallpaper },
      };
    },
  };
}

export default createSetNameTool;
