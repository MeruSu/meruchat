// dev-server.mjs — 本地开发服务器：静态文件 + 同源反代到本机 magpie 网关
//
// 用法：node dev-server.mjs [port] [root]
//   默认 port 8914，root = 本文件所在目录（webapp/）
//
// 为什么需要它：本机 magpie（http://127.0.0.1:3425）不发 CORS，浏览器带
// Authorization + JSON body 会先发 preflight，而它连 OPTIONS 都是 404，于是请求被拦死。
// 这里的 /gw/* 是**同源**反代：页面写 fetch("/gw/v1/models") 就不会有跨域，
// 也顺手把 OPTIONS 应成 204（万一将来从别的源打过来）。
//
// 路由：
//   /gw/*                  → http://127.0.0.1:3425/*（剥掉 /gw 前缀，保留 query）
//   OPTIONS /gw/*          → 204 + CORS 头
//   /search                → 免 key 网页搜索（server/search.mjs，ddg-html → bing → ddg-lite）
//                             POST {query,limit,recency} 或 GET ?q=&limit=
//   其它（/preview、/css、/js…）→ 静态文件，一律 no-store
//
// 上游地址可用环境变量 MAGPIE_ORIGIN 覆盖（默认 http://127.0.0.1:3425）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runSearch } from "./server/search.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8914);
const root = path.resolve(process.argv[3] || here);
const UPSTREAM = (process.env.MAGPIE_ORIGIN || "http://127.0.0.1:3425").replace(/\/+$/, "");

const GW_PREFIX = "/gw";
const SEARCH_PREFIX = "/search";
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, NO_STORE, headers || {}));
  res.end(body);
}

// ---------------------------------------------------------------- 静态
function serveStatic(req, res, urlPath) {
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const target = path.resolve(root, "." + urlPath);
  if (!target.startsWith(root)) {
    return send(res, 403, "forbidden", { "content-type": "text/plain; charset=utf-8" });
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, "not found: " + urlPath, { "content-type": "text/plain; charset=utf-8" });
    }
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, Object.assign({ "content-type": type, "content-length": st.size }, NO_STORE));
    fs.createReadStream(target).pipe(res);
  });
}

// ---------------------------------------------------------------- 反代
/** 把请求体读成 Buffer（JSON/文本，上限 MAX_BODY） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxy(req, res, urlObj) {
  // /gw/v1/chat/completions?x=1 → http://127.0.0.1:3425/v1/chat/completions?x=1
  const upstreamPath = urlObj.pathname.replace(/^\/gw/, "") || "/";
  const target = UPSTREAM + upstreamPath + (urlObj.search || "");

  const headers = { accept: req.headers.accept || "application/json" };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const ac = new AbortController();
  // 客户端先断开（关页面 / 点停止）就掐掉上游，别让生成长跑
  res.on("close", () => ac.abort());

  let body;
  if (req.method === "GET" || req.method === "HEAD") {
    body = undefined;
  } else {
    body = await readBody(req);
    headers["content-length"] = String(body.length);
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return; // 客户端已走，不用回
    return send(res, 502, "upstream unreachable: " + (e && e.message), {
      "content-type": "text/plain; charset=utf-8",
    });
  }

  const outHeaders = Object.assign({}, CORS, NO_STORE);
  for (const k of ["content-type", "content-length", "cache-control"]) {
    const v = upstream.headers.get(k);
    if (v) outHeaders[k] = v;
  }
  // 上游的 content-type 原样带回：SSE 必须是 text/event-stream，
  // 走了一眼缓存/整包读取都会把流式变成一次性。
  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) {
    res.end();
    return;
  }
  // 直接 pipe：边收边发，绝不 await upstream.text()
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------- 搜索
/** 读 POST body 里的 {query,limit,recency}；空 body 不报错，交给上层报 bad_args */
async function readSearchArgs(req) {
  const raw = await readBody(req);
  const text = raw.toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function handleSearch(req, res, urlObj) {
  let args;
  try {
    args = req.method === "GET" || req.method === "HEAD" ? {} : await readSearchArgs(req);
  } catch (e) {
    return send(res, 413, JSON.stringify({ ok: false, error: "body_too_large", detail: String(e && e.message) }), {
      "content-type": "application/json; charset=utf-8",
    });
  }
  // GET 走 query string，POST 走 JSON body
  const query = String(urlObj.searchParams.get("q") || args.query || "").trim();
  const limit = Number(urlObj.searchParams.get("limit") || args.limit) || 5;
  const recency = String(urlObj.searchParams.get("recency") || args.recency || "");

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  const json = (code, obj) =>
    send(res, code, JSON.stringify(obj), Object.assign({ "content-type": "application/json; charset=utf-8" }, CORS));

  try {
    const out = await runSearch({ query, limit, recency, signal: ac.signal });
    json(200, { ok: true, engine: out.engine, results: out.results });
  } catch (e) {
    if (ac.signal.aborted) return; // 客户端已走
    const code = (e && e.code) || "search_failed";
    const detail = Array.isArray(e && e.detail)
      ? e.detail.map((f) => f.engine + ": " + f.reason).join("；")
      : String((e && e.message) || e);
    console.log("search       fail " + code + " q=" + JSON.stringify(query) + " " + detail);
    json(502, { ok: false, error: code === "bad_args" ? "bad_args" : "search_failed", detail });
  }
}

// ---------------------------------------------------------------- 入口
const server = http.createServer((req, res) => {
  let urlObj;
  try {
    urlObj = new URL(req.url, "http://127.0.0.1:" + port);
  } catch {
    return send(res, 400, "bad url", { "content-type": "text/plain; charset=utf-8" });
  }

  const isGw = urlObj.pathname === GW_PREFIX || urlObj.pathname.startsWith(GW_PREFIX + "/");
  const isSearch = urlObj.pathname === SEARCH_PREFIX || urlObj.pathname.startsWith(SEARCH_PREFIX + "/");

  if (isSearch) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    handleSearch(req, res, urlObj).catch((e) => {
      if (!res.headersSent) {
        send(res, 500, JSON.stringify({ ok: false, error: "search_failed", detail: String(e && e.message) }), {
          "content-type": "application/json; charset=utf-8",
        });
      } else {
        res.destroy();
      }
    });
    return;
  }

  if (isGw) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    proxy(req, res, urlObj).catch((e) => {
      if (!res.headersSent) {
        send(res, 500, "proxy error: " + (e && e.message), {
          "content-type": "text/plain; charset=utf-8",
        });
      } else {
        res.destroy();
      }
    });
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(urlObj.pathname);
  } catch {
    return send(res, 400, "bad url", { "content-type": "text/plain; charset=utf-8" });
  }
  serveStatic(req, res, urlPath);
});

server.listen(port, "127.0.0.1", () => {
  console.log("dev server   http://127.0.0.1:" + port + "/   root=" + root);
  console.log("gateway      /gw/* -> " + UPSTREAM + "/*");
  console.log("search       /search -> ddg-html|bing|ddg-lite (keyless)");
});