/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The node URL from the segment's Connect tab, e.g. https://rte.example.com. */
  readonly VITE_RTE_URL?: string;
  /** Your backend's token endpoint; when set, the app connects with `authUrl`. */
  readonly VITE_RTE_AUTH_URL?: string;
  /** Prefills the token box when there is no `VITE_RTE_AUTH_URL`. */
  readonly VITE_RTE_TOKEN?: string;
}
