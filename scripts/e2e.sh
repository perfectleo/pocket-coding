#!/usr/bin/env bash
#
# 真机 / 端到端联调一键脚本（骨架）。
#
# 把「真机 + 真实服务端」这条链路里手动、易错、有先后依赖的步骤串成一条命令：
#   1) 后台起服务端（npm run dev）
#   2) 轮询 /api/health 等端口就绪
#   3) 跑 Flutter 集成测试（integration_test），把 SERVER_URL 透传给 Dart 侧
#   4) 无论成功/失败/中断，都用 trap 兜底关掉服务端（避免端口占用）
#
# 用法：
#   ./scripts/e2e.sh                         # 用默认 8080，自动选设备
#   DEVICE=emulator-5554 ./scripts/e2e.sh    # 指定设备
#   PORT=9090 ./scripts/e2e.sh               # 指定端口
#   SERVER_URL=http://192.168.1.10:8080 ./scripts/e2e.sh   # 连已在跑的服务端（跳过起服务）
#   TARGET=integration_test/e2e_flow_test.dart ./scripts/e2e.sh   # 只跑某个测试
#
set -euo pipefail

# --- 定位仓库根（脚本在 <root>/scripts/ 下）---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 可覆盖参数 ---
PORT="${PORT:-8080}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:${PORT}}"
DEVICE="${DEVICE:-}"                                  # flutter 设备 id；留空则用默认设备
TARGET="${TARGET:-integration_test}"                  # 目录或单个测试文件
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"                # 等待服务端就绪的秒数
EXTERNAL_SERVER="${EXTERNAL_SERVER:-}"                # 内部标记：是否为外部已有服务端

log() { printf '[e2e] %s\n' "$*"; }
die() { printf '[e2e] ERROR: %s\n' "$*" >&2; exit 1; }

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    log "stopping server (pid=$SERVER_PID)"
    # 杀掉整个进程组，连带 tsx watch 派生的子进程
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --- 1) 起服务端（若 SERVER_URL 已指向外部实例则跳过）---
if curl -sf "$SERVER_URL/api/health" >/dev/null 2>&1; then
  log "reusing already-running server at $SERVER_URL"
  EXTERNAL_SERVER="1"
else
  command -v npm >/dev/null 2>&1 || die "npm not found"
  log "starting server on port $PORT ..."
  ( cd "$ROOT_DIR/server" && PORT="$PORT" npm run dev >/tmp/pocket-e2e-server.log 2>&1 ) &
  SERVER_PID=$!
fi

# --- 2) 等 /api/health 就绪 ---
if [ -z "$EXTERNAL_SERVER" ]; then
  log "waiting for $SERVER_URL/api/health (max ${HEALTH_TIMEOUT}s) ..."
  ready=""
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -sf "$SERVER_URL/api/health" >/dev/null 2>&1; then
      ready="1"; break
    fi
    # 服务端进程若已退出，提前失败并打印日志
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "server process exited early; last log:"
      tail -n 40 /tmp/pocket-e2e-server.log >&2 || true
      die "server failed to start"
    fi
    sleep 1
  done
  [ -n "$ready" ] || { tail -n 40 /tmp/pocket-e2e-server.log >&2 || true; die "server not ready in ${HEALTH_TIMEOUT}s"; }
  log "server ready"
fi

# --- 3) 跑 Flutter 集成测试，透传 SERVER_URL ---
command -v flutter >/dev/null 2>&1 || die "flutter not found"
DEVICE_ARGS=()
[ -n "$DEVICE" ] && DEVICE_ARGS=(-d "$DEVICE")

log "running: flutter test $TARGET (SERVER_URL=$SERVER_URL)"
( cd "$ROOT_DIR/app" && flutter test "$TARGET" \
    --dart-define=SERVER_URL="$SERVER_URL" \
    "${DEVICE_ARGS[@]}" )

log "done"
