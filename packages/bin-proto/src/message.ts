// =============================================================================
// Message (Complete)
// =============================================================================

import { BufferTooSmallError, ChecksumMismatchError, ProtocolError } from "./error";
import { MessageFlags } from "./flags";
import { Footer } from "./footer";
import { Header } from "./header";
import { HEADER_SIZE } from "./protocol";
import { MessageType, Priority } from "./types";
import { crc32Compute } from "./utils";

/**
 * Complete wire protocol message
 */
export class Message {
  public header: Header;
  public body: Uint8Array;
  public footer?: Footer;

  constructor(msgType: MessageType, body: Uint8Array | string) {
    const bodyBytes = typeof body === 'string' 
      ? new TextEncoder().encode(body) 
      : body;

    this.header = new Header(msgType, bodyBytes.length);
    this.body = bodyBytes;
  }

  static new(msgType: MessageType, body: Uint8Array | string): Message {
    return new Message(msgType, body);
  }

  withPriority(priority: Priority): Message {
    this.header.setPriority(priority);
    return this;
  }

  withFlags(flags: MessageFlags): Message {
    this.header.setFlags(flags);
    return this;
  }

  withFooter(footer: Footer): Message {
    const footerBytes = footer.toBytes();
    this.header.footerLen = footerBytes.length;
    this.header.flags |= MessageFlags.HAS_FOOTER.bits();
    this.footer = footer;
    return this;
  }

  withChecksum(): Message {
    this.header.checksum = crc32Compute(this.body);
    return this;
  }

  withTimestamp(timestamp: bigint): Message {
    this.header.timestamp = timestamp;
    return this;
  }

  /**
   * Validate message structure
   */
  validate(): void {
    this.header.validate();

    // Body length check
    if (this.body.length !== this.header.bodyLen) {
      throw new ProtocolError(
        `Body length mismatch: expected ${this.header.bodyLen}, got ${this.body.length}`
      );
    }

    // Footer consistency
    if (this.header.hasFooter() && !this.footer) {
      throw new ProtocolError('HAS_FOOTER flag set but footer is undefined');
    }

    if (this.footer) {
      const footerLen = this.footer.toBytes().length;
      if (footerLen !== this.header.footerLen) {
        throw new ProtocolError(
          `Footer length mismatch: expected ${this.header.footerLen}, got ${footerLen}`
        );
      }
    }

    // Checksum verification
    if (this.header.checksum !== 0) {
      const computed = crc32Compute(this.body);
      if (computed !== this.header.checksum) {
        throw new ChecksumMismatchError(this.header.checksum, computed);
      }
    }
  }

  /**
   * Serialize message to bytes
   */
  toBytes(): Uint8Array {
    const footerBytes = this.footer ? this.footer.toBytes() : new Uint8Array(0);
    const totalLen = HEADER_SIZE + this.body.length + footerBytes.length;

    const buffer = new Uint8Array(totalLen);
    
    // Write header
    buffer.set(this.header.toBytes(), 0);
    
    // Write body
    buffer.set(this.body, HEADER_SIZE);
    
    // Write footer if present
    if (footerBytes.length > 0) {
      buffer.set(footerBytes, HEADER_SIZE + this.body.length);
    }

    return buffer;
  }

  /**
   * Parse message from bytes
   */
  static fromBytes(bytes: Uint8Array): Message {
    if (bytes.length < HEADER_SIZE) {
      throw new BufferTooSmallError(HEADER_SIZE, bytes.length);
    }

    // Parse header
    const header = Header.fromBytes(bytes.slice(0, HEADER_SIZE));

    // Calculate expected length
    const expectedLen = HEADER_SIZE + header.bodyLen + header.footerLen;
    if (bytes.length < expectedLen) {
      throw new BufferTooSmallError(expectedLen, bytes.length);
    }

    // Extract body
    const bodyStart = HEADER_SIZE;
    const bodyEnd = bodyStart + header.bodyLen;
    const body = bytes.slice(bodyStart, bodyEnd);

    // Extract footer if present
    let footer: Footer | undefined;
    if (header.hasFooter()) {
      const footerStart = bodyEnd;
      const footerEnd = footerStart + header.footerLen;
      footer = Footer.fromBytes(bytes.slice(footerStart, footerEnd));
    }

    // Create message
    const msg = new Message(header.typ as MessageType, body);
    msg.header = header;
    msg.footer = footer;

    msg.validate();
    return msg;
  }

  /**
   * Get total message size in bytes
   */
  totalSize(): number {
    const footerSize = this.footer ? this.footer.toBytes().length : 0;
    return HEADER_SIZE + this.body.length + footerSize;
  }
}
