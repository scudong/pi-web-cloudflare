# pi-web-cloudflare

用 **Cloudflare 免费档**（不绑卡）给 [pi-web](https://github.com/agegr/pi-web) 一个公网入口：
Cloudflare Pages 反代 + Cloudflare Tunnel，附 **SSE 兼容改造**。

> 给 pi-web 一个 `https://<project>.pages.dev` 地址，大陆可直连，不改 pi-web 一行源码。
> Pi Web 本体仍跑在你自己的机器上（原因见下）。

## 为什么不能整包部署到 Workers

Pi Web 是**本地优先**的 Node 应用，核心依赖在 Workers 运行时里不存在：

| 依赖 | 用途 | Workers |
|---|---|---|
| `node-pty` | 内置终端（真 PTY） | ❌ 无子进程/PTY |
| `node:fs` | 会话、项目文件、Git（119 个文件引用） | ❌ 无持久文件系统 |
| `child_process` / `git` | agent 执行命令、看 diff | ❌ 无进程 |

真正「跑在 Cloudflare 上」只有 **Cloudflare Containers**（托管仓库自带 Dockerfile），
需要 Workers Paid（$5/月 + 绑卡）。本方案用免费档，代价是应用必须留在本机。

## 架构

```
浏览器
  │  https://<project>.pages.dev          Cloudflare Pages（免费，大陆可达）
  ▼
Pages Function  public/_worker.js        反代 + 改写 Origin/Referer/Location
  │  fetch → https://<随机>.trycloudflare.com
  ▼
Cloudflare Tunnel (cloudflared)          本机出站长连接,不开放端口
  │
  ▼
SSE 转接器  scripts/sse-relay.js :30155  把代理层的 POST 还原成 GET
  │
  ▼
Pi Web      http://127.0.0.1:30141       npx @agegr/pi-web
```

隧道域名每次重启都会变，所以上游地址存放在 KV（`PI_WEB_KV` 的 `upstream` 键），
`start.sh` 每次启动自动写入，不用重新部署 Pages。

## 兼容改造点（核心）

| # | 问题 | 现象 | 改造 |
|---|---|---|---|
| 1 | **Quick Tunnel 不支持 SSE** | 事件流要等连接关闭才一次性吐出,界面不更新 | 代理把 `Accept: text/event-stream` 的 GET **改发 POST**;本机转接器再把 POST **还原成 GET** 转发给 Pi Web |
| 2 | **Host 白名单** | 隧道访问返回 403 `Untrusted request` | Pi Web 只信任 loopback/IP/`PI_WEB_ALLOWED_HOSTS`;启动时把隧道域名加进白名单 |
| 3 | **Origin 同源校验** | 所有 `/api/*` 返回 403 | 浏览器 Origin 是 pages.dev、后端 Host 是隧道域名;代理把 `Origin`/`Referer` 改写成上游自身 |
| 4 | **绝对跳转** | 登录后被弹到 `*.trycloudflare.com` | 代理改写 `Location` 回 pages.dev |
| 5 | **隧道域名随机** | 重启后 1033 / 403 | 上游存 KV,`start.sh` 自动更新 |
| 6 | `pages project create` 委派到 Workers | 建出来不是 Pages 项目 | 首次创建必须加 `--force`(只这一次) |
| 7 | `wrangler pages deploy` 报未登录 | OAuth 登录态失效但 token 仍有效 | 用 `CLOUDFLARE_API_TOKEN=$(oauth_token)` 当 bearer 用 |
| 8 | Node 转接器 `req.on('close')` | 上游 `socket hang up` | 请求体读完就触发,改监听 `res.on('close')` |

### 1. SSE 的细节

Cloudflare 官方 [Quick Tunnels 文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
写明不支持 SSE,[cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449) 记录得更细：
**GET 的流式响应被整段缓冲,POST 的流式响应正常**。而浏览器 `EventSource` 只能发 GET。

复现(任一本地 SSE 服务套上 `cloudflared tunnel --url`):

```bash
curl -N https://xxx.trycloudflare.com/sse           # 0 字节,直到连接关闭
curl -N -X POST https://xxx.trycloudflare.com/sse   # 实时逐条到达
```

改造链路:

1. `public/_worker.js`:请求带 `Accept: text/event-stream` 且是 GET → 以 POST 转发上游;
2. `scripts/sse-relay.js`:收到这种 POST → 以 GET 请求 Pi Web → 字节流原样透传;
3. 其余请求(含上传、普通 API)按原方法透明转发。

Pi Web 本身零改动。

### 2/3. Host 与 Origin

Pi Web 的 `lib/request-security.ts` 要求:

- `Host` 必须是 loopback、IP 字面量或 `PI_WEB_ALLOWED_HOSTS` 里的域名;
- 浏览器请求的 `Origin` 必须与 `Host` 同源(防 CSRF)。

经过隧道时 Host 是隧道域名、Origin 是 pages.dev,两者不一致会被拒。
所以启动时把隧道域名写进白名单,并在代理层把 Origin/Referer 改写成上游自身。

## 快速开始

前提:Node ≥ 22.19、`cloudflared`、`wrangler` 已登录。

```bash
# 1. 建 KV 并创建 Pages 项目(首次)
npx wrangler kv namespace create PI_WEB_KV
# 把输出里的 id 填进 wrangler.toml
npx wrangler pages project create pi-web-cf --production-branch main --force

# 2. 部署反代
npx wrangler pages deploy public --project-name pi-web-cf --branch main

# 3. 配置本机参数
cp .env.example .env      # 填 CF_ACCOUNT_ID / KV_NAMESPACE / PAGES_HOST / PAGES_PROJECT

# 4. 一键启动(隧道 → 转接器 → Pi Web → 写 KV → 自检)
./scripts/start.sh
```

首次运行会生成登录密码到 `.password`(0600)。

停止:`./scripts/stop.sh`。开机自启可把 `start.sh` 挂到 launchd / systemd。

## 安全

- 默认开启 `PI_WEB_PASSWORD`,密码只存在本机 `.password`。
- `PI_WEB_ALLOWED_HOSTS` 限定为「当前隧道域名,pages.dev 域名」,Host 不匹配一律 403。
- 隧道只连本机回环,公网无法直连 30141。
- **这仍是一个可以执行任意命令的 agent**:不要把密码给别人,也不要把本方案当作多租户服务。

## 已知限制

- 依赖 `npx @agegr/pi-web` 与本机在线;机器休眠/断网即不可用。
- Quick Tunnel 无 SLA、每次重启换域名(脚本已自动处理),单隧道 200 并发。
- Pages↔Tunnel 都是 Cloudflare 边缘内部访问,所以浏览器从不接触 `trycloudflare.com`,也不受其 DNS 污染影响。

## License

MIT
