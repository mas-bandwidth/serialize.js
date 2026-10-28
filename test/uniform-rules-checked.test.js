// The uniform rules of IMPLEMENTING.md (reference v2.1.0) that the CHECKED
// write path keeps: write misuse, the family's checked-build assertion, is
// ONE mechanism in this port (U9). The checked WriteStream, MeasureStream
// and BitWriter throw on every write misuse, on every operation,
// compressed_float included: a bad declaration or argument, and a value the
// declaration cannot carry (out of range, wider than its bits, not finite,
// text that is not well-formed or holds U+0000, too long for its buffer).
// The production variants validate none of it. A write past the end of the
// buffer is not misuse: it latches past_end in every mode. Dev leg only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, MeasureStream, ReadStream, SerializeError, WriteStream } from '../src/index.js';

const both = () => [new WriteStream(new Uint8Array(64)), new MeasureStream()];

test('U1: a write buffer is a multiple of 8 bytes, never 4', () => {
  for (const length of [4, 12, 1, 7]) {
    assert.throws(() => new WriteStream(new Uint8Array(length)), RangeError, String(length));
    assert.throws(() => new BitWriter(new Uint8Array(length)), RangeError, String(length));
  }
  for (const length of [0, 8, 16]) {
    assert.doesNotThrow(() => new WriteStream(new Uint8Array(length)));
  }
});

// Audit M (js), U8: a value wider than its field was masked and sent; the
// reader handed back a different value with no error anywhere
// (audit-repro/bits-overwide.mjs).
const OVERWIDE = [
  ['serializeBits(256, 8)', (s) => s.serializeBits({ value: 256 }, 8)],
  ['serializeBits(-1, 4)', (s) => s.serializeBits({ value: -1 }, 4)],
  ['serializeBits(1.75, 8)', (s) => s.serializeBits({ value: 1.75 }, 8)],
  ['serializeBits(2^32, 32)', (s) => s.serializeBits({ value: 2 ** 32 }, 32)],
  ['serializeUint8(300)', (s) => s.serializeUint8({ value: 300 })],
  ['serializeUint16(70000)', (s) => s.serializeUint16({ value: 70000 })],
  ['serializeUint32(2^32 + 7)', (s) => s.serializeUint32({ value: 2 ** 32 + 7 })],
  ['serializeBits64(2^40, 40)', (s) => s.serializeBits64({ value: 2n ** 40n }, 40)],
  ['serializeBits64(-1n, 8)', (s) => s.serializeBits64({ value: -1n }, 8)],
  ['serializeUint64(-1n)', (s) => s.serializeUint64({ value: -1n })],
  ['serializeUint64(2^64)', (s) => s.serializeUint64({ value: 2n ** 64n })],
  ['serializeUint128(2^128 + 5)', (s) => s.serializeUint128({ value: 2n ** 128n + 5n })],
  ['serializeUint128(-1n)', (s) => s.serializeUint128({ value: -1n })],
];

test('U8, audit M: a value wider than its bits throws on write and measure, and writes nothing', () => {
  for (const [name, call] of OVERWIDE) {
    for (const stream of both()) {
      assert.throws(() => call(stream), RangeError, name);
      assert.equal(stream.bitsProcessed(), 0, name);
      assert.equal(stream.error, SerializeError.None, name);
    }
  }
});

test('U8: reversed witness, the widest value that fits is written and read back', () => {
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 255 }, 8), true);
  assert.equal(writer.serializeUint8({ value: 255 }), true);
  assert.equal(writer.serializeUint16({ value: 65535 }), true);
  assert.equal(writer.serializeUint32({ value: 2 ** 32 - 1 }), true);
  assert.equal(writer.serializeBits64({ value: 2n ** 40n - 1n }, 40), true);
  assert.equal(writer.serializeUint64({ value: 2n ** 64n - 1n }), true);
  assert.equal(writer.serializeUint128({ value: 2n ** 128n - 1n }), true);
  writer.flush();
  const reader = new ReadStream(writer.data());
  const ref = { value: 0 };
  assert.equal(reader.serializeBits(ref, 8), true);
  assert.equal(ref.value, 255);
  assert.equal(reader.serializeUint8(ref), true);
  assert.equal(ref.value, 255);
  assert.equal(reader.serializeUint16(ref), true);
  assert.equal(ref.value, 65535);
  assert.equal(reader.serializeUint32(ref), true);
  assert.equal(ref.value, 2 ** 32 - 1);
  assert.equal(reader.serializeBits64(ref, 40), true);
  assert.equal(ref.value, 2n ** 40n - 1n);
  assert.equal(reader.serializeUint64(ref), true);
  assert.equal(ref.value, 2n ** 64n - 1n);
  assert.equal(reader.serializeUint128(ref), true);
  assert.equal(ref.value, 2n ** 128n - 1n);
});

test('U8: the checked bitpacker throws a value wider than its bits too', () => {
  const writer = new BitWriter(new Uint8Array(8));
  assert.throws(() => writer.writeBits(256, 8), RangeError);
  assert.throws(() => writer.tryWriteBits(-1, 4), RangeError);
  assert.throws(() => writer.writeBits(0.5, 4), RangeError);
  assert.doesNotThrow(() => writer.writeBits(255, 8));
  assert.equal(writer.tryWriteBits(15, 4), true);
});

// U9: every value a declaration cannot carry is write misuse, on every
// operation, and throws on write and measure alike.
const VALUE_MISUSE = [
  ['int above max', (s) => s.serializeInt({ value: 11 }, 0, 10)],
  ['int not an integer', (s) => s.serializeInt({ value: 1.5 }, 0, 10)],
  ['int64 above max', (s) => s.serializeInt64({ value: 11n }, 0n, 10n)],
  ['int128 below min', (s) => s.serializeInt128({ value: -1n }, 0n, 10n)],
  ['int_relative not increasing', (s) => s.serializeIntRelative(5, { value: 5 })],
  ['int_relative above the domain', (s) => s.serializeIntRelative(5, { value: 2 ** 31 })],
  ['fixed below min', (s) => s.serializeFixed({ value: -1 }, 8, 8, 0, 1)],
  ['fixed wide above max', (s) => s.serializeFixed({ value: 2n ** 40n }, 32, 32, 0n, 1n)],
  ['float NaN', (s) => s.serializeFloat({ value: NaN })],
  ['float above FLT_MAX', (s) => s.serializeFloat({ value: 1e39 })],
  ['double Infinity', (s) => s.serializeDouble({ value: Infinity })],
  ['compressed float NaN', (s) => s.serializeCompressedFloat({ value: NaN }, 0, 1, 0.1)],
  ['precomputed compressed float NaN', (s) => s.serializeCompressedFloatPrecomputed({ value: NaN }, 1000, 10, 10, 0)],
  ['string with U+0000 (U4)', (s) => s.serializeString({ value: 'a\0b' }, 32)],
  ['string with a lone surrogate (U3, U4)', (s) => s.serializeString({ value: 'a\ud800b' }, 32)],
  ['string too long', (s) => s.serializeString({ value: 'abcd' }, 4)],
];

test('U9: a value the declaration cannot carry throws on write and measure, and writes nothing', () => {
  for (const [name, call] of VALUE_MISUSE) {
    for (const stream of both()) {
      assert.throws(() => call(stream), RangeError, name);
      assert.equal(stream.bitsProcessed(), 0, name);
      assert.equal(stream.error, SerializeError.None, name);
    }
  }
});

test('U9: reversed witness, the boundary values are written', () => {
  for (const stream of both()) {
    assert.equal(stream.serializeInt({ value: 10 }, 0, 10), true);
    assert.equal(stream.serializeInt64({ value: 10n }, 0n, 10n), true);
    assert.equal(stream.serializeInt128({ value: 0n }, 0n, 10n), true);
    assert.equal(stream.serializeIntRelative(5, { value: 2 ** 31 - 1 }), true);
    assert.equal(stream.serializeFixed({ value: 256 }, 8, 8, 0, 1), true);
    assert.equal(stream.serializeFloat({ value: 3.4028234663852886e38 }), true);
    assert.equal(stream.serializeDouble({ value: Number.MAX_VALUE }), true);
    assert.equal(stream.serializeCompressedFloat({ value: 1 }, 0, 1, 0.1), true);
    assert.equal(stream.serializeString({ value: 'abc\u{1F680}' }, 8), true);
    assert.equal(stream.serializeString({ value: 'abc' }, 4), true);
    assert.equal(stream.error, SerializeError.None);
  }
});

test('U9: reject on a write or a measure is misuse and throws in the checked build', () => {
  for (const stream of both()) {
    assert.throws(() => stream.reject(), TypeError);
  }
});

test('U5: int bounds outside int32 throw on write and measure', () => {
  for (const stream of both()) {
    assert.throws(() => stream.serializeInt({ value: 0 }, 0, 2 ** 31), RangeError);
    assert.throws(() => stream.serializeInt({ value: 0 }, 0, 0xffffffff), RangeError);
    assert.throws(() => stream.serializeInt({ value: 0 }, -(2 ** 31) - 1, 0), RangeError);
    assert.doesNotThrow(() => stream.serializeInt({ value: 0 }, -(2 ** 31), 2 ** 31 - 1));
  }
});

test('U16: precomputed constants the params cannot derive throw on write and measure', () => {
  const bad = [
    [1000, 11, 10, 0],
    [0, 1, 10, 0],
    [4294967295, 32, 10, 0],
    [1000, 10, -10, 0],
    [1000, 10, Infinity, 0],
    [1000, 10, 10, NaN],
  ];
  for (const [maxIntegerValue, bits, delta, min] of bad) {
    for (const stream of both()) {
      assert.throws(() => stream.serializeCompressedFloatPrecomputed({ value: 0 }, maxIntegerValue, bits, delta, min), RangeError);
      assert.equal(stream.bitsProcessed(), 0);
    }
  }
  // the top decode, min + delta, must be finite on write and measure
  for (const stream of both()) {
    assert.throws(() => stream.serializeCompressedFloatPrecomputed({ value: 0 }, 1, 1, 3.4e38, 3.4e38), RangeError);
    assert.equal(stream.serializeCompressedFloatPrecomputed({ value: 0 }, 1000, 10, 10, 0), true);
  }
});
