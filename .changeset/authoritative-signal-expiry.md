---
"@folkwaysio/realtime": patch
---

Honor service-provided signal expiration metadata in live state and snapshots. Use the packet clock to estimate the remaining lifetime, preserve indefinite signals, prevent duplicate snapshots from renewing deadlines, and retain the configurable fallback for older services.
