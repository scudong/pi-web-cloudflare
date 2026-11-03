/**
 * Pi Web —— Cloudflare Pages 入口（Advanced Mode）。
 *
 * 浏览器 → https://pi-web-cf.pages.dev（Cloudflare 边缘）
 *        → 本文件 fetch 到 Cloudflare Tunnel 的 trycloudflare 主机名
 *        → 家里 Mac 上的 Pi Web（127.0.0.1:30141）。
 *
 * 为什么需要这一层：
 * 1. Pi Web 是本地优先应用（node-pty / 真实文件系统 / 子进程），Workers 运行时跑不了，
 *    唯一免费可行的办法是让应用留在 Mac 上，用 Cloudflare Tunnel 出公网。
 * 2. trycloudflare 的随机域名每次重启都会变，且大陆可达性不稳定；pages.dev 可达。
 *    上游地址存在 KV 里，重启隧道后只需更新 KV，不用改代码。
 * 3. Pi Web 的 API 会校验 Origin/Host 同源（防 CSRF）。经过代理时 Origin 是 pages.dev，
 *    Host 是隧道域名，两侧不一致会被 403，所以这里把 Origin/Referer 改写到上游自身。
 *
 * 部署：wrangler pages deploy public --project-name pi-web-cf --branch main
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 上游 = Cloudflare Tunnel 当前指向本机 Pi Web 的地址
    let upstream = null;
    try {
      upstream = await env.PI_WEB_KV?.get("upstream");
    } catch {
      upstream = null;
    }
    upstream = (upstream || env.PI_WEB_UPSTREAM || "").trim().replace(/\/+$/, "");
    if (!upstream) {
      return new Response("Pi Web upstream is not configured (KV key: upstream)", { status: 503 });
    }

    const up = new URL(upstream);
    const target = up.origin + url.pathname + url.search;

    const headers = new Headers(request.headers);
    // 让后端看到的外部来源与它自己的 Host 一致，绕过同源校验
    headers.set("origin", up.origin);    const referer = headers.get("referer");
    if (referer) {
      try {
        const ref = new URL(referer);
        headers.set("referer", up.origin + ref.pathname + ref.search);
      } catch {
        headers.delete("referer");
      }
    }
    // 隧道会用 https 对后端说话；显式声明，避免后端把请求当成明文 http
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", url.host);

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    // Cloudflare Quick Tunnel 不支持 GET 的 SSE（整段缓冲，cloudflared#1449），
    // POST 的流式响应是实时的。事件流改发 POST，由本机的 sse-relay 还原成 GET。
    const accept = headers.get("accept") || "";
    if (request.method === "GET" && accept.includes("text/event-stream")) {
      init.method = "POST";
      headers.delete("content-type");
      headers.delete("content-length");
    }

    const res = await fetch(target, init);

    // 若上游返回指向上游域名的绝对 Location，改回 pages.dev，避免浏览器跳出镜像
    const location = res.headers.get("location");
    if (location && (location.startsWith(up.origin) || location.startsWith(upstream))) {
      const rewritten = new Headers(res.headers);
      rewritten.set("location", url.origin + location.slice(up.origin.length));
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: rewritten,
      });
    }

    // 直接透传（包括 SSE 流式响应、Set-Cookie）
    return res;
  },
};
