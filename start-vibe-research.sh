#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PYTHON="$BACKEND_DIR/.venv/bin/python"
BACKEND_LOG="$ROOT_DIR/backend.log"
FRONTEND_LOG="$ROOT_DIR/frontend.log"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  wait "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

command -v python3 >/dev/null || { echo "未找到 python3" >&2; exit 1; }
command -v npm >/dev/null || { echo "未找到 npm" >&2; exit 1; }
command -v lsof >/dev/null || { echo "未找到 lsof" >&2; exit 1; }

if lsof -nP -iTCP:8900 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 8900 已被占用，后端未启动。" >&2
  exit 1
fi

if lsof -nP -iTCP:5899 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 5899 已被占用，前端未启动。" >&2
  exit 1
fi

if [[ ! -x "$BACKEND_PYTHON" ]]; then
  echo "创建后端 Python 虚拟环境..."
  python3 -m venv "$BACKEND_DIR/.venv"
  echo "安装后端依赖..."
  "$BACKEND_DIR/.venv/bin/pip" install -r "$BACKEND_DIR/requirements.txt"
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "安装前端依赖..."
  npm install --prefix "$FRONTEND_DIR"
fi

echo "启动后端，日志: $BACKEND_LOG"
(
  cd "$BACKEND_DIR"
  exec "$BACKEND_PYTHON" -m uvicorn app:app --host 127.0.0.1 --port 8900
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "启动前端，日志: $FRONTEND_LOG"
(
  cd "$ROOT_DIR"
  exec npm run dev --prefix "$FRONTEND_DIR" -- --host 127.0.0.1 --port 5899
) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

sleep 2

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "后端启动失败，请查看 $BACKEND_LOG" >&2
  exit 1
fi

if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  echo "前端启动失败，请查看 $FRONTEND_LOG" >&2
  exit 1
fi

echo
echo "Vibe-Research 已启动："
echo "前端: http://localhost:5899"
echo "后端: http://localhost:8900"
echo "按 Ctrl+C 同时停止前后端。"

wait
