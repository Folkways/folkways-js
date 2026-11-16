---
'@folkwaysio/realtime': patch
---

Stop flooding the node with long polls after it restarts (FLK-201):

- A snapshot of a topic that holds only kv values or signals (such as `$online/<identity>`) now sets the topic's cursor to the snapshot's, and clears it when the snapshot has none. Before, an empty snapshot kept a cursor from before the restart, which the node answered at once on every poll.
- A long poll that comes back at once with nothing new now waits before the next one (about 250 ms, doubling to about 2 s, with jitter; reset by new data). No long-poll setting can make a poll group send more than a few requests a second.
- A WebSocket failure only counts toward falling back to HTTP when HTTP works. When the node is down or restarting, the client keeps reconnecting over WebSocket instead of moving to HTTP for `webSocketRetryMs`.
