// serializeInt tests: the format's defining operation. Round trips at the
// boundary values of every range shape, the degenerate zero-bit range, and
// pinned wire bytes. Bit costs in the comments are cross-checked against
// serialize.h's bits_required arithmetic:
//
//     bits_required( min, max ) = ( min == max ) ? 0 : 32 - __builtin_clz( max - min )

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
  bitsRequired,
} from '../src/index.js';

// Writes value over [min,max], reads it back over the same range, and
// checks both directions cost exactly bitsRequired bits.
function roundTrip(value, min, max) {
  const label = `${value} in [${min},${max}]`;
  const bits = bitsRequired(min >>> 0, max >>> 0);

  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value }, min, max), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeInt(ref, min, max), true, `read ${label}`);
  assert.equal(ref.value, value, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeInt({ value }, min, max), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);
}

test('boundary values round trip at every range shape', () => {
  // one bit: bits_required(0,1) = 1
  roundTrip(0, 0, 1);
  roundTrip(1, 0, 1);

  // the STANDARD's examples: [0,7] is 3 bits, [0,8] is 4
  roundTrip(0, 0, 7);
  roundTrip(7, 0, 7);
  roundTrip(8, 0, 8);

  // offset range: diff 7 -> 3 bits regardless of the endpoints
  roundTrip(100, 100, 107);
  roundTrip(107, 100, 107);

  // mixed-sign: [-5,5] has diff 10 -> 4 bits
  roundTrip(-5, -5, 5);
  roundTrip(0, -5, 5);
  roundTrip(5, -5, 5);

  // int8-shaped: diff 255 -> 8 bits
  roundTrip(-128, -128, 127);
  roundTrip(-1, -128, 127);
  roundTrip(127, -128, 127);

  // high positive and low negative corners: diff 7 -> 3 bits
  roundTrip(2147483640, 2147483640, 2147483647);
  roundTrip(2147483647, 2147483640, 2147483647);
  roundTrip(-2147483648, -2147483648, -2147483641);
  roundTrip(-2147483641, -2147483648, -2147483641);

  // full-range int32: diff 0xFFFFFFFF -> all 32 bits
  roundTrip(-2147483648, -2147483648, 2147483647);
  roundTrip(-1, -2147483648, 2147483647);
  roundTrip(0, -2147483648, 2147483647);
  roundTrip(2147483647, -2147483648, 2147483647);
});

test('degenerate min == max costs zero bits everywhere', () => {
  for (const pinned of [42, 0, -1, -2147483648, 2147483647]) {
    // write: succeeds writing NOTHING
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeInt({ value: pinned }, pinned, pinned), true);
    assert.equal(writer.bitsProcessed(), 0);
    writer.flush();
    assert.equal(writer.data().length, 0);

    // read: the value materializes from the range alone -- even from a
    // completely EMPTY buffer, because zero bits are read
    const reader = new ReadStream(new Uint8Array(0));
    const ref = {};
    assert.equal(reader.serializeInt(ref, pinned, pinned), true);
    assert.equal(ref.value, pinned);
    assert.equal(reader.bitsProcessed(), 0);
    assert.equal(reader.ok, true);

    // measure: zero bits
    const measure = new MeasureStream();
    assert.equal(measure.serializeInt({ value: pinned }, pinned, pinned), true);
    assert.equal(measure.bitsProcessed(), 0);
  }
});

test('a zero-bit field between real fields leaves the wire identical', () => {
  // STANDARD.md: "min == max writes nothing at all" -- so inserting a
  // degenerate field must not move a single bit of the surrounding wire.
  const withField = new WriteStream(new Uint8Array(8));
  withField.serializeInt({ value: 13 }, 0, 15);
  withField.serializeInt({ value: 7 }, 7, 7); // zero bits
  withField.serializeInt({ value: 200 }, 0, 255);
  withField.flush();

  const without = new WriteStream(new Uint8Array(8));
  without.serializeInt({ value: 13 }, 0, 15);
  without.serializeInt({ value: 200 }, 0, 255);
  without.flush();

  assert.equal(withField.bitsProcessed(), 12);
  assert.equal(without.bitsProcessed(), 12);
  assert.deepEqual(Array.from(withField.data()), Array.from(without.data()));
});

test('pinned wire bytes: a mixed ranged sequence', () => {
  // a = 3 in [0,7]:      3 bits, raw offset 3
  // b = -2 in [-5,5]:    4 bits, raw offset -2 - -5 = 3
  // c = 100 in [100,107]: 3 bits, raw offset 0
  // LSB-first bit stream: bits 0..2 = 011, bits 3..6 = 0011, bits 7..9 = 000
  // byte 0 = 1 + 2 + 8 + 16 = 0x1B, byte 1 = 0x00
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 3 }, 0, 7), true);
  assert.equal(writer.serializeInt({ value: -2 }, -5, 5), true);
  assert.equal(writer.serializeInt({ value: 100 }, 100, 107), true);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 10);
  assert.deepEqual(Array.from(writer.data()), [0x1b, 0x00]);

  const reader = new ReadStream(writer.data());
  const a = {};
  const b = {};
  const c = {};
  assert.equal(reader.serializeInt(a, 0, 7), true);
  assert.equal(reader.serializeInt(b, -5, 5), true);
  assert.equal(reader.serializeInt(c, 100, 107), true);
  assert.equal(a.value, 3);
  assert.equal(b.value, -2);
  assert.equal(c.value, 100);
});

test('pinned wire bytes: full-range int32 is the unsigned offset from -2^31', () => {
  // value -1 -> offset 0xFFFFFFFF - 0x80000000 = 0x7FFFFFFF -> FF FF FF 7F
  // value  0 -> offset 0x00000000 - 0x80000000 = 0x80000000 -> 00 00 00 80
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: -1 }, -2147483648, 2147483647), true);
  assert.equal(writer.serializeInt({ value: 0 }, -2147483648, 2147483647), true);
  writer.flush();
  assert.deepEqual(
    Array.from(writer.data()),
    [0xff, 0xff, 0xff, 0x7f, 0x00, 0x00, 0x00, 0x80],
  );

  const reader = new ReadStream(writer.data());
  const x = {};
  const y = {};
  assert.equal(reader.serializeInt(x, -2147483648, 2147483647), true);
  assert.equal(reader.serializeInt(y, -2147483648, 2147483647), true);
  assert.equal(x.value, -1);
  assert.equal(y.value, 0);
});

test('an invalid range is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    // min above max
    assert.throws(() => stream.serializeInt({ value: 0 }, 5, 4), RangeError);
    // bounds outside the int32 domain
    assert.throws(() => stream.serializeInt({ value: 0 }, 0, 2147483648), RangeError);
    assert.throws(() => stream.serializeInt({ value: 0 }, -2147483649, 0), RangeError);
    assert.throws(() => stream.serializeInt({ value: 0 }, 0.5, 10), RangeError);
    assert.throws(() => stream.serializeInt({ value: 0 }, 0, NaN), RangeError);
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

test('a non-number value on write or measure is caller misuse and throws', () => {
  // matches the serializeBits precedent: the wrong TYPE is a bug in the
  // calling code (a compile error in the rest of the family), not data
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeInt({ value: '3' }, 0, 7), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeInt({ value: null }, 0, 7), TypeError);
});
