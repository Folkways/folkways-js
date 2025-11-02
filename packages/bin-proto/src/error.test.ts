import { describe, it, expect } from 'vitest';
import {
    ProtocolError,
    InvalidMagicError,
    UnsupportedVersionError,
    InvalidMessageTypeError,
    BufferTooSmallError,
    ChecksumMismatchError,
} from './error';

describe('error classes', () => {
    it('ProtocolError sets name and message and is an Error', () => {
        const err = new ProtocolError('something went wrong');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('ProtocolError');
        expect(err.message).toBe('something went wrong');
        expect(typeof err.stack).toBe('string');
        expect(err.stack).toContain('ProtocolError');
        expect(err.stack).toContain('something went wrong');
    });

    it('InvalidMagicError has correct name and message and is a ProtocolError', () => {
        const err = new InvalidMagicError();
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('InvalidMagicError');
        expect(err.message).toBe('Invalid magic bytes');
    });

    it('UnsupportedVersionError stores version and formats message', () => {
        const v = 7;
        const err = new UnsupportedVersionError(v);
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('UnsupportedVersionError');
        expect(err.version).toBe(v);
        expect(err.message).toBe(`Unsupported version: ${v}`);
    });

    it('InvalidMessageTypeError stores type and formats message', () => {
        const t = 42;
        const err = new InvalidMessageTypeError(t);
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('InvalidMessageTypeError');
        expect(err.type).toBe(t);
        expect(err.message).toBe(`Invalid message type: ${t}`);
    });

    it('BufferTooSmallError stores expected/actual and formats message', () => {
        const expected = 128;
        const actual = 64;
        const err = new BufferTooSmallError(expected, actual);
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('BufferTooSmallError');
        expect(err.expected).toBe(expected);
        expect(err.actual).toBe(actual);
        expect(err.message).toBe(`Buffer too small: expected ${expected}, got ${actual}`);
    });

    it('ChecksumMismatchError stores expected/actual and formats hex in message', () => {
        const expected = 0xff;
        const actual = 0x10;
        const err = new ChecksumMismatchError(expected, actual);
        expect(err).toBeInstanceOf(ProtocolError);
        expect(err.name).toBe('ChecksumMismatchError');
        expect(err.expected).toBe(expected);
        expect(err.actual).toBe(actual);
        // message uses hex formatting via toString(16)
        expect(err.message).toBe(`Checksum mismatch: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`);
    });

    it('all custom errors inherit from ProtocolError', () => {
        const instances = [
            new InvalidMagicError(),
            new UnsupportedVersionError(1),
            new InvalidMessageTypeError(2),
            new BufferTooSmallError(10, 5),
            new ChecksumMismatchError(1, 2),
        ];
        for (const inst of instances) {
            expect(inst).toBeInstanceOf(ProtocolError);
        }
    });
});