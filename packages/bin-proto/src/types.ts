// =============================================================================
// Message Types
// =============================================================================

/**
 * Message type discriminators for different protocol operations.
 */
export enum MessageType {
  Auth = 0x01,
  Publish = 0x02,
  Subscribe = 0x03,
  Unsubscribe = 0x04,
  Ack = 0x05,
  Nack = 0x06,
  Ping = 0x07,
  Pong = 0x08,
  Disconnect = 0x09,
  Error = 0x0E,
}

export namespace MessageType {
  /**
   * Convert a number to MessageType enum
   */
  export function fromU8(value: number): MessageType | null {
    switch (value) {
      case 0x01: return MessageType.Auth;
      case 0x02: return MessageType.Publish;
      case 0x03: return MessageType.Subscribe;
      case 0x04: return MessageType.Unsubscribe;
      case 0x05: return MessageType.Ack;
      case 0x06: return MessageType.Nack;
      case 0x07: return MessageType.Ping;
      case 0x08: return MessageType.Pong;
      case 0x09: return MessageType.Disconnect;
      case 0x0E: return MessageType.Error;
      default: return null;
    }
  }

  /**
   * Check if this message type requires a response
   */
  export function requiresResponse(type: MessageType): boolean {
    return type === MessageType.Ping || 
           type === MessageType.Auth || 
           type === MessageType.Subscribe;
  }

  /**
   * Check if this is a control message
   */
  export function isControl(type: MessageType): boolean {
    return type === MessageType.Ping || 
           type === MessageType.Pong || 
           type === MessageType.Disconnect;
  }
}

// =============================================================================
// Priority Levels
// =============================================================================

/**
 * Priority levels for message processing (2 bits, 4 levels)
 */
export enum Priority {
  Low = 0,
  Normal = 1,
  High = 2,
  Critical = 3,
}

export namespace Priority {
  /**
   * Convert u8 to Priority, masking to 2 bits
   */
  export function fromU8(value: number): Priority {
    switch (value & 0b11) {
      case 0: return Priority.Low;
      case 1: return Priority.Normal;
      case 2: return Priority.High;
      case 3: return Priority.Critical;
      default: return Priority.Normal;
    }
  }
}
