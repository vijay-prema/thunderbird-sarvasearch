#!/usr/bin/env bash
# Package the Thunderbird add-on into an .xpi for "Install Add-on From File".
#
#   ./build.sh            -> thunderbird-ai-omnisearch-<version>.xpi
#   ./build.sh --dev      -> ...-<version>-<branch>-<sha>.xpi (development build)
#
# There is no build step: the add-on is plain JavaScript, this just zips it.
# Requires the `zip` tool.
set -euo pipefail
cd "$(dirname "$0")"

version=$(node -p "require('./addon/manifest.json').version")
name="thunderbird-ai-omnisearch-${version}"

if [[ "${1:-}" == "--dev" ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  sha=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")
  name="${name}-${branch}-${sha}"
fi

name="${name}.xpi"
rm -f "$name"
(cd addon && zip -qr "../$name" . -x '*.DS_Store' -x 'tests/*' -x '*.map')
echo "Built $name"
