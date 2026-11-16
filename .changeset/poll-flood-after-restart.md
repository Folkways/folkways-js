---
'@folkwaysio/realtime': patch
---

Stop flooding the node with long polls after it restarts:

- A snapshot of a topic that holds only kv values or signals (such as `$online/<identity>`) now replaces the topic's cursor and state version with the snapshot's, and clears them when the snapshot has none. Before, an empty snapshot kept the position from before the restart, which the node answered at once on every poll.
- A long poll that comes back at once with nothing new now waits before the next one (about 250 ms, doubling to about 2 s, with jitter; reset by new data). No long-poll setting can make a poll group send more than a few requests a second.
- A WebSocket failure only counts toward falling back to HTTP when HTTP works. When the node is down or restarting, the client keeps reconnecting over WebSocket instead of moving to HTTP for `webSocketRetryMs`.
