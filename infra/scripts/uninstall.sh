#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_DIR="${BOOTSTRAP_DIR:-/opt/maps-bootstrap}"

if [[ -x "${BOOTSTRAP_DIR}/bin/python" ]]; then
  PYTHON_BIN="${BOOTSTRAP_DIR}/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

"${PYTHON_BIN}" "${SCRIPT_DIR}/uninstall.py" "$@"
