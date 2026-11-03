#!/usr/bin/env node
/**
 * Pi Web 的 SSE 转接器（跑在本机，监听 30155，转发到 127.0.0.1:30141）。
 *
 * 背景：Cloudflare Quick Tunnel 官方不支持 SSE——GET 的流式响应会被整段缓冲到连接关闭，
 * 只有 POST 的流式响应是实时的（cloudflared#1449）。Pi Web 的 agent/terminal 事件流是
 * 浏览器 EventSource（只能 GET），因此：
 *   Pages Function 把 "Accept: text/event-stream" 的 GET 改发 POST；
 *   本转接器再把这种 POST 还原成对 Pi Web 的 GET（loopback 上流式正常）。
 * 其余请求原样透明转发。
 */

"use strict";

const http = require("node:http");

const LISTEN_PORT = Number(process.env.RELAY_PORT || 30155);
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.PORT || 30141);

function wantsEventStream(req) {
  const accept = req.headers["accept"] || "";
  return accept.includes("text/event-stream");
}

const server = http.createServer((req, res) => {
  const transformed = req.method === "POST" && wantsEventStream(req);

  if (transformed) {
    // 把代理层的 POST 还原成 Pi Web 期望的 GET
    const headers = { ...req.headers };
    delete headers["content-length"];
    delete headers["content-type"];
    delete headers["transfer-encoding"];

    const up = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: "GET",
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        res.flushHeaders?.();
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      },
    );
    up.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`relay error: ${error.message}`);
    });
    up.end();
    res.on("close", () => up.destroy());
    return;
  }

  const headers = { ...req.headers };

  const up = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      res.flushHeaders?.();
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    },
  );
  up.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`relay error: ${error.message}`);
  });
  req.pipe(up);
  res.on("close", () => up.destroy());
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`pi-web relay listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
