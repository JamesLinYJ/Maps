#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/opt/maps-bootstrap}"

has_modern_python() {
  local candidate="$1"
  if [[ ! -x "$candidate" ]]; then
    return 1
  fi
  "$candidate" - <<'PY'
import sys
raise SystemExit(0 if sys.version_info >= (3, 12) else 1)
PY
}

ensure_bootstrap_python() {
  mkdir -p "$(dirname "$BOOTSTRAP_DIR")"
  local installer="/tmp/miniforge-installer.sh"
  echo "[INFO] 未检测到 Python 3.12+，开始安装 Miniforge 到 ${BOOTSTRAP_DIR}"
  curl -fsSL https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh -o "$installer"
  bash "$installer" -b -p "$BOOTSTRAP_DIR"
  rm -f "$installer"
  echo "[OK] Miniforge 安装完成"
}

PYTHON_BIN="${BOOTSTRAP_DIR}/bin/python"
if ! has_modern_python "$PYTHON_BIN"; then
  if has_modern_python "$(command -v python3 || true)"; then
    PYTHON_BIN="$(command -v python3)"
  else
    ensure_bootstrap_python
  fi
fi

"${PYTHON_BIN}" "${SCRIPT_DIR}/deploy.py" --repo-root "${REPO_ROOT}" "$@"
