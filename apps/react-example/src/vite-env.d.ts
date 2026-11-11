/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The node URL from the segment's Connect tab, e.g. https://rte.example.com. */
  readonly VITE_RTE_URL?: string;
  /** Only when the node serves WebSocket apart from HTTP, e.g. ws://localhost:9005/v1/ws for a local node. */
  readonly VITE_RTE_WS_URL?: string;
}
