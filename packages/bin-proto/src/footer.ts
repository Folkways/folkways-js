// =============================================================================
// Footer (TLV Encoding)
// =============================================================================

import { ProtocolError } from "./error";

/**
 * Footer field type discriminators
 */
enum FooterFieldType {
  Topic = 0x01,
}

/**
 * Optional structured footer with TLV encoding
 */
export class Footer {
  public topic?: string;

  constructor() {}

  static new(): Footer {
    return new Footer();
  }

  withTopic(topic: string): Footer {
    this.topic = topic;
    return this;
  }

  /**
   * Serialize footer to bytes using TLV encoding
   */
  toBytes(): Uint8Array {
    const chunks: Uint8Array[] = [];

    // Encode topic
    if (this.topic) {
      const topicBytes = new TextEncoder().encode(this.topic);
      const field = new Uint8Array(1 + 2 + topicBytes.length);
      field[0] = FooterFieldType.Topic;
      new DataView(field.buffer).setUint16(1, topicBytes.length, true); // little-endian
      field.set(topicBytes, 3);
      chunks.push(field);
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Parse footer from bytes
   */
  static fromBytes(bytes: Uint8Array): Footer {
    const footer = new Footer();
    let cursor = 0;

    while (cursor < bytes.length) {
      // Read type
      if (cursor + 1 > bytes.length) {
        throw new ProtocolError('Footer truncated: missing type');
      }
      const fieldType = bytes[cursor];
      cursor += 1;

      // Read length
      if (cursor + 2 > bytes.length) {
        throw new ProtocolError('Footer truncated: missing length');
      }
      const length = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint16(0, true);
      cursor += 2;

      // Read value
      if (cursor + length > bytes.length) {
        throw new ProtocolError('Footer truncated: value too long');
      }
      const value = bytes.slice(cursor, cursor + length);
      cursor += length;

      // Assign to appropriate field
      switch (fieldType) {
        case FooterFieldType.Topic:
          footer.topic = new TextDecoder().decode(value);
          break;
        default:
          throw new ProtocolError(`Unknown footer field type: ${fieldType}`);
      }
    }

    return footer;
  }
}
