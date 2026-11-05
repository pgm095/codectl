#!/usr/bin/env bash
# Creates (or repairs) the codectl virtualenv under ~/.cache/codectl/venv.
#
# The environment is derived and rebuildable from requirements.txt, so it lives
# outside the repo. SQLite indexes go next to it in ~/.cache/codectl/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/codectl"
VENV="$CACHE/venv"

mkdir -p "$CACHE"

if [ ! -x "$VENV/bin/python" ]; then
  echo "codectl | creating venv at $VENV" >&2
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
"$VENV/bin/pip" install -q -r "$HERE/requirements.txt"

"$VENV/bin/python" - <<'PY'
from tree_sitter_language_pack import get_parser
for lang in ("typescript", "tsx", "javascript", "python", "rust"):
    get_parser(lang)
print("codectl | venv ok")
PY
