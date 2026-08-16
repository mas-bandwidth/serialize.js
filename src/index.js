// serialize.js — a bitpacking serialization library for JavaScript.
//
// The sixth implementation of the serialize family, wire compatible with the
// C++, C, C#, Go and Rust libraries: the same values produce the same bytes
// in all six, so a stream written by one reads in any other.
//
// The wire format is defined by STANDARD.md at the repository root, vendored
// verbatim from mas-bandwidth/serialize. That document is the law.
//
// Under construction, chunk by chunk. This module is the package entry point.

export { BitWriter, BitReader } from './bitpacker.js';
export { bitsRequired, bitsRequired64, bitsRequired128 } from './bits.js';
export { SerializeError, WriteStream, ReadStream, MeasureStream } from './streams.js';
