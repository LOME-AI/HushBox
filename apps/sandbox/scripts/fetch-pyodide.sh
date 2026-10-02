#!/usr/bin/env bash
# Committed, pinned fetch mechanism for the self-hosted Pyodide 314.0.2 asset
# set the sandbox origin serves from /pyodide/. Self-hosted so that nothing is
# loaded from a public CDN at RUNTIME; the CDN is touched only here, at build
# time. The ~26 MB of wasm/wheels are gitignored (see ../.gitignore) and
# regenerated from this script rather than committed; this file is the source of
# truth for exactly which pinned bytes land under public/pyodide/.
#
# Run: pnpm --filter @hushbox/sandbox fetch-pyodide
#
# The wheel set below (numpy + matplotlib + their transitive deps) is a baseline;
# the runtime's loadPackagesFromImports/micropip path needs the definitive list,
# which is extended here as new imports require it.
set -euo pipefail
# Both arguments exist so the tests beside this file can point one run at a
# scratch directory and a local origin; `pnpm fetch-pyodide` passes neither.
DIR="${1:-$(cd "$(dirname "$0")" && pwd)/../public/pyodide}"
BASE="${2:-https://cdn.jsdelivr.net/pyodide/v314.0.2/full}"
mkdir -p "$DIR"
# A relative first argument is resolved once, here, against the caller's working
# directory — before anything below builds a path from it, so an unusable target
# fails at this boundary rather than as a cp error deep inside restore_core.
DIR="$(cd "$DIR" && pwd)"

# The complete self-hosted wheel closure of numpy + matplotlib + micropip, read
# from pyodide-lock.json (matplotlib pulls contourpy/cycler/fonttools/kiwisolver/
# packaging/pillow/pyparsing/dateutil/pytz; micropip pulls packaging). Every
# transitive dependency must be present or loadPackagesFromImports 404s at
# runtime. Pinned filenames only; never a floating tag. When a new import needs a
# package, add its lock filename (and any new transitive deps) here.
WHEELS=(
  numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  cycler-0.12.1-py3-none-any.whl
  six-1.17.0-py2.py3-none-any.whl
  fonttools-4.62.1-py3-none-any.whl
  kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl
  packaging-26.1-py3-none-any.whl
  pyparsing-3.3.2-py3-none-any.whl
  python_dateutil-2.9.0.post0-py2.py3-none-any.whl
  pytz-2026.1.post1-py2.py3-none-any.whl
  micropip-0.11.1-py3-none-any.whl
)

CORE=(pyodide.mjs pyodide.js pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json)

# Core runtime: taken from the npm package tarball so the loader, glue, wasm,
# stdlib and lock file are a matched set (the v314 CDN dropped the standalone
# pyodide.asm.js layout — the core files differ from the wheels host). npm
# integrity-checks the tarball, which is why only the wheels below are verified
# here.
restore_core() {
  local tmp
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack pyodide@314.0.2 >/dev/null && tar xzf pyodide-314.0.2.tgz)
  cp "$tmp/package/"{pyodide.mjs,pyodide.js,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} "$DIR"
  rm -rf "$tmp"
}

# Compare a file's SHA-256 against the entry pyodide-lock.json already carries
# for that wheel. Exit 1 says the bytes are wrong, 2 says the lock does not
# describe this wheel at all — a pinned name that no longer exists upstream,
# which no re-download can fix. Node does the work because the core runtime
# already requires npm, so it costs no new tool and no per-platform sha command.
verify_wheel() {
  node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [lockPath, filePath, name] = process.argv.slice(1);
const { packages } = JSON.parse(readFileSync(lockPath, "utf8"));
const entry = Object.values(packages).find((p) => p.file_name === name);
if (entry === undefined) {
  console.error(`fetch-pyodide: ${name} has no entry in pyodide-lock.json`);
  process.exit(2);
}
const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
if (actual !== entry.sha256) {
  console.error(`fetch-pyodide: ${name} is sha256 ${actual}, lock says ${entry.sha256}`);
  process.exit(1);
}
' "$DIR/pyodide-lock.json" "$1" "$2"
}

# --fail is what stops an HTTP error page being written into a .whl and reported
# as success. The bytes land on a scratch path and are moved into place only
# once they match the lock, so a failed or substituted download leaves no wheel
# behind for the next run to mistake for a complete one.
fetch_wheel() {
  local w="$1"
  local part="$DIR/$w.part"
  local rc=0
  curl --fail -sSL -o "$part" "$BASE/$w" || rc=$?
  if [ "$rc" -eq 0 ]; then
    verify_wheel "$part" "$w" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    rm -f "$part"
    echo "fetch-pyodide: refusing $w from $BASE" >&2
    exit 1
  fi
  mv "$part" "$DIR/$w"
}

for f in "${CORE[@]}"; do
  if [ ! -f "$DIR/$f" ]; then
    restore_core
    break
  fi
done

# Every wheel is checked against the lock on every run, so a poisoned or
# truncated file is re-fetched rather than inherited forever: the CI cache key
# is the script's text, not the bytes it produced, so a bad tree would otherwise
# replay until someone edited this file.
fetched=0
for w in "${WHEELS[@]}"; do
  rc=0
  if [ -f "$DIR/$w" ]; then
    verify_wheel "$DIR/$w" "$w" || rc=$?
  else
    rc=1
  fi
  if [ "$rc" -eq 2 ]; then
    exit 1
  fi
  if [ "$rc" -ne 0 ]; then
    rm -f "$DIR/$w"
    fetch_wheel "$w"
    fetched=$((fetched + 1))
  fi
done

if [ "$fetched" -eq 0 ]; then
  echo "pyodide assets already present in $DIR — skipping fetch"
else
  echo "pyodide assets restored to $DIR ($(du -sh "$DIR" | cut -f1))"
fi
