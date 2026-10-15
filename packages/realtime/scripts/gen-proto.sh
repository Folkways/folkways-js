#!/bin/sh
# Regenerates the FlatBuffers bindings from the RTE schema.
#
# The schema's source of truth is proto/rte.fbs in the rte repository; a copy
# is vendored in ./proto so the package builds on its own. Needs flatc 24.3.25
# (the version the node's Rust bindings and the `flatbuffers` npm runtime use).
#
#   RTE_PROTO=../../../rte/proto/rte.fbs pnpm proto
set -eu
cd "$(dirname "$0")/.."
FLATC="${FLATC:-flatc}"
if [ -n "${RTE_PROTO:-}" ]; then
  cp "$RTE_PROTO" proto/rte.fbs
fi
version="$("$FLATC" --version)"
case "$version" in
  *"24.3.25"*) ;;
  *) echo "need flatc 24.3.25, found: $version" >&2; exit 1 ;;
esac
rm -rf src/transport/wire/generated
"$FLATC" --ts -o src/transport/wire/generated proto/rte.fbs
echo "regenerated src/transport/wire/generated from proto/rte.fbs"
