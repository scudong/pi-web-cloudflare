#!/usr/bin/env bash
# 停掉本目录启动的隧道、转接器和 Pi Web 实例。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
fi
PORT="${PORT:-30141}"
RELAY_PORT="${RELAY_PORT:-30155}"

for f in state/pi-web.pid state/tunnel.pid state/relay.pid; do
  if [ -f "$DIR/$f" ]; then
    pid="$(cat "$DIR/$f")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$DIR/$f"
  fi
done

# next-server / cloudflared 子进程不一定在同一进程组,再按端口兜底
pkill -f "cloudflared tunnel --url http://127.0.0.1:$RELAY_PORT" 2>/dev/null || true
pkill -f "scripts/sse-relay.js" 2>/dev/null || true
pkill -f "pi-web --no-open" 2>/dev/null || true

for pid in $(lsof -ti tcp:$PORT 2>/dev/null) $(lsof -ti tcp:$RELAY_PORT 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done

sleep 1
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || echo "$PORT 已释放"
lsof -nP -iTCP:$RELAY_PORT -sTCP:LISTEN 2>/dev/null || echo "$RELAY_PORT 已释放"
