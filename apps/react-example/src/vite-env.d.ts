/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The node URL from the segment's Connect tab, e.g. https://rte.example.com. */
  readonly VITE_RTE_URL?: string;
  /** Your own backend's token endpoint. When unset, the app uses the example token server at /api. */
  readonly VITE_RTE_AUTH_URL?: string;
}
