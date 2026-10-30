#!/usr/bin/env bash
# Builds public/fonts/NotoSansSC-Subset.ttf from a full Noto Sans SC TrueType file.
# Usage: scripts/make-cjk-font-subset.sh path/to/NotoSansSC-Regular.ttf
# Requires: pip install fonttools brotli
set -euo pipefail
SRC="${1:?path to NotoSansSC-Regular.ttf (static TrueType, not .otf)}"
mkdir -p public/fonts
pyftsubset "$SRC" \
  --unicodes="U+0020-007E,U+00A0-024F,U+2000-206F,U+2190-21FF,U+3000-303F,U+3040-30FF,U+31F0-31FF,U+FF00-FFEF,U+4E00-9FFF" \
  --layout-features='*' --no-hinting --desubroutinize \
  --output-file=public/fonts/NotoSansSC-Subset.ttf
ls -lh public/fonts/NotoSansSC-Subset.ttf
