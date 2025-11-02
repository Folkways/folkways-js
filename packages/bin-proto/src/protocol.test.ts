import { describe, it, expect } from 'vitest';
import { MAGIC, VERSION, HEADER_SIZE, MAX_BODY_SIZE, MAX_FOOTER_SIZE } from './protocol';

describe('Protocol Constants', () => {
    it('should have the correct MAGIC bytes', () => {
        expect(MAGIC).toEqual(new Uint8Array([0x46, 0x4F, 0x4C, 0x4B]));
    });

    it('should have the correct VERSION', () => {
        expect(VERSION).toBe(1);
    });

    it('should have the correct HEADER_SIZE', () => {
        expect(HEADER_SIZE).toBe(64);
    });

    it('should have the correct MAX_BODY_SIZE', () => {
        expect(MAX_BODY_SIZE).toBe(30 * 1024);
    });

    it('should have the correct MAX_FOOTER_SIZE', () => {
        expect(MAX_FOOTER_SIZE).toBe(2 * 1024);
    });
});