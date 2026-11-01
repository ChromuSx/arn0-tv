#!/bin/sh
# Compatibility entry point; the cross-platform implementation is shared with Windows.
set -eu
cd "$(dirname "$0")/.."

exec node scripts/build.mjs
