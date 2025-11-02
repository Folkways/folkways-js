// =============================================================================
// Error Types
// =============================================================================

/**
 * Protocol error types
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class InvalidMagicError extends ProtocolError {
  constructor() {
    super('Invalid magic bytes');
    this.name = 'InvalidMagicError';
  }
}

export class UnsupportedVersionError extends ProtocolError {
  constructor(public version: number) {
    super(`Unsupported version: ${version}`);
    this.name = 'UnsupportedVersionError';
  }
}

export class InvalidMessageTypeError extends ProtocolError {
  constructor(public type: number) {
    super(`Invalid message type: ${type}`);
    this.name = 'InvalidMessageTypeError';
  }
}

export class BufferTooSmallError extends ProtocolError {
  constructor(public expected: number, public actual: number) {
    super(`Buffer too small: expected ${expected}, got ${actual}`);
    this.name = 'BufferTooSmallError';
  }
}

export class ChecksumMismatchError extends ProtocolError {
  constructor(public expected: number, public actual: number) {
    super(`Checksum mismatch: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`);
    this.name = 'ChecksumMismatchError';
  }
}
