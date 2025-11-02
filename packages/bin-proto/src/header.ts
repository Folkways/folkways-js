// =============================================================================
// Header (Fixed 64 bytes)
// =============================================================================

import { BufferTooSmallError, InvalidMagicError, InvalidMessageTypeError, UnsupportedVersionError } from "./error";
import { MessageFlags } from "./flags";
import { HEADER_SIZE, MAGIC, VERSION } from "./protocol";
import { MessageType, Priority } from "./types";
import { currentTimestampMs } from "./utils";

/**
 * Fixed 64-byte message header
 */
export class Header {
  public magic: Uint8Array;
  public version: number;
  public typ: number;
  public flags: number;
  public priority: number;
  public bodyLen: number;
  public footerLen: number;
  public reserved1: number;
  public timestamp: bigint;
  public checksum: number;
  public reserved2: number;
  public reserved3: Uint8Array;
  public reserved4: Uint8Array;
  public padding: Uint8Array;

  constructor(
    msgType: MessageType,
    bodyLen: number,
    timestamp: bigint = currentTimestampMs()
  ) {
    this.magic = new Uint8Array(MAGIC);
    this.version = VERSION;
    this.typ = msgType;
    this.flags = 0;
    this.priority = Priority.Normal;
    this.bodyLen = bodyLen;
    this.footerLen = 0;
    this.reserved1 = 0;
    this.timestamp = timestamp;
    this.checksum = 0;
    this.reserved2 = 0;
    this.reserved3 = new Uint8Array(8);
    this.reserved4 = new Uint8Array(8);
    this.padding = new Uint8Array(10);
  }

  /**
   * Validate header fields
   */
  validate(): void {
    // Check magic
    if (!this.magic.every((byte, i) => byte === MAGIC[i])) {
      throw new InvalidMagicError();
    }

    // Check version
    if (this.version !== VERSION) {
      throw new UnsupportedVersionError(this.version);
    }

    // Check message type
    if (MessageType.fromU8(this.typ) === null) {
      throw new InvalidMessageTypeError(this.typ);
    }
  }

  messageType(): MessageType | null {
    return MessageType.fromU8(this.typ);
  }

  getPriority(): Priority {
    return Priority.fromU8(this.priority);
  }

  setPriority(priority: Priority): void {
    this.priority = priority;
  }

  getFlags(): MessageFlags {
    return MessageFlags.fromBits(this.flags);
  }

  setFlags(flags: MessageFlags): void {
    this.flags = flags.bits();
  }

  hasFooter(): boolean {
    return this.getFlags().contains(MessageFlags.HAS_FOOTER);
  }

  /**
   * Serialize header to bytes (64 bytes)
   */
  toBytes(): Uint8Array {
    const buffer = new Uint8Array(HEADER_SIZE);
    const view = new DataView(buffer.buffer);

    // Magic (4 bytes)
    buffer.set(this.magic, 0);

    // Version, type, flags, priority (4 bytes)
    buffer[4] = this.version;
    buffer[5] = this.typ;
    buffer[6] = this.flags;
    buffer[7] = this.priority;

    // Body length (4 bytes, little-endian)
    view.setUint32(8, this.bodyLen, true);

    // Footer length (2 bytes, little-endian)
    view.setUint16(12, this.footerLen, true);

    // Reserved1 (2 bytes)
    view.setUint16(14, this.reserved1, true);

    // Timestamp (8 bytes, little-endian)
    view.setBigUint64(16, this.timestamp, true);

    // Checksum (4 bytes, little-endian)
    view.setUint32(24, this.checksum, true);

    // Reserved2 (4 bytes)
    view.setUint32(28, this.reserved2, true);

    // Reserved3 (8 bytes)
    buffer.set(this.reserved3, 32);

    // Reserved4 (8 bytes)
    buffer.set(this.reserved4, 40);

    // Padding (10 bytes)
    buffer.set(this.padding, 48);

    return buffer;
  }

  /**
   * Parse header from bytes
   */
  static fromBytes(bytes: Uint8Array): Header {
    if (bytes.length < HEADER_SIZE) {
      throw new BufferTooSmallError(HEADER_SIZE, bytes.length);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset);

    // Read magic
    const magic = bytes.slice(0, 4);

    // Read fields
    const version = bytes[4];
    const typ = bytes[5];
    const flags = bytes[6];
    const priority = bytes[7];
    const bodyLen = view.getUint32(8, true);
    const footerLen = view.getUint16(12, true);
    const reserved1 = view.getUint16(14, true);
    const timestamp = view.getBigUint64(16, true);
    const checksum = view.getUint32(24, true);
    const reserved2 = view.getUint32(28, true);
    const reserved3 = bytes.slice(32, 40);
    const reserved4 = bytes.slice(40, 48);
    const padding = bytes.slice(48, 58);

    // Create header
    const header = new Header(typ as MessageType, bodyLen, timestamp);
    header.magic = magic;
    header.version = version;
    header.flags = flags;
    header.priority = priority;
    header.footerLen = footerLen;
    header.reserved1 = reserved1;
    header.checksum = checksum;
    header.reserved2 = reserved2;
    header.reserved3 = reserved3;
    header.reserved4 = reserved4;
    header.padding = padding;

    header.validate();
    return header;
  }
}
