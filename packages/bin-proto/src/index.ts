/**
 * bin-proto TypeScript Implementation
 * 
 * A TypeScript port of the Folkways Binary Protocol for frontend-backend interop.
 * 100% compatible with the Rust implementation.
 * 
 * @module bin-proto
 */

import { BufferTooSmallError, ChecksumMismatchError, InvalidMagicError, InvalidMessageTypeError, ProtocolError, UnsupportedVersionError } from "./error";
import { MessageFlags } from "./flags";
import { Footer } from "./footer";
import { Header } from "./header";
import { Message } from "./message";
import { MessageType, Priority } from "./types";
import { crc32Compute, crc32Verify } from "./utils";


export {
  Message,
  MessageType,
  Header,
  Footer,
  Priority,
  MessageFlags,
  crc32Compute,
  crc32Verify,
  ProtocolError,
  InvalidMagicError,
  UnsupportedVersionError,
  InvalidMessageTypeError,
  BufferTooSmallError,
  ChecksumMismatchError,
};
