// =============================================================================
// Message Flags
// =============================================================================

/**
 * Message attribute flags (8 bits)
 */
export class MessageFlags {
  private flags: number;

  static readonly NONE = new MessageFlags(0);
  static readonly HAS_FOOTER = new MessageFlags(0b0000_0001);
  static readonly COMPRESSED = new MessageFlags(0b0000_0010);
  static readonly ENCRYPTED = new MessageFlags(0b0000_0100);
  static readonly REQUIRES_ACK = new MessageFlags(0b0000_1000);
  static readonly RETRY = new MessageFlags(0b0001_0000);
  static readonly RESERVED_5 = new MessageFlags(0b0010_0000);
  static readonly RESERVED_6 = new MessageFlags(0b0100_0000);
  static readonly RESERVED_7 = new MessageFlags(0b1000_0000);

  constructor(bits: number) {
    this.flags = bits & 0xFF;
  }

  static fromBits(bits: number): MessageFlags {
    return new MessageFlags(bits);
  }

  bits(): number {
    return this.flags;
  }

  contains(other: MessageFlags): boolean {
    return (this.flags & other.flags) === other.flags;
  }

  insert(other: MessageFlags): void {
    this.flags |= other.flags;
  }

  remove(other: MessageFlags): void {
    this.flags &= ~other.flags;
  }

  or(other: MessageFlags): MessageFlags {
    return new MessageFlags(this.flags | other.flags);
  }

  and(other: MessageFlags): MessageFlags {
    return new MessageFlags(this.flags & other.flags);
  }
}
