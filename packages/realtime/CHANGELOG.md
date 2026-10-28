# @folkwaysio/realtime

## 0.1.1

### Patch Changes

- ffb92d6: The SDK is now licensed under the Apache License, Version 2.0 (it was MIT). The package ships `LICENSE` and `NOTICE`, and `NOTICE` credits FlatBuffers, which the browser build bundles.
- 8a0ccdf: TypeScript projects that import the SDK as ES modules (`"module": "node16"` or `"nodenext"`) now get the ES module declarations (`.d.mts`) instead of the CommonJS ones.
- 528432b: Fix three issues found while checking the docs against the SDK:

  - `webSocket` now accepts `WebSocket` from the `ws` package (and the DOM `WebSocket`) under `strict` TypeScript.
  - `isRealtimeError` recognises errors from every entry point and build, so it returns `true` for errors thrown by `Rest` from `@folkwaysio/realtime/server`.
  - The public-key error from `Rest` now points to the key "the dashboard showed once".

- 158da83: The package is smaller: it no longer ships source maps or the wire schema (`proto/`), only the build, `README.md`, `LICENSE` and `NOTICE`.
