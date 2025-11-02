import { describe, it, expect } from 'vitest';
import { Message } from './message';
import { Footer } from './footer';
import { MessageFlags } from './flags';
import { MessageType, Priority } from './types';
import { BufferTooSmallError, ChecksumMismatchError, ProtocolError } from './error';

describe('Message', () => {
    it('should create a message with string body', () => {
        const msg = Message.new(MessageType.Publish, 'test message');
        expect(msg.body).toBeInstanceOf(Uint8Array);
        expect(msg.header.bodyLen).toBe(12); // length of 'test message'
    });

    it('should create a message with Uint8Array body', () => {
        const body = new Uint8Array([1, 2, 3, 4]);
        const msg = Message.new(MessageType.Publish, body);
        expect(msg.body).toBe(body);
        expect(msg.header.bodyLen).toBe(4);
    });

    it('should set priority', () => {
        const msg = Message.new(MessageType.Publish, 'test')
            .withPriority(Priority.High);
        expect(msg.header.priority).toBe(Priority.High);
    });

    it('should set flags', () => {
        const msg = Message.new(MessageType.Publish, 'test')
            .withFlags(MessageFlags.COMPRESSED);
        expect(msg.header.flags).toBe(MessageFlags.COMPRESSED.bits());
    });

    it('should add footer', () => {
        const footer = new Footer();
        const msg = Message.new(MessageType.Publish, 'test')
            .withFooter(footer);
        expect(msg.footer).toBe(footer);
        expect(msg.header.hasFooter()).toBe(true);
    });

    it('should compute checksum', () => {
        const msg = Message.new(MessageType.Publish, 'test')
            .withChecksum();
        expect(msg.header.checksum).not.toBe(0);
    });

    it('should validate message structure', () => {
        const msg = Message.new(MessageType.Publish, 'test');
        expect(() => msg.validate()).not.toThrow();
    });

    it('should throw on body length mismatch', () => {
        const msg = Message.new(MessageType.Publish, 'test');
        msg.header.bodyLen = 10; // corrupt header
        expect(() => msg.validate()).toThrow(ProtocolError);
    });

    it('should throw on missing footer', () => {
        const msg = Message.new(MessageType.Publish, 'test');
        msg.header.flags |= MessageFlags.HAS_FOOTER.bits();
        expect(() => msg.validate()).toThrow(ProtocolError);
    });

    it('should throw on checksum mismatch', () => {
        const msg = Message.new(MessageType.Publish, 'test')
            .withChecksum();
        // remember that if body length is changed than it will throw different error. 
        // Checksum mismatch error is thrown when the body is modified but with
        // same length. test === chan, test !== changed.
        msg.body = new TextEncoder().encode('chan'); // corrupt body
        expect(() => msg.validate()).toThrow(ChecksumMismatchError);
    });

    it('should serialize and deserialize message', () => {
        const original = Message.new(MessageType.Publish, 'test')
            .withPriority(Priority.High)
            .withChecksum()
            .withFooter(new Footer());

        const bytes = original.toBytes();
        const decoded = Message.fromBytes(bytes);

        expect(decoded.header.typ).toBe(original.header.typ);
        expect(decoded.header.priority).toBe(original.header.priority);
        expect(decoded.header.checksum).toBe(original.header.checksum);
        expect(decoded.body).toEqual(original.body);
        expect(decoded.footer).toBeDefined();
    });

    it('should throw on small buffer during deserialization', () => {
        const bytes = new Uint8Array(10); // too small
        expect(() => Message.fromBytes(bytes)).toThrow(BufferTooSmallError);
    });
});