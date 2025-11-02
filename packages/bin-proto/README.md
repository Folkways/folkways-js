# @folkways/bin-proto

Binary protocol for Folkways RTE

## ✨ Features

- **100% Wire-Compatible** with Rust `bin-proto`
- **Zero-copy header parsing** for performance
- **Fixed 64-byte headers** for predictable parsing
- **TLV-encoded footers** for extensible metadata
- **CRC32 checksums** for integrity validation
- **Type-safe** with full TypeScript support
- **Works everywhere**: Browser, Node.js, Deno, Bun
- **Fully tested** with 100% compatibility tests

## Installation

```bash
npm install @folkways/bin-proto
# or
yarn add @folkways/bin-proto
# or
pnpm add @folkways/bin-proto
```

## 🚀 Quick Start

```typescript
import { Message, MessageType, Priority, MessageFlags, Footer } from '@folkways/bin-proto';

// Create a simple message
const msg1 = Message.new(MessageType.Publish, 'Hello, world!');

// Create a message with priority and flags
const msg2 = Message.new(MessageType.Publish, 'Important data')
  .withPriority(Priority.High)
  .withFlags(MessageFlags.REQUIRES_ACK.or(MessageFlags.COMPRESSED));

// Create a message with footer metadata
const footer = Footer.new().withTopic('chat.room1');
const msg3 = Message.new(MessageType.Publish, 'Hello!')
  .withPriority(Priority.Critical)
  .withFlags(MessageFlags.REQUIRES_ACK)
  .withFooter(footer)
  .withChecksum();

// Serialize to bytes
const bytes: Uint8Array = msg.toBytes();

// Send over WebSocket
websocket.send(bytes);

// Parse from bytes
const parsed = Message.fromBytes(bytes);
```

## 🏗️ Architecture

### Message Structure

```
┌─────────────────────────────────────────┐
│  Header (64 bytes)                      │
│  - Magic: "FOLK"                        │
│  - Version: 1                           │
│  - Message Type: 1 byte                 │
│  - Flags: 8 bits                        │
│  - Priority: 2 bits (4 levels)          │
│  - Body Length: 4 bytes                 │
│  - Footer Length: 2 bytes               │
│  - Timestamp: 8 bytes                   │
│  - Checksum: 4 bytes (CRC32)            │
│  - Reserved fields                      │
├─────────────────────────────────────────┤
│  Body (variable length)                 │
│  - Raw payload data                     │
│  - Can be JSON, binary, text, etc.      │
├─────────────────────────────────────────┤
│  Footer (optional)         │
│  - Topic (for routing)                  │
│  - More fields coming soon              │
└─────────────────────────────────────────┘
```

## API Reference

### Message Types

```typescript
enum MessageType {
  Auth = 0x01,        // Authentication
  Publish = 0x02,     // Publish to topic
  Subscribe = 0x03,   // Subscribe to topics
  Unsubscribe = 0x04, // Unsubscribe
  Ack = 0x05,         // Acknowledgment
  Nack = 0x06,        // Negative ack
  Ping = 0x07,        // Heartbeat
  Pong = 0x08,        // Ping response
  Disconnect = 0x09,  // Disconnect
  Error = 0x0E,       // Error message
}
```

### Priority Levels

```typescript
enum Priority {
  Low = 0,       // Background tasks
  Normal = 1,    // Default
  High = 2,      // Important
  Critical = 3,  // Urgent
}
```

### Message Flags

```typescript
MessageFlags.HAS_FOOTER      // Has footer
MessageFlags.COMPRESSED      // Body is compressed
MessageFlags.ENCRYPTED       // Body is encrypted
MessageFlags.REQUIRES_ACK    // Needs acknowledgment
MessageFlags.RETRY           // Is a retry
```

### Creating Messages

```typescript
// Simple message
const msg = Message.new(MessageType.Publish, 'text data');
const msg = Message.new(MessageType.Publish, new Uint8Array([1, 2, 3]));

// With builder pattern
const msg = Message.new(MessageType.Publish, 'data')
  .withPriority(Priority.High)
  .withFlags(MessageFlags.REQUIRES_ACK)
  .withChecksum();
```

### Adding Footers

```typescript
const footer = Footer.new()
  .withTopic('events.user.123');

const msg = Message.new(MessageType.Publish, 'User event')
  .withFooter(footer);
```

### Serialization

```typescript
// To bytes
const bytes: Uint8Array = msg.toBytes();

// From bytes
const parsed = Message.fromBytes(bytes);
```

## Security

### Integrity Validation

```typescript
// Add checksum
const msg = Message.new(MessageType.Publish, 'sensitive data')
  .withChecksum();

// Automatically verified on parse
try {
  const parsed = Message.fromBytes(bytes);
  // Checksum valid
} catch (e) {
  if (e instanceof ChecksumMismatchError) {
    console.error('Message corrupted!');
  }
}
```

### Encryption Flag

```typescript
// Mark as encrypted (you handle encryption separately)
const encrypted = encryptData(plaintext);
const msg = Message.new(MessageType.Publish, encrypted)
  .withFlags(MessageFlags.ENCRYPTED);
```

## Testing

```bash
pnpm test                   # Run tests
pnpm run test:coverage      # Watch mode
```

## License

MIT
