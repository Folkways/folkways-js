// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get current Unix timestamp in milliseconds
 */
export function currentTimestampMs(): bigint {
  return BigInt(Date.now());
}

/**
 * Compute CRC32 checksum using IEEE polynomial
 */
export function crc32Compute(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }

  return (~crc) >>> 0; // Convert to unsigned 32-bit
}

/**
 * Verify CRC32 checksum
 */
export function crc32Verify(data: Uint8Array, expected: number): boolean {
  return crc32Compute(data) === expected;
}
