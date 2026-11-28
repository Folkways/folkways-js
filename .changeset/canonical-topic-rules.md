---
"@folkwaysio/realtime": minor
---

Export canonical nested topic rules from `defineTopic().rule()`, validate event names against the 64-byte UTF-8 limit for definitions and client/server publishing, and clarify cursor versus UID identity. The rule export replaces the previous separate key and TTL maps; event definition inputs remain unchanged.
