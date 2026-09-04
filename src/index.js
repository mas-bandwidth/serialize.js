// serialize.js — a bitpacking serialization library for JavaScript.
//
// One of the nine implementations of the serialize family -- C, C++, C#,
// Dart, Elixir, Go, Java, JavaScript and Rust -- which all speak one wire:
// the same values produce the same bytes in every one, so a stream written
// by one reads in any other.
//
// The wire format is defined by STANDARD.md at the repository root, vendored
// verbatim from mas-bandwidth/serialize. That document is the authority, and
// this library implements format version 1.1 of it.
//
// This module is the package entry point.

export { BitWriter, BitReader } from './bitpacker.js';
export { bitsRequired, bitsRequired64, bitsRequired128 } from './bits.js';
export { SerializeError, WriteStream, ReadStream, MeasureStream } from './streams.js';
