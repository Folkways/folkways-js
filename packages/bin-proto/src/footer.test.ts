import { describe, it, expect } from 'vitest';
import { Footer } from './footer';
import { ProtocolError } from './error';

describe('Footer', () => {
    it('should create empty footer', () => {
        const footer = Footer.new();
        expect(footer.topic).toBeUndefined();
        expect(footer.toBytes()).toHaveLength(0);
    });

    it('should set topic', () => {
        const footer = Footer.new().withTopic('test-topic');
        expect(footer.topic).toBe('test-topic');
    });

    it('should serialize and deserialize with topic', () => {
        const original = Footer.new().withTopic('test-topic');
        const bytes = original.toBytes();
        const decoded = Footer.fromBytes(bytes);
        expect(decoded.topic).toBe('test-topic');
    });

    it('should handle empty footer', () => {
        const bytes = new Uint8Array(0);
        const footer = Footer.fromBytes(bytes);

        expect(footer.topic).toBeUndefined();
        // Empty footer is valid!
    });

    it('should throw on truncated length', () => {
        const bytes = new Uint8Array([0x01]);
        expect(() => Footer.fromBytes(bytes)).toThrow(ProtocolError);
        expect(() => Footer.fromBytes(bytes)).toThrow('Footer truncated: missing length');
    });

    it('should throw on truncated value', () => {
        const bytes = new Uint8Array([0x01, 0x05, 0x00]); // Type and length but no value
        expect(() => Footer.fromBytes(bytes)).toThrow(ProtocolError);
        expect(() => Footer.fromBytes(bytes)).toThrow('Footer truncated: value too long');
    });

    it('should throw on unknown field type', () => {
        const bytes = new Uint8Array([0xFF, 0x00, 0x00]); // Invalid type
        expect(() => Footer.fromBytes(bytes)).toThrow(ProtocolError);
        expect(() => Footer.fromBytes(bytes)).toThrow('Unknown footer field type: 255');
    });
});