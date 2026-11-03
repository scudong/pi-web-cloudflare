# pi-web-cloudflare

Give [pi-web](https://github.com/agegr/pi-web) a public URL on the **Cloudflare free tier** (no credit card):
a Cloudflare Pages reverse proxy in front of a Cloudflare Tunnel, plus an **SSE compatibility layer**.

> One `https://<project>.pages.dev` address, reachable from mainland China, **without changing a line of pi-web**.
> Pi Web itself keeps running on your own machine (see why below).

中文版见 [README.md](./README.md)

## Why it cannot run entirely on Workers

Pi Web is a local-first Node application. Its core dependencies do not exist in the Workers runtime:

| Dependency | Purpose | Workers |
|---|---|---|
| `node-pty` | built-in terminal (real PTY) | ❌ no child processes / PTY |
| `node:fs` | sessions, project files, Git (119 files) | ❌ no persistent filesystem |
| `child_process` / `git` | agent commands, diffs | ❌ no processes |

The only way to truly host it on Cloudflare is **Cloudflare Containers** running the repo's own Dockerfile,
which requires Workers Paid ($5/mo + a card). This project uses the free tier, so the application stays on your machine.

## Architecture

```
Browser
  │  https://<project>.pages.dev          Cloudflare Pages (free, reachable from CN)
  ▼
Pages Function  public/_worker.js        reverse proxy + Origin/Referer/Location rewrite
  │  fetch → https://<random>.trycloudflare.com
  ▼
Cloudflare Tunnel (cloudflared)          outbound connection from your machine, no open ports
  │
  ▼
SSE relay  scripts/sse-relay.js :30155   turns the proxy's POST back into GET
  │
  ▼
Pi Web     http://127.0.0.1:30141        npx @agegr/pi-web
```

The quick-tunnel hostname changes on every restart, so the upstream URL lives in KV
(`PI_WEB_KV` key `upstream`). `start.sh` writes it on every boot — no Pages redeploy needed.

## Compatibility fixes (the point of this repo)

| # | Problem | Symptom | Fix |
|---|---|---|---|
| 1 | **Quick Tunnels do not support SSE** | event stream arrives all at once after the connection closes; UI never updates | proxy converts `Accept: text/event-stream` GETs to **POST**; the local relay converts them back to **GET** for Pi Web |
| 2 | **Host allow-list** | 403 `Untrusted request` through the tunnel | Pi Web only trusts loopback/IP/`PI_WEB_ALLOWED_HOSTS`; the tunnel hostname is added at startup |
| 3 | **Origin check** | every `/api/*` returns 403 | browser Origin is pages.dev, backend Host is the tunnel host; the proxy rewrites `Origin`/`Referer` to the upstream origin |
| 4 | **Absolute redirects** | login bounces to `*.trycloudflare.com` | proxy rewrites `Location` back to pages.dev |
| 5 | **Random tunnel hostname** | 1033 / 403 after a restart | upstream stored in KV, updated by `start.sh` |
| 6 | `pages project create` delegates to Workers | a Worker is created instead of a Pages project | pass `--force` once, on creation only |
| 7 | `wrangler pages deploy` says not logged in | OAuth session stale while the token still works | use the stored `oauth_token` as `CLOUDFLARE_API_TOKEN` |
| 8 | Node relay `req.on('close')` | upstream `socket hang up` | it fires as soon as the request body is read; listen on `res.on('close')` instead |

### 1. SSE details

Cloudflare's [Quick Tunnels docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
state that SSE is unsupported; [cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449)
shows the mechanics: **GET streams are buffered until the response ends, POST streams are not**.
Browsers' `EventSource` can only issue GET.

Reproduce with any local SSE server behind `cloudflared tunnel --url`:

```bash
curl -N https://xxx.trycloudflare.com/sse           # 0 bytes until the connection closes
curl -N -X POST https://xxx.trycloudflare.com/sse   # arrives live, event by event
```

The workaround:

1. `public/_worker.js`: a GET with `Accept: text/event-stream` is forwarded upstream as POST;
2. `scripts/sse-relay.js`: such a POST is replayed as a GET against Pi Web, and the body is piped straight through;
3. everything else (uploads, regular APIs) is forwarded unchanged.

Pi Web itself is untouched.

### 2/3. Host and Origin

`lib/request-security.ts` in Pi Web requires:

- `Host` to be loopback, an IP literal, or a hostname in `PI_WEB_ALLOWED_HOSTS`;
- same-origin `Origin` and `Host` for browser API requests (CSRF protection).

Through a tunnel the Host is the tunnel hostname while the browser sends `Origin: https://<project>.pages.dev`,
which Pi Web rejects. Hence the allow-list at startup and the Origin/Referer rewrite in the proxy.

## Quick start

Requirements: Node ≥ 22.19, `cloudflared`, and a logged-in `wrangler`.

```bash
# 1. Create the KV namespace and the Pages project (first time only)
npx wrangler kv namespace create PI_WEB_KV
# put the printed id into wrangler.toml
npx wrangler pages project create pi-web-cf --production-branch main --force

# 2. Deploy the proxy
npx wrangler pages deploy public --project-name pi-web-cf --branch main

# 3. Configure local settings
cp .env.example .env      # fill in CF_ACCOUNT_ID / KV_NAMESPACE / PAGES_HOST / PAGES_PROJECT

# 4. Start everything (tunnel → relay → Pi Web → KV → self-check)
./scripts/start.sh
```

The first run generates a login password in `.password` (mode 0600).

Stop with `./scripts/stop.sh`. For auto-start, wire `start.sh` into launchd or systemd.

## Security

- `PI_WEB_PASSWORD` is always enabled; the password only lives in `.password` on your machine.
- `PI_WEB_ALLOWED_HOSTS` is limited to the current tunnel hostname plus the pages.dev hostname; any other Host is rejected with 403.
- The tunnel only connects to loopback; port 30141 is never exposed.
- **This is still an agent that can run arbitrary commands.** Do not share the password, and do not treat this as a multi-tenant service.

## Known limitations

- Depends on `npx @agegr/pi-web` and an online machine: sleep or network loss takes the site down.
- Quick Tunnels have no SLA, rotate their hostname on restart (handled by the script), and cap at 200 in-flight requests.
- Pages and the tunnel only talk to each other inside Cloudflare's edge, so the browser never sees `trycloudflare.com` and is not affected by its DNS pollution.

## License

MIT
