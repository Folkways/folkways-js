import { describe, it, expect } from 'vitest';
import { currentTimestampMs, crc32Compute, crc32Verify } from './utils';

describe('Utility Functions', () => {
    describe('currentTimestampMs', () => {
        it('should return a current Unix timestamp in milliseconds', () => {
            const timestamp = currentTimestampMs();
            expect(typeof timestamp).toBe('bigint');
            expect(timestamp).toBeGreaterThan(0n);
        });
    });

    describe('crc32Compute', () => {
        it('should compute the correct CRC32 checksum for a given Uint8Array', () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const checksum = crc32Compute(data);
            expect(checksum).toBe(3057449933);
        });

        it('should return the same checksum for the same input', () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const checksum1 = crc32Compute(data);
            const checksum2 = crc32Compute(data);
            expect(checksum1).toBe(checksum2);
        });
    });

    describe('crc32Verify', () => {
        it('should return true for valid CRC32 checksum', () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const checksum = crc32Compute(data);
            expect(crc32Verify(data, checksum)).toBe(true);
        });

        it('should return false for invalid CRC32 checksum', () => {
            const data = new Uint8Array([1, 2, 3, 4]);
            const invalidChecksum = 0xFFFFFFFF;
            expect(crc32Verify(data, invalidChecksum)).toBe(false);
        });
    });
});