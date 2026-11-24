// preview/serve.mjs — 预览用静态服务器（唯一目的：发 no-store，避免浏览器启发式缓存）
// 用法：node preview/serve.mjs [port] [root]
// 默认 port 8914，root = 本文件上一级（webapp/）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8914);
const root = path.resolve(process.argv[3] || path.join(here, ".."));

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

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, NO_STORE, headers || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return send(res, 400, "bad url", { "content-type": "text/plain" });
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";

  const target = path.resolve(root, "." + urlPath);
  if (!target.startsWith(root)) return send(res, 403, "forbidden", { "content-type": "text/plain" });

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found: " + urlPath, { "content-type": "text/plain" });
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, Object.assign({ "content-type": type, "content-length": st.size }, NO_STORE));
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("preview server on http://127.0.0.1:" + port + "/  root=" + root);
});