#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/opt/maps-bootstrap}"
INSTALLER_PATH="${INSTALLER_PATH:-/tmp/miniforge-installer.sh}"

info() {
  echo "[INFO] $*" >&2
}

ok() {
  echo "[OK] $*" >&2
}

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

download_installer() {
  info "开始下载 Miniforge 安装包，这一步可能需要几十秒到几分钟"
  if command -v wget >/dev/null 2>&1; then
    wget --show-progress -O "$INSTALLER_PATH" \
      "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh"
  else
    curl -fL --progress-bar \
      "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh" \
      -o "$INSTALLER_PATH"
  fi
  ok "安装包下载完成: $INSTALLER_PATH"
}

ensure_bootstrap_python() {
  mkdir -p "$(dirname "$BOOTSTRAP_DIR")"
  info "未检测到 Python 3.12+，开始安装 Miniforge 到 ${BOOTSTRAP_DIR}"
  if has_modern_python "${BOOTSTRAP_DIR}/bin/python"; then
    ok "发现可复用的 bootstrap Python，跳过重装"
    "${BOOTSTRAP_DIR}/bin/python" --version >&2
    return
  fi
  if [[ -d "$BOOTSTRAP_DIR" ]]; then
    info "发现不完整的 bootstrap 目录，先清理后重装"
    rm -rf "$BOOTSTRAP_DIR"
  fi
  download_installer
  info "开始执行 Miniforge 安装"
  bash "$INSTALLER_PATH" -b -p "$BOOTSTRAP_DIR"
  ok "Miniforge 安装完成"
  "${BOOTSTRAP_DIR}/bin/python" --version >&2
}

pick_python() {
  if has_modern_python "${BOOTSTRAP_DIR}/bin/python"; then
    echo "${BOOTSTRAP_DIR}/bin/python"
    return
  fi

  local system_python
  system_python="$(command -v python3 || true)"
  if has_modern_python "$system_python"; then
    echo "$system_python"
    return
  fi

  ensure_bootstrap_python
  echo "${BOOTSTRAP_DIR}/bin/python"
}

info "准备部署 Maps"
info "代码目录: ${REPO_ROOT}"
PYTHON_BIN="$(pick_python)"
ok "使用 Python: ${PYTHON_BIN}"

info "开始执行 Python 部署脚本"
"${PYTHON_BIN}" "${SCRIPT_DIR}/deploy.py" --repo-root "${REPO_ROOT}" "$@"
