// app.js — MeruChat webapp（静态网页 / WebView 套壳版）
// 无后端：数据全部存本机 IndexedDB；对话直接调 OpenAI 兼容网关（流式）。
// 视觉照搬 su/preview/styles.html；DOM 契约见 webapp/index.html，样式见 webapp/theme.css。
"use strict";

(function () {
  // ================================================================== helpers
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function now() { return Date.now(); }

  // 头像确定性渐变（同一 id 恒定）
  var AV_GRAD = [
    "linear-gradient(135deg,#f5a623,#f76b1c)",
    "linear-gradient(135deg,#5ac8fa,#007aff)",
    "linear-gradient(135deg,#35c759,#10a37f)",
    "linear-gradient(135deg,#a06bff,#6a4cff)",
    "linear-gradient(135deg,#ff6b9d,#d97757)",
    "linear-gradient(135deg,#00b8a9,#00a884)"
  ];
  function hashStr(s) {
    var h = 0; s = String(s || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function avGrad(id) { return AV_GRAD[hashStr(id) % AV_GRAD.length]; }
  function initialOf(name) { return name ? String(name).trim().slice(0, 1) : "?"; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ================================================================== IndexedDB
  // 单库 meruchat，stores: conversations / members / messages / kv
  var DB = {
    name: "meruchat",
    version: 1,
    _db: null,
    open: function () {
      var self = this;
      if (self._db) return Promise.resolve(self._db);
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(self.name, self.version);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains("conversations")) {
            var cs = db.createObjectStore("conversations", { keyPath: "id" });
            cs.createIndex("updatedAt", "updatedAt");
          }
          if (!db.objectStoreNames.contains("members")) {
            var ms = db.createObjectStore("members", { keyPath: "id" });
            ms.createIndex("convId", "convId");
          }
          if (!db.objectStoreNames.contains("messages")) {
            var gs = db.createObjectStore("messages", { keyPath: "id" });
            gs.createIndex("convId", "convId");
            gs.createIndex("ts", "ts");
          }
          if (!db.objectStoreNames.contains("kv")) {
            db.createObjectStore("kv", { keyPath: "k" });
          }
        };
        req.onsuccess = function (e) { self._db = e.target.result; resolve(self._db); };
        req.onerror = function (e) { reject(e.target.error); };
      });
    },
    _tx: function (stores, mode) {
      return DB.open().then(function (db) { return db.transaction(stores, mode); });
    },
    _req: function (r) {
      return new Promise(function (resolve, reject) {
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    },
    _txDone: function (tx) {
      return new Promise(function (resolve, reject) {
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    },
    // ---- generic CRUD ----
    get: function (store, key) {
      return DB._tx(store, "readonly").then(function (tx) {
        return DB._req(tx.objectStore(store).get(key));
      });
    },
    put: function (store, value) {
      return DB._tx(store, "readwrite").then(function (tx) {
        tx.objectStore(store).put(value);
        return DB._txDone(tx).then(function () { return value; });
      });
    },
    del: function (store, key) {
      return DB._tx(store, "readwrite").then(function (tx) {
        tx.objectStore(store).delete(key);
        return DB._txDone(tx);
      });
    },
    all: function (store) {
      return DB._tx(store, "readonly").then(function (tx) {
        return DB._req(tx.objectStore(store).getAll());
      });
    },
    byIndex: function (store, index, value) {
      return DB._tx(store, "readonly").then(function (tx) {
        return DB._req(tx.objectStore(store).index(index).getAll(value));
      });
    },
    kvGet: function (k, dflt) {
      return DB.get("kv", k).then(function (row) {
        return row ? row.v : dflt;
      });
    },
    kvSet: function (k, v) {
      return DB.put("kv", { k: k, v: v });
    }
  };

  // ================================================================== data layer
  // settings 单条 kv:key='app'
  var DEFAULT_SETTINGS = {
    accent: "#0075de",
    skin: "notion",
    wallpaper: "gradient",
    dim: 0,
    baseUrl: "https://gw.ms7.pw/cors/v1",
    model: "opencode-go/deepseek-v4.1-flash",
    apiKey: ""
  };

  var Store = {
    getSettings: function () {
      return DB.kvGet("app", null).then(function (s) {
        return Object.assign({}, DEFAULT_SETTINGS, s || {});
      });
    },
    saveSettings: function (patch) {
      // 合并进内存态（唯一真源），再整体落库，避免并发读-改-写互相覆盖。
      var next = Object.assign({}, state.settings, patch);
      state.settings = next;
      return DB.kvSet("app", next).then(function () { return next; });
    },
    listConversations: function () {
      return DB.all("conversations").then(function (list) {
        list.sort(function (a, b) {
          if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });
        return list;
      });
    },
    // 旧数据兜底：没有 kind 的会话按成员数推断一次并写回（1 → direct，≥2 → group）
    backfillKinds: function () {
      return DB.all("conversations").then(function (list) {
        var missing = list.filter(function (c) { return c.kind !== "direct" && c.kind !== "group"; });
        if (!missing.length) return 0;
        return Promise.all(missing.map(function (c) {
          return Store.listMembers(c.id).then(function (mems) {
            c.kind = mems.length >= 2 ? "group" : "direct";
            return DB.put("conversations", c);
          });
        })).then(function () { return missing.length; });
      });
    },
    getConversation: function (id) { return DB.get("conversations", id); },
    createConversation: function (title, members, kind) {
      var t = now();
      var conv = {
        id: uid(), title: title || "新群聊", createdAt: t, updatedAt: t, pinned: false,
        // 会话形态：direct（私聊）/ group（群聊）。形态是会话本身的属性，
        // 不能由成员数推断——删到只剩 1 人也不该让群聊变成私聊。
        kind: kind === "group" ? "group" : "direct"
      };
      var mems = (members || []).map(function (m, i) {
        return normalizeMember(conv.id, m, i);
      });
      // 若没有任何成员，默认给一个可回复的助手成员。
      if (!mems.length) {
        mems = [normalizeMember(conv.id, {
          name: "助手",
          persona: "你是一位乐于帮忙的对话成员，回答简洁、用用户的语言。"
        }, 0)];
      }
      return DB._tx(["conversations", "members"], "readwrite").then(function (tx) {
        tx.objectStore("conversations").put(conv);
        mems.forEach(function (m) { tx.objectStore("members").put(m); });
        return DB._txDone(tx).then(function () { return { conversation: conv, members: mems }; });
      });
    },
    updateConversation: function (id, patch) {
      return DB.get("conversations", id).then(function (c) {
        if (!c) throw new Error("会话不存在");
        var next = Object.assign({}, c, patch, { updatedAt: patch.touch === false ? c.updatedAt : now() });
        delete next.touch;
        return DB.put("conversations", next);
      });
    },
    touchConversation: function (id) {
      return DB.get("conversations", id).then(function (c) {
        if (!c) return;
        c.updatedAt = now();
        return DB.put("conversations", c);
      });
    },
    setPinned: function (id, pinned) {
      // 单一置顶：先清全部，再置目标
      return DB.all("conversations").then(function (list) {
        return DB._tx("conversations", "readwrite").then(function (tx) {
          var os = tx.objectStore("conversations");
          list.forEach(function (c) {
            if (c.pinned) { c.pinned = false; os.put(c); }
          });
          var target = list.filter(function (c) { return c.id === id; })[0];
          if (target && pinned) {
            return DB._req(os.get(id)).then(function (cur) {
              cur.pinned = true;
              cur.updatedAt = now();
              os.put(cur);
              return DB._txDone(tx);
            });
          }
          return DB._txDone(tx);
        });
      });
    },
    deleteConversation: function (id) {
      return Promise.all([DB.byIndex("members", "convId", id), DB.byIndex("messages", "convId", id)])
        .then(function (res) {
          var mems = res[0], msgs = res[1];
          return DB._tx(["conversations", "members", "messages"], "readwrite").then(function (tx) {
            mems.forEach(function (m) { tx.objectStore("members").delete(m.id); });
            msgs.forEach(function (m) { tx.objectStore("messages").delete(m.id); });
            tx.objectStore("conversations").delete(id);
            return DB._txDone(tx);
          });
        }).then(function () {
          // 若删掉的是置顶，把最近更新的一条置顶
          return DB.all("conversations").then(function (list) {
            if (list.length && !list.some(function (c) { return c.pinned; })) {
              var sorted = list.slice().sort(function (a, b) {
                return (b.updatedAt || 0) - (a.updatedAt || 0);
              });
              return Store.setPinned(sorted[0].id, true);
            }
          });
        });
    },
    listMembers: function (convId) {
      return DB.byIndex("members", "convId", convId).then(function (list) {
        list.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
        return list;
      });
    },
    addMember: function (convId, data) {
      return Store.listMembers(convId).then(function (list) {
        var m = normalizeMember(convId, data, list.length);
        return DB.put("members", m).then(function () { return m; });
      });
    },
    updateMember: function (member) { return DB.put("members", member); },
    deleteMember: function (id) { return DB.del("members", id); },
    listMessages: function (convId) {
      return DB.byIndex("messages", "convId", convId).then(function (list) {
        list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
        return list;
      });
    },
    addMessage: function (msg) {
      return DB.put("messages", msg);
    },
    deleteMessages: function (ids) {
      if (!ids || !ids.length) return Promise.resolve();
      return DB._tx("messages", "readwrite").then(function (tx) {
        var os = tx.objectStore("messages");
        ids.forEach(function (id) { os.delete(id); });
        return DB._txDone(tx);
      });
    },
    updateMessage: function (id, patch) {
      return DB.get("messages", id).then(function (m) {
        if (!m) return;
        return DB.put("messages", Object.assign(m, patch));
      });
    }
  };

  function normalizeMember(convId, data, sort) {
    data = data || {};
    return {
      id: data.id || uid(),
      convId: convId,
      name: (data.name || "成员").trim() || "成员",
      avatar: data.avatar || "",
      persona: data.persona || "",
      model: data.model || "",
      sort: typeof data.sort === "number" ? data.sort : (sort || 0)
    };
  }

  // ================================================================== app state
  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    conversations: [],
    activeId: null,
    members: [],     // 当前会话成员
    messages: [],    // 当前会话消息
    streaming: false,
    cancelStream: null
  };

  // ================================================================== DOM refs
  var convList = $("convList");
  var chatBody = $("chatBody");
  var wallpaperEl = $("wallpaper");
  var dimEl = $("dim");
  var headAva = $("headAva");
  var headName = $("headName");
  var headSub = $("headSub");
  var chatMenuBtn = $("chatMenuBtn");
  var composer = $("composer");
  var sendBtn = $("sendBtn");
  var bigAva = $("bigAva");
  var nameText = $("nameText");
  var personaInput = $("personaInput");
  var accentSel = $("accentSel");
  var wallSel = $("wallSel");
  var dimRange = $("dimRange");
  var dimVal = $("dimVal");
  var baseUrlInput = $("baseUrlInput");
  var modelInput = $("modelInput");
  var apiKeyInput = $("apiKeyInput");
  var gearBtn = $("gearBtn");
  var fabBtn = $("fabBtn");
  var fabNewGroup = $("fabNewGroup");
  var fabTimer = null, fabLongPressed = false;
  var srBack = $("srBack");
  var chatBack = $("chatBack");
  var drawerMask = $("drawerMask");
  var appEl = $("app") || (document.querySelector ? document.querySelector(".app") : null);
  var sidebarRight = $("sidebarRight");
  var sidebarLeft = $("sidebarLeft");

  // members modal
  var membersModal = $("membersModal");
  var membersBody = $("membersBody");
  var membersTitle = $("membersTitle");
  var membersClose = $("membersClose");
  var addMemberBtn = $("addMemberBtn");

  // prompt modal
  var promptModal = $("promptModal");
  var promptTitle = $("promptTitle");
  var promptBody = $("promptBody");
  var promptOk = $("promptOk");
  var promptClose = $("promptClose");

  // menu sheet
  var menuModal = $("menuModal");
  var menuSheet = $("menuSheet");

  // ================================================================== settings: appearance
  var SKIN_ACCENT = {
    notion: "#0075de", wa: "#00a884", gpt: "#10a37f",
    claude: "#d97757", tg: "#517da2", imessage: "#0a84ff", night: "#7c5cff"
  };
  var WALLS = {
    gradient: "linear-gradient(135deg,#dfe9f3 0%,#f4e6f0 50%,#e5f3ea 100%)",
    midnight: "linear-gradient(160deg,#0f2027,#203a43,#2c5364)",
    none: "none"
  };

  function applySkin(skin) {
    body.setAttribute("data-skin", skin || "notion");
  }
  function applyAccent(hex) {
    hex = hex || SKIN_ACCENT[state.settings.skin] || "#0075de";
    var s = body.style;
    s.setProperty("--accent", hex);
    s.setProperty("--send-bg", hex);
    s.setProperty("--tick", hex);
    if (accentSel) {
      accentSel.querySelectorAll(".sw").forEach(function (b) {
        b.classList.toggle("active",
          String(b.getAttribute("data-accent")).toLowerCase() === String(hex).toLowerCase());
      });
    }
  }
  function applyWallpaper(name) {
    var img = WALLS[name] || WALLS.gradient;
    if (wallpaperEl) wallpaperEl.style.backgroundImage = img;
    if (wallSel) wallSel.value = WALLS[name] ? name : "gradient";
  }
  function applyDim(pct) {
    // 滑块 0..0.8 直接作为 #dim 的 opacity；标签按 0..100% 显示。
    pct = Math.max(0, Math.min(0.8, Number(pct) || 0));
    if (dimEl) dimEl.style.opacity = String(pct);
    if (dimVal) dimVal.textContent = Math.round(pct / 0.8 * 100) + "%";
    if (dimRange) dimRange.value = String(pct);
  }

  function applyAllAppearance() {
    applySkin(state.settings.skin);
    applyAccent(state.settings.accent);
    applyWallpaper(state.settings.wallpaper);
    applyDim(state.settings.dim);
  }

  // ================================================================== render: conversations
  function avatarEl(cls, seed, name) {
    var a = el("div", cls, initialOf(name));
    a.style.background = avGrad(seed);
    return a;
  }

  function renderConvs() {
    convList.innerHTML = "";
    if (!state.conversations.length) {
      var empty = el("div", "empty-tip", "还没有会话，点右下角 ＋ 新建");
      convList.appendChild(empty);
      return;
    }
    state.conversations.forEach(function (c) {
      var row = el("div", "conv" + (c.id === state.activeId ? " active" : ""));
      row.setAttribute("data-id", c.id);

      row.appendChild(avatarEl("c-ava", c.id, c.title));

      var main = el("div", "c-main");
      var nameLine = el("div", "c-name");
      var nameSpan = el("span", null, c.title);
      nameLine.appendChild(nameSpan);
      if (c.pinned) {
        nameLine.appendChild(el("span", "c-pin", "📌"));
      }
      var preview = el("div", "c-preview", convPreview(c));
      main.appendChild(nameLine);
      main.appendChild(preview);
      row.appendChild(main);

      var more = el("button", "c-more", "⋮");
      more.type = "button";
      more.title = "更多";
      more.addEventListener("click", function (e) {
        e.stopPropagation();
        openConvMenu(c.id);
      });
      row.appendChild(more);

      row.addEventListener("click", function () { selectConversation(c.id); });
      row.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        openConvMenu(c.id);
      });
      convList.appendChild(row);
    });
  }

  function convPreview(c) {
    // 简化：显示成员数；若有缓存最后一条消息可显示摘要
    var m = state.lastPreview && state.lastPreview[c.id];
    if (m) return m;
    return c.pinned ? "置顶会话" : "点击打开";
  }

  // ================================================================== render: chat head
  function renderHead() {
    var c = activeConv();
    if (!c) {
      if (headName) headName.textContent = "MeruChat";
      if (headSub) headSub.textContent = "选择会话开始";
      if (headAva) { headAva.textContent = "?"; headAva.style.background = ""; }
      if (bigAva) { bigAva.textContent = "?"; bigAva.style.background = ""; }
      if (nameText) nameText.textContent = "MeruChat";
      refreshSRBack();
      return;
    }
    if (headName) headName.textContent = c.title;
    if (headSub) headSub.textContent = state.members.length + " 位成员";
    if (headAva) { headAva.textContent = initialOf(c.title); headAva.style.background = avGrad(c.id); }
    if (bigAva) { bigAva.textContent = initialOf(c.title); bigAva.style.background = avGrad(c.id); }
    if (nameText) nameText.textContent = c.title;
    refreshSRBack();

    // 人格输入框 = 第一个成员的 persona
    if (personaInput) {
      var first = state.members[0];
      personaInput.value = first ? (first.persona || "") : "";
      personaInput.disabled = !first;
    }
  }

  // ================================================================== render: messages
  function renderMessages() {
    chatBody.innerHTML = "";
    if (!state.activeId) {
      chatBody.appendChild(el("div", "empty-tip", "选择或新建一个会话开始对话"));
      return;
    }
    if (!state.messages.length) {
      chatBody.appendChild(el("div", "empty-tip", "还没有消息，发一条开始吧"));
      return;
    }
    var divider = el("div", "divider");
    divider.appendChild(el("span", null, "对话"));
    chatBody.appendChild(divider);
    state.messages.forEach(function (msg) {
      chatBody.appendChild(messageRow(msg));
    });
    scrollBottom();
  }

  function memberName(memberId) {
    var m = state.members.filter(function (x) { return x.id === memberId; })[0];
    return m ? m.name : "成员";
  }

  function messageRow(msg) {
    if (msg.role === "user") {
      var rowMe = el("div", "row me");
      var bMe = el("div", "bubble");
      bMe.appendChild(el("div", "m-text", msg.content));
      rowMe.appendChild(bMe);
      return rowMe;
    }
    // assistant / system 展示为对方（带头像）
    var row = el("div", "row them");
    var line = el("div", "mline");
    line.style.display = "flex";
    line.style.alignItems = "flex-end";

    var ava = avatarEl("m-ava", msg.memberId || msg.id, memberName(msg.memberId));
    line.appendChild(ava);

    var col = el("div", "m-col");
    col.appendChild(el("div", "m-name", msg.role === "system" ? "系统" : memberName(msg.memberId)));
    var bubble = el("div", "bubble");
    if (msg.memberId) bubble.setAttribute("data-mid", msg.memberId);
    bubble.appendChild(el("div", "m-text", msg.content));
    col.appendChild(bubble);

    line.appendChild(col);
    row.appendChild(line);
    return row;
  }

  function scrollBottom() { chatBody.scrollTop = chatBody.scrollHeight; }

  // 状态栏已从 UI 移除（lead 要求整行删掉）；内部仍全量直喂，不裁剪历史。
  function updateStatus() {}

  // 轻量提示：状态栏没了，改用临时浮出的 toast
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!msg) return;
    if (!toastEl) {
      toastEl = el("div", "toast");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  // ================================================================== selection / load
  function activeConv() {
    return state.conversations.filter(function (c) { return c.id === state.activeId; })[0] || null;
  }

  function loadConversations() {
    return Store.listConversations().then(function (list) {
      state.conversations = list;
      renderConvs();
    });
  }

  function selectConversation(id) {
    state.activeId = id;
    renderConvs();
    return Promise.all([Store.listMembers(id), Store.listMessages(id)]).then(function (res) {
      state.members = res[0];
      state.messages = res[1];
      renderHead();
      renderMessages();
      updateStatus();
    });
  }

  // ================================================================== send / streaming
  function setStreaming(on) {
    state.streaming = on;
    if (sendBtn) {
      sendBtn.disabled = false;
      if (on) { sendBtn.classList.add("stop"); sendBtn.textContent = "■"; }
      else { sendBtn.classList.remove("stop"); sendBtn.textContent = "➤"; }
    }
  }

  function send() {
    if (state.streaming) { // 点“停止”：中断
      if (state.cancelStream) state.cancelStream.abort();
      return;
    }
    var content = composer.value.trim();
    if (!content || !state.activeId) return;
    if (!state.settings.apiKey) {
      toast("请先在设置里填写 API Key");
      openSettingsDrawer();
      return;
    }
    var convId = state.activeId;
    composer.value = "";
    composer.style.height = "auto";

    // 1) 保存 user 消息
    var userMsg = { id: uid(), convId: convId, memberId: null, role: "user", content: content, ts: now() };
    Store.addMessage(userMsg).then(function () {
      state.messages.push(userMsg);
      renderMessages();
      updateStatus();
      return Store.touchConversation(convId);
    }).then(function () {
      return runGroupTurn(convId, content);
    }).catch(function (e) {
      toast("发送失败: " + (e && e.message ? e.message : e));
      setStreaming(false);
    });
  }

  // 群聊：每个成员按 sort 顺序各回复一次，各自 persona 作 system。
  function runGroupTurn(convId, userContent) {
    setStreaming(true);
    var members = state.members.slice();
    if (!members.length) {
      toast("该会话没有成员，无法回复");
      setStreaming(false);
      return Promise.resolve();
    }
    var controller = new AbortController();
    state.cancelStream = controller;

    var chain = Promise.resolve();
    members.forEach(function (member) {
      chain = chain.then(function () {
        if (controller.signal.aborted) return;
        return streamOneMember(convId, member, controller.signal);
      });
    });

    return chain.then(function () {
      return Store.touchConversation(convId);
    }).then(function () {
      return loadConversations();
    }).then(function () {
      renderConvs();
      updateStatus();
      setStreaming(false);
      state.cancelStream = null;
    }).catch(function (e) {
      if (e && e.name === "AbortError") {
        toast("已停止");
      } else {
        toast("回复出错: " + (e && e.message ? e.message : e));
      }
      setStreaming(false);
      state.cancelStream = null;
    });
  }

  // 用「截至当前」的会话历史 + 该成员 persona 调网关，流式渲染气泡，最后落库。
  function streamOneMember(convId, member, signal) {
    // 构造该成员视角的历史
    var transcript = buildTranscript(member);
    var placeholder = startStreamBubble(member);

    return callGateway(transcript, signal, function (deltaText) {
      placeholder.text += deltaText;
      placeholder.el.textContent = placeholder.text;
      scrollBottom();
    }).then(function (fullText) {
      placeholder.el.textContent = fullText;
      var bubbleWrap = placeholder.el.parentElement;
      if (bubbleWrap) bubbleWrap.classList.remove("streaming");
      var saved = {
        id: uid(), convId: convId, memberId: member.id,
        role: "assistant", content: fullText, ts: now()
      };
      return Store.addMessage(saved).then(function () {
        state.messages.push(saved);
      });
    }).catch(function (e) {
      var wrap = placeholder.el.parentElement;
      if (wrap) wrap.classList.remove("streaming");
      if (e && e.name === "AbortError") throw e;
      placeholder.el.textContent = (placeholder.text || "") + "\n[回复失败: " + (e && e.message ? e.message : e) + "]";
      // 失败也保留已产出的部分文本（若有）
      if (placeholder.text) {
        var saved = {
          id: uid(), convId: convId, memberId: member.id,
          role: "assistant", content: placeholder.text, ts: now()
        };
        return Store.addMessage(saved).then(function () { state.messages.push(saved); });
      }
    });
  }

  function startStreamBubble(member) {
    var row = el("div", "row them");
    var line = el("div", "mline");
    line.style.display = "flex";
    line.style.alignItems = "flex-end";
    var ava = avatarEl("m-ava", member.id, member.name);
    line.appendChild(ava);
    var col = el("div", "m-col");
    col.appendChild(el("div", "m-name", member.name));
    var bubble = el("div", "bubble streaming");
    bubble.setAttribute("data-mid", member.id);
    var t = el("div", "m-text", "");
    bubble.appendChild(t);
    col.appendChild(bubble);
    line.appendChild(col);
    row.appendChild(line);
    var hint = chatBody.querySelector(".empty-tip");
    if (hint) hint.remove();
    chatBody.appendChild(row);
    scrollBottom();
    return { el: t, text: "" };
  }

  // 组装发给网关的 messages（OpenAI 格式）
  function buildTranscript(responder) {
    var out = [];
    var sys = responder.persona ? String(responder.persona) : "";
    // 群成员名单附在 system，帮助模型理解场景
    var roster = state.members.map(function (m) { return m.name; }).join("、");
    var sysFull = sys;
    if (state.members.length > 1) {
      sysFull = (sys ? sys + "\n\n" : "") + "你在一个群聊里，成员包括：" + roster +
        "。你就是「" + responder.name + "」，请只代表你自己发言。";
    }
    if (sysFull) out.push({ role: "system", content: sysFull });

    state.messages.forEach(function (m) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.memberId === responder.id) {
          out.push({ role: "assistant", content: m.content });
        } else {
          // 其他成员的话折叠成 user，附名字前缀
          out.push({ role: "user", content: "[" + memberName(m.memberId) + "]: " + m.content });
        }
      }
    });
    return out;
  }

  // 直接调 OpenAI 兼容 /chat/completions（stream:true）
  function callGateway(messages, signal, onDelta) {
    var s = state.settings;
    var base = (s.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
    var url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
    var model = s.model || DEFAULT_SETTINGS.model;

    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + s.apiKey
      },
      body: JSON.stringify({ model: model, messages: messages, stream: true }),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + (t ? " " + t.slice(0, 200) : ""));
        });
      }
      if (!res.body || !res.body.getReader) {
        // 非流式回退：整体 JSON
        return res.json().then(function (j) {
          var txt = extractNonStream(j);
          if (txt) onDelta(txt);
          return txt;
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "";
      var acc = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return acc;
          buf += dec.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            var line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (!line || line.indexOf("data:") !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === "[DONE]") return acc;
            var obj;
            try { obj = JSON.parse(payload); } catch (e) { continue; }
            var piece = extractDelta(obj);
            if (piece) { acc += piece; onDelta(piece); }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function extractDelta(obj) {
    // OpenAI 流式：choices[0].delta.content
    try {
      var ch = obj.choices && obj.choices[0];
      if (!ch) return "";
      var d = ch.delta || ch.message || {};
      if (typeof d.content === "string") return d.content;
      if (Array.isArray(d.content)) {
        // 兼容 content 分片数组
        return d.content.map(function (p) { return p && p.text ? p.text : ""; }).join("");
      }
      return "";
    } catch (e) { return ""; }
  }

  function extractNonStream(j) {
    try {
      var ch = j.choices && j.choices[0];
      if (!ch) return "";
      if (ch.message && typeof ch.message.content === "string") return ch.message.content;
      if (typeof ch.text === "string") return ch.text;
      return "";
    } catch (e) { return ""; }
  }

  // ================================================================== modals: prompt
  var promptResolve = null;
  function openPrompt(opts) {
    return new Promise(function (resolve) {
      promptResolve = resolve;
      promptTitle.textContent = opts.title || "输入";
      promptBody.innerHTML = "";
      var field = el("div", "field");
      var lbl = el("label", "lbl", opts.label || "");
      var input;
      if (opts.multiline) {
        input = el("textarea");
        input.value = opts.value || "";
      } else {
        input = el("input");
        input.type = "text";
        input.value = opts.value || "";
      }
      input.id = "promptInput";
      field.appendChild(lbl);
      field.appendChild(input);
      promptBody.appendChild(field);
      promptOk.textContent = opts.okText || "确定";
      promptModal.hidden = false;
      setTimeout(function () { input.focus(); }, 0);
    });
  }
  function closePrompt(ok) {
    var val = null;
    if (ok) {
      var input = $("promptInput");
      val = input ? input.value : null;
    }
    promptModal.hidden = true;
    var wasConfirm = promptIsConfirm;
    promptIsConfirm = false;
    if (promptResolve) {
      var fn = promptResolve;
      promptResolve = null;
      fn(wasConfirm ? !!ok : val);
    }
  }

  // 纯确认（不输入文字）：复用同一个 prompt 弹层，确认返回 true、取消返回 false
  var promptIsConfirm = false;
  function confirmDialog(text, okText) {
    return new Promise(function (resolve) {
      promptResolve = resolve;
      promptIsConfirm = true;
      promptTitle.textContent = okText || "确认";
      promptBody.innerHTML = "";
      var p = el("div", "confirm-text", text);
      promptBody.appendChild(p);
      promptOk.textContent = okText || "确定";
      promptModal.hidden = false;
    });
  }

  // ================================================================== modals: members
  function openMembers() {
    if (!state.activeId) return;
    membersTitle.textContent = "群成员";
    renderMembersList();
    membersModal.hidden = false;
  }
  function renderMembersList() {
    membersBody.innerHTML = "";
    if (!state.members.length) {
      membersBody.appendChild(el("div", "empty-tip", "暂无成员，点下方添加"));
      return;
    }
    state.members.forEach(function (m) {
      var row = el("div", "member-row");
      row.appendChild(avatarEl("mava", m.id, m.name));
      var info = el("div", "minfo");
      info.appendChild(el("div", "mname", m.name));
      info.appendChild(el("div", "mpersona", m.persona || "（无设定）"));
      row.appendChild(info);
      var act = el("div", "mact");
      var edit = el("button", null, "✎");
      edit.type = "button"; edit.title = "编辑";
      edit.addEventListener("click", function () { editMember(m); });
      var del = el("button", null, "✕");
      del.type = "button"; del.title = "删除";
      del.addEventListener("click", function () { removeMember(m.id); });
      act.appendChild(edit);
      act.appendChild(del);
      row.appendChild(act);
      membersBody.appendChild(row);
    });
  }

  function addMemberFlow() {
    if (!state.activeId) return;
    openPrompt({ title: "添加成员", label: "成员名称", value: "", okText: "下一步" })
      .then(function (name) {
        if (name === null) return;
        name = (name || "").trim();
        if (!name) return;
        return openPrompt({ title: "成员设定（可选）", label: "persona / system 设定", multiline: true, value: "" })
          .then(function (persona) {
            if (persona === null) return;
            return Store.addMember(state.activeId, { name: name, persona: persona || "" })
              .then(function () { return reloadActive(); });
          });
      }).then(function () { renderMembersList(); });
  }

  function editMember(m) {
    openPrompt({ title: "编辑成员名称", label: "名称", value: m.name })
      .then(function (name) {
        if (name === null || !(name || "").trim()) return;
        return openPrompt({ title: "成员设定", label: "persona / system 设定", multiline: true, value: m.persona || "" })
          .then(function (persona) {
            if (persona === null) return;
            m.name = name.trim();
            m.persona = persona || "";
            return Store.updateMember(m).then(function () { return reloadActive(); });
          });
      }).then(function () { renderMembersList(); });
  }

  function removeMember(id) {
    if (!state.activeId) return;
    Store.deleteMember(id).then(function () { return reloadActive(); }).then(function () {
      renderMembersList();
    });
  }

  // ================================================================== conv menu (sheet)
  // 私聊 kind=direct：重命名 / 置顶 / 清空聊天记录 / 删除会话
  // 群聊 kind=group：群成员 / 修改群名 / 置顶 / 删除群聊
  // 形态只看 conv.kind，不看成员数（否则删成员会让菜单跳变）。
  function isGroup(conv) {
    if (conv && (conv.kind === "direct" || conv.kind === "group")) {
      return conv.kind === "group";
    }
    // 兜底：万一遇到未回填的旧记录，仍按成员数猜一次（不会写库）
    return state.members.length >= 2;
  }

  function openSheet(items) {
    menuSheet.innerHTML = "";
    items.forEach(function (it) {
      var b = el("button", it.danger ? "danger" : null, it.text);
      b.type = "button";
      b.addEventListener("click", function () {
        menuModal.hidden = true;
        it.onClick();
      });
      menuSheet.appendChild(b);
    });
    menuModal.hidden = false;
  }

  function pinItem() {
    var c = activeConv();
    if (!c) return null;
    return {
      text: c.pinned ? "取消置顶" : "置顶",
      onClick: function () {
        Store.setPinned(c.id, !c.pinned).then(loadConversations).then(renderHead);
      }
    };
  }

  function renameItem(label) {
    var c = activeConv();
    if (!c) return null;
    return {
      text: label,
      onClick: function () {
        openPrompt({ title: label, label: "名称", value: c.title })
          .then(function (name) {
            if (name === null || !(name || "").trim()) return;
            return Store.updateConversation(c.id, { title: name.trim() })
              .then(loadConversations)
              .then(function () { if (state.activeId === c.id) renderHead(); });
          });
      }
    };
  }

  function deleteItem(label, convId) {
    return {
      text: label,
      danger: true,
      onClick: function () {
        openPrompt({ title: label, label: "输入「删除」确认", value: "", okText: "删除" })
          .then(function (v) {
            if (v !== "删除") return;
            if (state.streaming && state.cancelStream) state.cancelStream.abort();
            return Store.deleteConversation(convId).then(function () {
              if (state.activeId === convId) {
                state.activeId = null;
                state.members = [];
                state.messages = [];
              }
              return loadConversations().then(function () {
                if (!state.activeId && state.conversations.length) {
                  return selectConversation(state.conversations[0].id);
                }
                renderHead(); renderMessages();
              });
            }).catch(function (e) {
              toast("删除失败: " + (e && e.message ? e.message : e));
            });
          });
      }
    };
  }

  // 清空当前会话的全部消息（保留会话与成员）
  function clearMessages(convId) {
    return Store.listMessages(convId).then(function (list) {
      return Store.deleteMessages(list.map(function (m) { return m.id; }));
    });
  }

  function openChatMenu() {
    var c = activeConv();
    if (!c) return;
    if (isGroup(c)) {
      openSheet([
        { text: "群成员", onClick: openMembers },
        renameItem("修改群名"),
        pinItem(),
        deleteItem("删除群聊", c.id)
      ].filter(Boolean));
    } else {
      openSheet([
        renameItem("重命名"),
        pinItem(),
        {
          text: "清空聊天记录",
          onClick: function () {
            confirmDialog("清空这个会话的全部消息？", "清空").then(function (yes) {
              if (!yes) return;
              return clearMessages(c.id).then(function () {
                state.messages = [];
                renderMessages();
                toast("已清空");
              });
            });
          }
        },
        deleteItem("删除会话", c.id)
      ].filter(Boolean));
    }
  }

  // 左栏 ⋮ / 长按：直接给出该会话的完整菜单（不需要先切换过去）
  function openConvMenu(convId) {
    var c = state.conversations.filter(function (x) { return x.id === convId; })[0];
    if (!c) return;
    Store.listMembers(convId).then(function (mems) {
      var group = isGroup(c);
      var items = group
        ? [
            {
              text: "群成员",
              onClick: function () {
                return (state.activeId === convId ? Promise.resolve()
                  : selectConversation(convId)).then(openMembers);
              }
            },
            {
              text: "修改群名",
              onClick: function () {
                openPrompt({ title: "修改群名", label: "名称", value: c.title })
                  .then(function (name) {
                    if (name === null || !(name || "").trim()) return;
                    return Store.updateConversation(convId, { title: name.trim() })
                      .then(loadConversations)
                      .then(function () { if (state.activeId === convId) renderHead(); });
                  });
              }
            }
          ]
        : [
            {
              text: "重命名",
              onClick: function () {
                openPrompt({ title: "重命名会话", label: "名称", value: c.title })
                  .then(function (name) {
                    if (name === null || !(name || "").trim()) return;
                    return Store.updateConversation(convId, { title: name.trim() })
                      .then(loadConversations)
                      .then(function () { if (state.activeId === convId) renderHead(); });
                  });
              }
            },
            {
              text: "清空聊天记录",
              onClick: function () {
                confirmDialog("清空这个会话的全部消息？", "清空").then(function (yes) {
                  if (!yes) return;
                  return clearMessages(convId).then(function () {
                    if (state.activeId === convId) {
                      state.messages = [];
                      renderMessages();
                    }
                    toast("已清空");
                  });
                });
              }
            }
          ];

      items.push({
        text: c.pinned ? "取消置顶" : "置顶",
        onClick: function () {
          Store.setPinned(convId, !c.pinned).then(loadConversations).then(renderHead);
        }
      });
      items.push(deleteItem(group ? "删除群聊" : "删除会话", convId));
      openSheet(items);
    });
  }

  // ================================================================== new conversation
  var DEFAULT_PERSONA = "你是一位乐于帮忙的对话成员，回答简洁、用用户的语言。";

  // 点 ＋：直接开一个私聊并进入，不弹命名框
  function newDirectChat() {
    return Store.createConversation("助手", [{ name: "助手", persona: DEFAULT_PERSONA }], "direct")
      .then(function (res) {
        return loadConversations().then(function () {
          return selectConversation(res.conversation.id);
        }).then(function () {
          closeOverlays();
          if (composer) {
            composer.value = "";
            composer.style.height = "auto";
            composer.focus();
          }
          return res;
        });
      });
  }

  // 长按 ＋ 或点 ▣：建群（原对话框流程：群名 → 第一位成员）
  function newGroupChat() {
    openPrompt({ title: "新建群聊", label: "群聊名称", value: "新群聊", okText: "下一步" })
      .then(function (title) {
        if (title === null) return;
        title = (title || "").trim() || "新群聊";
        return openPrompt({ title: "第一位成员", label: "成员名称", value: "助手" })
          .then(function (name) {
            if (name === null) return;
            var mName = (name || "").trim() || "助手";
            return Store.createConversation(title, [{ name: mName, persona: DEFAULT_PERSONA }], "group")
              .then(function (res) {
                return loadConversations().then(function () {
                  return selectConversation(res.conversation.id);
                });
              }).then(function () {
                closeOverlays();
                if (composer) composer.focus();
              });
          });
      });
  }

  // ================================================================== settings drawer
  // 宽屏（>=1100px）右栏常显；窄屏/两栏时右栏变成浮层抽屉，由左栏 logo 打开。
  function openSettingsDrawer() {
    if (sidebarLeft) sidebarLeft.classList.remove("open");
    sidebarRight.classList.add("open");
    syncDrawerMask();
  }

  // ================================================================== responsive drawers
  // 纯 class 驱动，断点判定全在 theme.css 的 @media 里，JS 不重复媒体查询。
  function closeOverlays() {
    if (sidebarRight) sidebarRight.classList.remove("open");
    if (sidebarLeft) sidebarLeft.classList.remove("open");
    syncDrawerMask();
  }

  function toggleSidebarLeft() {
    sidebarRight.classList.remove("open");
    sidebarLeft.classList.toggle("open");
    syncDrawerMask();
  }
  // 遮罩由 CSS 按断点显示/隐藏；这里只记录“有抽屉开着”，供样式选择器使用。
  // #drawerMask 与 .app 同级，所以打类到 body（CSS 用 body.has-drawer）。
  function syncDrawerMask() {
    var open = (sidebarLeft && sidebarLeft.classList.contains("open")) ||
               (sidebarRight && sidebarRight.classList.contains("open"));
    if (appEl) appEl.classList.toggle("has-drawer", !!open);
    if (body) body.classList.toggle("has-drawer", !!open);
  }

  // 新建会话后默认已选中该会话
  function refreshSRBack() {
    if (!srBack) return;
    srBack.hidden = !state.activeId;
    if (!state.activeId) sidebarRight.classList.remove("open");
  }

  function loadSettingsIntoUI() {
    baseUrlInput.value = state.settings.baseUrl || "";
    modelInput.value = state.settings.model || "";
    apiKeyInput.value = state.settings.apiKey || "";
  }

  function persistAppearance(patch) {
    return Store.saveSettings(patch).then(function (s) { state.settings = s; });
  }

  // ================================================================== personality save
  var personaTimer = null;
  function onPersonaInput() {
    var first = state.members[0];
    if (!first) return;
    clearTimeout(personaTimer);
    var val = personaInput.value;
    personaTimer = setTimeout(function () {
      first.persona = val;
      Store.updateMember(first).then(function () {
        // 静默保存，不打断输入
      });
    }, 400);
  }

  // ================================================================== reload helper
  function reloadActive() {
    if (!state.activeId) return Promise.resolve();
    return Promise.all([Store.listMembers(state.activeId), Store.listMessages(state.activeId)])
      .then(function (res) {
        state.members = res[0];
        state.messages = res[1];
        renderHead();
        renderMessages();
        updateStatus();
      });
  }

  // ================================================================== bind events
  function bind() {
    if (fabBtn) fabBtn.addEventListener("click", function () {
      // 长按会先触发长按计时器，这里抑制掉随后的 click
      if (fabLongPressed) { fabLongPressed = false; return; }
      newDirectChat().catch(function (e) {
        toast("新建失败: " + (e && e.message ? e.message : e));
      });
    });
    if (fabNewGroup) fabNewGroup.addEventListener("click", newGroupChat);
    // 长按 ＋ 建群
    if (fabBtn) {
      fabBtn.addEventListener("pointerdown", function () {
        fabLongPressed = false;
        clearTimeout(fabTimer);
        fabTimer = setTimeout(function () {
          fabLongPressed = true;
          newGroupChat();
        }, 550);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
        fabBtn.addEventListener(ev, function () { clearTimeout(fabTimer); });
      });
      fabBtn.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        clearTimeout(fabTimer);
        fabLongPressed = true;
        newGroupChat();
      });
    }
    if (gearBtn) gearBtn.addEventListener("click", openSettingsDrawer);
    // 窄屏的返回键关闭抽屉；宽屏（右栏常显）下不存在抽屉，无需动作
    if (srBack) srBack.addEventListener("click", closeOverlays);
    if (chatBack) chatBack.addEventListener("click", toggleSidebarLeft);
    if (drawerMask) drawerMask.addEventListener("click", closeOverlays);
    if (convList) convList.addEventListener("click", function (e) {
      if (e.target.closest(".conv")) closeOverlays();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      closeOverlays();
      if (menuModal) menuModal.hidden = true;
    });

    if (sendBtn) sendBtn.addEventListener("click", send);
    if (composer) {
      composer.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      composer.addEventListener("input", function () {
        composer.style.height = "auto";
        composer.style.height = Math.min(composer.scrollHeight, 120) + "px";
      });
    }

    // header 右上角只有一个 ⋮，内容按群聊/私聊区分
    if (chatMenuBtn) chatMenuBtn.addEventListener("click", function () {
      if (state.activeId) openChatMenu();
    });

    // members modal
    if (membersClose) membersClose.addEventListener("click", function () { membersModal.hidden = true; });
    if (addMemberBtn) addMemberBtn.addEventListener("click", addMemberFlow);
    if (membersModal) membersModal.addEventListener("click", function (e) {
      if (e.target === membersModal) membersModal.hidden = true;
    });

    // prompt modal
    if (promptOk) promptOk.addEventListener("click", function () { closePrompt(true); });
    if (promptClose) promptClose.addEventListener("click", function () { closePrompt(false); });
    if (promptModal) promptModal.addEventListener("click", function (e) {
      if (e.target === promptModal) closePrompt(false);
    });
    if (promptModal) promptModal.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && e.target && e.target.tagName !== "TEXTAREA") {
        e.preventDefault(); closePrompt(true);
      }
    });

    // menu sheet
    if (menuModal) menuModal.addEventListener("click", function (e) {
      if (e.target === menuModal) menuModal.hidden = true;
    });

    // appearance controls
    if (accentSel) accentSel.addEventListener("click", function (e) {
      var btn = e.target.closest(".sw");
      if (!btn) return;
      var hex = btn.getAttribute("data-accent");
      applyAccent(hex);
      persistAppearance({ accent: hex });
    });
    if (wallSel) wallSel.addEventListener("change", function () {
      applyWallpaper(wallSel.value);
      persistAppearance({ wallpaper: wallSel.value });
    });
    if (dimRange) dimRange.addEventListener("input", function () {
      applyDim(dimRange.value);
      persistAppearance({ dim: Number(dimRange.value) });
    });

    // API settings
    function saveApiField(key, input) {
      if (!input) return;
      input.addEventListener("change", function () {
        var patch = {}; patch[key] = input.value.trim();
        persistAppearance(patch);
      });
    }
    saveApiField("baseUrl", baseUrlInput);
    saveApiField("model", modelInput);
    saveApiField("apiKey", apiKeyInput);

    // persona
    if (personaInput) personaInput.addEventListener("input", onPersonaInput);
  }

  // ================================================================== boot
  function boot() {
    bind();
    Store.getSettings().then(function (s) {
      state.settings = s;
      applyAllAppearance();
      loadSettingsIntoUI();
    }).then(function () {
      // 旧数据兜底：给没有 kind 的会话按成员数推断一次（1 → direct，≥2 → group）
      return Store.backfillKinds();
    }).then(loadConversations).then(function () {
      if (state.conversations.length) {
        return selectConversation(state.conversations[0].id);
      }
      renderHead();
      renderMessages();
      updateStatus();
    }).catch(function (e) {
      toast("初始化失败: " + (e && e.message ? e.message : e));
      // 即便 IndexedDB 不可用也不阻断 UI 装填
      applyAllAppearance();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
