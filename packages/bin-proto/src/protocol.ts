// =============================================================================
// Protocol Constants
// =============================================================================

/** Magic bytes identifying the protocol - "FOLK" */
export const MAGIC = new Uint8Array([0x46, 0x4F, 0x4C, 0x4B]); // "FOLK"

/** Current protocol version */
export const VERSION = 1;

/** Fixed header size in bytes */
export const HEADER_SIZE = 64;

/** Maximum body size (30 KB) */
export const MAX_BODY_SIZE = 30 * 1024;

/** Maximum footer size (2 KB) */
export const MAX_FOOTER_SIZE = 2 * 1024;
