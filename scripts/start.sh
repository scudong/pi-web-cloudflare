#!/usr/bin/env bash
# 启动:本机 SSE 转接器 → Cloudflare Tunnel → Pi Web → 写入 KV(上游地址)
# 依赖:cloudflared、node、npx、curl;以及同目录 .env(见 .env.example)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${CF_ACCOUNT_ID:?缺少 CF_ACCOUNT_ID(写进 .env)}"
: "${KV_NAMESPACE:?缺少 KV_NAMESPACE(写进 .env)}"
: "${PAGES_HOST:?缺少 PAGES_HOST(写进 .env)}"
PAGES_PROJECT="${PAGES_PROJECT:-${PAGES_HOST%%.pages.dev}}"
PORT="${PORT:-30141}"
RELAY_PORT="${RELAY_PORT:-30155}"

CFG="${WRANGLER_CONFIG:-$HOME/Library/Preferences/.wrangler/config/default.toml}"

if [ ! -s .password ]; then
  echo "缺少 .password(Pi Web 登录密码),生成中…"
  openssl rand -base64 24 | tr -d '/+=' | cut -c1-28 > .password
  chmod 600 .password
fi
PASSWORD="$(cat .password)"

"$DIR/scripts/stop.sh" >/dev/null 2>&1 || true
mkdir -p state

echo "==> 1/4 启动 SSE 转接器 + Cloudflare Tunnel"
: > state/cloudflared.log
: > state/cloudflared.out
nohup node "$DIR/scripts/sse-relay.js" > state/relay.log 2>&1 &
echo $! > state/relay.pid
sleep 1

nohup cloudflared tunnel --url "http://127.0.0.1:$RELAY_PORT" --no-autoupdate \
  --logfile state/cloudflared.log > state/cloudflared.out 2>&1 &
echo $! > state/tunnel.pid

UPSTREAM=""
for _ in $(seq 1 40); do
  UPSTREAM="$(grep -ohE 'https://[a-z0-9-]+\.trycloudflare\.com' state/cloudflared.log state/cloudflared.out 2>/dev/null | head -1 || true)"
  [ -n "$UPSTREAM" ] && break
  sleep 1
done
if [ -z "$UPSTREAM" ]; then
  echo "隧道没有分配域名,见 state/cloudflared.log" >&2
  exit 1
fi
UPSTREAM_HOST="${UPSTREAM#https://}"
echo "    上游:$UPSTREAM"

echo "==> 2/4 启动 Pi Web(带密码 + 允许的 Host)"
PI_WEB_NO_OPEN=1 \
PI_WEB_PASSWORD="$PASSWORD" \
PI_WEB_ALLOWED_HOSTS="$UPSTREAM_HOST,$PAGES_HOST" \
  nohup npx -y @agegr/pi-web@latest --no-open > state/pi-web.log 2>&1 &
echo $! > state/pi-web.pid

for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/" || true)"
  [ "$code" != "000" ] && break
  sleep 1
done
echo "    本机状态码:${code:-无响应}"

echo "==> 3/4 把上游地址写入 KV"
TOKEN="$(grep -E '^oauth_token' "$CFG" 2>/dev/null | cut -d'"' -f2 || true)"
if [ -n "$TOKEN" ]; then
  curl -s -X PUT \
    -H "Authorization: Bearer $TOKEN" \
    -H "content-type: text/plain" \
    --data "$UPSTREAM" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces/$KV_NAMESPACE/values/upstream" | head -c 120
  echo
else
  echo "    找不到 wrangler OAuth token,请手动更新 KV 里的 upstream 键" >&2
fi

echo "==> 4/4 自检"
curl -s -m 20 "https://$PAGES_HOST/api/web-auth" || true
echo
echo "完成:https://$PAGES_HOST  (密码在 $DIR/.password)"
