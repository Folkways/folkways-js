---
"@folkwaysio/realtime": patch
---

Support configurable signal lifetimes in topic definitions and publish options. Validate KV and signal lifetimes against the protocol range, preserve KV-only keys and removal, and keep signal publishing fire-and-forget. Local signal views still use an independent expiry approximation.
