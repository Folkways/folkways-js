#!/bin/sh
# Regenerates the FlatBuffers bindings from the wire schema in ./proto.
#
# Needs flatc 24.3.25, the version the `flatbuffers` npm runtime uses
# (set FLATC if it isn't on PATH). FOLKWAYS_PROTOCOL_SCHEMA copies a newer schema in first.
#
#   pnpm proto
set -eu
cd "$(dirname "$0")/.."
FLATC="${FLATC:-flatc}"
if [ -n "${FOLKWAYS_PROTOCOL_SCHEMA:-}" ]; then
  cp "$FOLKWAYS_PROTOCOL_SCHEMA" proto/protocol.fbs
fi
version="$("$FLATC" --version)"
case "$version" in
  *"24.3.25"*) ;;
  *) echo "need flatc 24.3.25, found: $version" >&2; exit 1 ;;
esac
rm -rf src/transport/wire/generated
"$FLATC" --ts -o src/transport/wire/generated proto/protocol.fbs
echo "regenerated src/transport/wire/generated from proto/protocol.fbs"
