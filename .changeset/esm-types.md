---
'@folkways/realtime': patch
---

TypeScript projects that import the SDK as ES modules (`"module": "node16"` or `"nodenext"`) now get the ES module declarations (`.d.mts`) instead of the CommonJS ones.
