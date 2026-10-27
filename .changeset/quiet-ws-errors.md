---
'@folkways/realtime': patch
---

Fix three issues found while checking the docs against the SDK:

- `webSocket` now accepts `WebSocket` from the `ws` package (and the DOM `WebSocket`) under `strict` TypeScript.
- `isRealtimeError` recognises errors from every entry point and build, so it returns `true` for errors thrown by `Rest` from `@folkways/realtime/server`.
- The public-key error from `Rest` now points to the key "the dashboard showed once".
