---
'@folkwaysio/realtime': minor
---

Follow the node's rate limits and flow control (ADR-015):

- `session.limits` shows the rate limits the node announces for the segment's plan and preset: `publishPerSec`, `publishBurst`, `topicPublishPerSec`, `topicPublishBurst`, `segmentPublishPerSec`, `segmentPublishBurst`, `inboundBytesPerSec`, `outboundBytesPerSec`, `maxSubscribersPerTopic`, `subscribesPerMin`, `topicCreatesPerMin` and `newConnectionsPerMin`. Each is absent when the node does not announce it (older nodes, and HTTP).
- `Flow` from the node is honoured. While `throttled`, publishes go out in batches; while `paused`, they wait in the queue until the node resumes (their `publishTimeoutMs` still runs) and signals are dropped, as when offline. `client.connection.flow` and the `flow` event on `client.connection` show the state.
- A `RateLimited` publish is resent with the same idempotency key after the node's `retry_after_ms`, until `publishTimeoutMs`, and no longer uses up `publishRetries`.
- Waits the node asks for (`retry_after_ms`) get jitter on top, so clients turned away together, such as on `Close{RateLimited}` after `Hello`, do not all come back at the same moment.
- A `RateLimited` (HTTP 429) answer from the publishable-key token exchange keeps its `retry_after_ms`, so reconnecting waits as long as the node asks.
