#!/bin/sh
# Regenerates the FlatBuffers bindings from the wire schema in ./proto.
#
# Needs flatc 24.3.25, the version the `flatbuffers` npm runtime uses
# (set FLATC if it isn't on PATH). Update the public schema before generating.
#
#   pnpm proto
set -eu
cd "$(dirname "$0")/.."
FLATC="${FLATC:-flatc}"
version="$("$FLATC" --version)"
case "$version" in
  *"24.3.25"*) ;;
  *) echo "need flatc 24.3.25, found: $version" >&2; exit 1 ;;
esac
rm -rf src/transport/wire/generated
"$FLATC" --ts -o src/transport/wire/generated proto/protocol.fbs
# FlatBuffers 24.3.25 emits an extra namespace component in the barrel's
# relative exports for a three-component namespace. Normalize the barrel
# and verify that every export resolves to an actual generated source file.
node --input-type=module <<'NODE'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const barrel = 'src/transport/wire/generated/folkways/protocol/v1.ts';
const original = readFileSync(barrel, 'utf8');
const normalized = original.replaceAll("from './protocol/v1/", "from './v1/");
const exports = [...normalized.matchAll(/from '([^']+\.js)'/g)];
if (!exports.length) throw new Error('No generated barrel exports');
for (const [, specifier] of exports) {
  if (!specifier.startsWith('./v1/') ||
      !existsSync(resolve(dirname(barrel), specifier.replace(/\.js$/, '.ts')))) {
    throw new Error('Invalid generated barrel export');
  }
}
if (normalized !== original) writeFileSync(barrel, normalized);
NODE
echo "regenerated src/transport/wire/generated from proto/protocol.fbs"
