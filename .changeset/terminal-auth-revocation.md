---
"@folkwaysio/realtime": patch
---

Handle `AuthRevoked` as a terminal authentication error over WebSocket and HTTP. Stop automatic reconnects and retries; update the token explicitly before reconnecting a revoked client.
