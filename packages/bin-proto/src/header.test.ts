import { describe, it, expect } from 'vitest';
import { Header } from './header';
import { MessageType, Priority } from './types';
import { MessageFlags } from './flags';
import { BufferTooSmallError, InvalidMagicError, InvalidMessageTypeError, UnsupportedVersionError } from './error';
import { HEADER_SIZE, MAGIC, VERSION } from './protocol';

describe('Header', () => {
    it('should create a header with default values', () => {
        const header = new Header(MessageType.Ping, 100);
        
        expect(header.magic).toEqual(new Uint8Array(MAGIC));
        expect(header.version).toBe(VERSION);
        expect(header.typ).toBe(MessageType.Ping);
        expect(header.flags).toBe(0);
        expect(header.priority).toBe(Priority.Normal);
        expect(header.bodyLen).toBe(100);
        expect(header.footerLen).toBe(0);
    });

    it('should serialize and deserialize header correctly', () => {
        const original = new Header(MessageType.Ping, 100);
        const bytes = original.toBytes();
        const deserialized = Header.fromBytes(bytes);

        expect(deserialized.magic).toEqual(original.magic);
        expect(deserialized.version).toBe(original.version);
        expect(deserialized.typ).toBe(original.typ);
        expect(deserialized.bodyLen).toBe(original.bodyLen);
    });

    it('should handle flags correctly', () => {
        const header = new Header(MessageType.Ping, 100);
        const flags = new MessageFlags(MessageFlags.HAS_FOOTER.or(MessageFlags.COMPRESSED).bits());
        
        header.setFlags(flags);
        expect(header.getFlags().bits()).toBe(flags.bits());
        expect(flags.contains(MessageFlags.COMPRESSED)).toBe(true);
        expect(flags.contains(MessageFlags.HAS_FOOTER)).toBe(true);
        expect(flags.contains(MessageFlags.REQUIRES_ACK)).toBe(false);
        expect(header.hasFooter()).toBe(true);
    });

    it('should handle priority correctly', () => {
        const header = new Header(MessageType.Ping, 100);
        
        header.setPriority(Priority.High);
        expect(header.getPriority()).toBe(Priority.High);
    });

    it('should throw BufferTooSmallError when buffer is too small', () => {
        const tooSmall = new Uint8Array(HEADER_SIZE - 1);
        expect(() => Header.fromBytes(tooSmall)).toThrow(BufferTooSmallError);
    });

    it('should throw InvalidMagicError for wrong magic', () => {
        const header = new Header(MessageType.Ping, 100);
        header.magic = new Uint8Array([0, 0, 0, 0]);
        expect(() => header.validate()).toThrow(InvalidMagicError);
    });

    it('should throw UnsupportedVersionError for wrong version', () => {
        const header = new Header(MessageType.Ping, 100);
        header.version = 99;
        expect(() => header.validate()).toThrow(UnsupportedVersionError);
    });

    it('should throw InvalidMessageTypeError for invalid message type', () => {
        const header = new Header(MessageType.Ping, 100);
        header.typ = 255;
        expect(() => header.validate()).toThrow(InvalidMessageTypeError);
    });
});
