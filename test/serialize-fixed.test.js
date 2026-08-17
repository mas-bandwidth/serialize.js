// serializeFixed tests: the Q-format fixed point value (STANDARD.md
// "fixed"). ref.value is the RAW scaled integer -- the real value times
// 2^fractionBits -- in storage of exactly integerBits + fractionBits bits;
// min and max are whole-unit bounds, part of the message format. The wire
// is the offset from min << fractionBits in exactly the bit length of the
// raw range: for storage of 64 bits or fewer, byte identical to
// serializeInt64 of the raw value over the raw bounds, and the round trip
// is EXACT at every width. The configuration matrix and its value shapes
// are serialize.h's own (test_serialize_fixed / test_serialize_fixed_wide /
// check_fixed_cases), the bit-cost pins are the reference's pinned
// constants (34/17/16 narrow, 78/128/54/33/64 wide), and every pinned byte
// vector was produced by the canonical serialize.h itself
// (serialize_fixed_internal over a WriteStream) -- the same probe method as
// the compressed-float and int_relative pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  bitsRequired,
  bitsRequired128,
} from '../src/index.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Writes the raw value over the declaration, reads it back over the same
// declaration, and checks all three streams agree on the exact bit cost.
function roundTrip(value, integerBits, fractionBits, min, max, bits) {
  const label = `${value} in Q${integerBits}.${fractionBits} [${min},${max}]`;

  const writer = new WriteStream(new Uint8Array(24));
  assert.equal(writer.serializeFixed({ value }, integerBits, fractionBits, min, max), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeFixed(ref, integerBits, fractionBits, min, max), true, `read ${label}`);
  assert.equal(ref.value, value, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeFixed({ value }, integerBits, fractionBits, min, max), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);
}

// The check_fixed_cases value shapes on the narrow (Number) lane: exact raw
// bounds, one raw step inside each, the middle of the range, zero and
// +-1.0 units where the bounds allow them, and all fraction bits set.
function narrowCases(integerBits, fractionBits, min, max) {
  const scale = 2 ** fractionBits;
  const rawMin = min * scale;
  const rawMax = max * scale;
  const rawRange = rawMax - rawMin;
  const bits = bitsRequired(0, rawRange);
  const candidates = [
    rawMin,
    rawMin + 1,
    rawMax - 1,
    rawMax,
    rawMin + Math.floor(rawRange / 2),
    0,
    scale,
    -scale,
    rawMin + scale - 1, // all fraction bits set over the minimum
  ];
  for (const value of candidates) {
    if (value >= rawMin && value <= rawMax) {
      roundTrip(value, integerBits, fractionBits, min, max, bits);
    }
  }
}

// The same value shapes on the wide (BigInt) lane.
function wideCases(integerBits, fractionBits, min, max) {
  const scale = 1n << BigInt(fractionBits);
  const rawMin = min * scale;
  const rawMax = max * scale;
  const rawRange = rawMax - rawMin;
  const bits = rawRange === 0n ? 0 : bitsRequired128(0n, rawRange);
  const candidates = [
    rawMin,
    rawMin + 1n,
    rawMax - 1n,
    rawMax,
    rawMin + rawRange / 2n,
    0n,
    scale,
    -scale,
    rawMin + scale - 1n, // all fraction bits set over the minimum
  ];
  for (const value of candidates) {
    if (value >= rawMin && value <= rawMax) {
      roundTrip(value, integerBits, fractionBits, min, max, bits);
    }
  }
}

test('the narrow matrix: every Q format of 32 bits or fewer round trips exactly', () => {
  // serialize.h's own storage x Q format matrix, the <= 32 bit rows
  narrowCases(8, 8, -100, 100);
  narrowCases(12, 4, -2000, 2000);
  narrowCases(16, 16, -30000, 30000);
  narrowCases(24, 8, -8000000, 8000000);
  narrowCases(32, 0, -100000, 100000); // pure integer Q: fractionBits 0 is legal
  narrowCases(16, 0, 0, 60000); // unsigned reading
  narrowCases(16, 16, 0, 60000); // unsigned reading past the signed capacity
  narrowCases(16, 16, 0, 1); // single unit range: the wire is the fraction
});

test('the 64-bit matrix: two-group offsets in the BigInt domain', () => {
  wideCases(48, 16, -100000000000n, 100000000000n);
  wideCases(32, 32, -1000000n, 1000000n);
  wideCases(64, 0, -5000000000n, 5000000000n); // pure integer Q at full width
  wideCases(48, 16, 0n, 1000000000n); // unsigned reading
  wideCases(48, 16, -3n, 100000n); // asymmetric bounds
  wideCases(16, 48, 0n, 60000n); // unsigned: the raw top is past INT64_MAX
});

test('the wide matrix: 128-bit storage in up to four groups', () => {
  wideCases(112, 16, -1152921504606846976n, 1152921504606846976n); // +-2^60 units
  wideCases(112, 16, -2n, 2n); // a single group on wide storage
  wideCases(64, 64, -1000n, 1000n); // the fraction alone spans 64 bits
  wideCases(64, 64, INT64_MIN, INT64_MAX); // full unit range: 128 bits
  wideCases(112, 16, 0n, 2305843009213693952n); // 2^61 units, unsigned
  wideCases(112, 16, -32768n, 32768n); // 33 bits: the two-group band's low edge
  wideCases(112, 16, -100000000000n, 100000000000n); // 54 bits: the example's shape
  wideCases(112, 16, -140737488355328n, 140737488355327n); // 64 bits: the band's high edge
});

test('the wire cost is a constant of the declaration: the reference pins', () => {
  // serialize.h's pinned bit counts, narrow and wide
  const pins = [
    [12345n * 65536n + 32768n, 48, 16, -100000n, 100000n, 34], // 12345.5 in Q48.16
    [65536 / 2, 16, 16, 0, 1, 17], // 0.5 in Q16.16
    [-832, 8, 8, -100, 100, 16], // -3.25 in Q8.8
    [12345n * 65536n, 112, 16, -1152921504606846976n, 1152921504606846976n, 78],
    [0n, 64, 64, INT64_MIN, INT64_MAX, 128], // the full unit range costs the full width
    [12345678901n * 65536n, 112, 16, -100000000000n, 100000000000n, 54],
    [0n, 112, 16, -32768n, 32768n, 33],
    [0n, 112, 16, -140737488355328n, 140737488355327n, 64],
  ];
  for (const [value, integerBits, fractionBits, min, max, bits] of pins) {
    const writer = new WriteStream(new Uint8Array(24));
    assert.equal(writer.serializeFixed({ value }, integerBits, fractionBits, min, max), true);
    assert.equal(writer.bitsProcessed(), bits, `Q${integerBits}.${fractionBits} [${min},${max}]`);
  }
});

test('pinned wire bytes: narrow, two-group, unsigned and four-group, from the reference', () => {
  // each vector: [value, integerBits, fractionBits, min, max, bits, bytes]
  // produced by serialize.h's serialize_fixed_internal itself
  const vectors = [
    [-832, 8, 8, -100, 100, 16, [0xc0, 0x60]], // -3.25 in Q8.8
    [-30000 * 65536, 16, 16, -30000, 30000, 32, [0x00, 0x00, 0x00, 0x00]], // the raw minimum
    [60000 * 65536, 16, 16, 0, 60000, 32, [0x00, 0x00, 0x60, 0xea]], // unsigned Q16.16 top
    [12345n * 65536n + 32768n, 48, 16, -100000n, 100000n, 34,
      [0x00, 0x80, 0xd9, 0xb6, 0x01]], // 12345.5 in Q48.16
    [12345678901n * 65536n, 112, 16, -100000000000n, 100000000000n, 54,
      [0x00, 0x00, 0x35, 0x04, 0x53, 0x28, 0x1a]], // three-group band
    [1n << 64n, 64, 64, INT64_MIN, INT64_MAX, 128,
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80]], // +1.0 in Q64.64, four groups
  ];
  for (const [value, integerBits, fractionBits, min, max, bits, bytes] of vectors) {
    const writer = new WriteStream(new Uint8Array(24));
    assert.equal(writer.serializeFixed({ value }, integerBits, fractionBits, min, max), true);
    assert.equal(writer.bitsProcessed(), bits);
    writer.flush();
    assert.deepEqual(
      Array.from(writer.data()),
      bytes,
      `bytes of Q${integerBits}.${fractionBits} [${min},${max}] ${value}`,
    );

    // and the pinned bytes decode back to the exact raw value
    const reader = new ReadStream(Uint8Array.from(bytes));
    const ref = {};
    assert.equal(reader.serializeFixed(ref, integerBits, fractionBits, min, max), true);
    assert.equal(ref.value, value);
  }
});

test('for storage of 64 bits or fewer the wire is identical to serializeInt64 of the raw value', () => {
  // serialize.h's equivalence sweep: fixed point adds no wire structure,
  // only the scaling convention. Q64.0 binds the wide lane to the proven
  // ranged integer (> 32 bit range, the two group path).
  for (const value of [-5000000000n, -4999999999n, -1n, 0n, 1n, 12345678n, 4999999999n, 5000000000n]) {
    const fixed = new WriteStream(new Uint8Array(16));
    assert.equal(fixed.serializeFixed({ value }, 64, 0, -5000000000n, 5000000000n), true);
    fixed.flush();

    const int64 = new WriteStream(new Uint8Array(16));
    assert.equal(int64.serializeInt64({ value }, -5000000000n, 5000000000n), true);
    int64.flush();

    assert.equal(fixed.bitsProcessed(), int64.bitsProcessed());
    assert.deepEqual(Array.from(fixed.data()), Array.from(int64.data()), `wire of ${value}`);
  }

  // the narrow (Number) lane binds across the domain change: the same raw
  // value as a BigInt over the raw bounds produces the same bytes. Q32.0 is
  // the reference's single-group sweep, Q16.16 shows the equivalence is not
  // limited to fractionBits 0.
  const narrowSweeps = [
    // [values (raw), integerBits, fractionBits, min, max]
    [[-100000, -99999, -1, 0, 1, 54321, 99999, 100000], 32, 0, -100000, 100000],
    [[-30000 * 65536, -(3 * 65536 + 16384), 0, 65536 / 2, 12345 * 65536 + 1, 30000 * 65536],
      16, 16, -30000, 30000],
  ];
  for (const [values, integerBits, fractionBits, min, max] of narrowSweeps) {
    const scale = 2 ** fractionBits;
    for (const value of values) {
      const fixed = new WriteStream(new Uint8Array(16));
      assert.equal(fixed.serializeFixed({ value }, integerBits, fractionBits, min, max), true);
      fixed.flush();

      const int64 = new WriteStream(new Uint8Array(16));
      assert.equal(
        int64.serializeInt64({ value: BigInt(value) }, BigInt(min * scale), BigInt(max * scale)),
        true,
      );
      int64.flush();

      assert.equal(fixed.bitsProcessed(), int64.bitsProcessed());
      assert.deepEqual(Array.from(fixed.data()), Array.from(int64.data()), `wire of ${value}`);
    }
  }
});

test('degenerate min == max costs zero bits on EVERY storage width', () => {
  // serialize.h test_serialize_fixed_degenerate: narrow, negative wide,
  // and the 128-bit path that used to cost fractionBits zeros in ports
  const configs = [
    [16, 16, 5, 5, 5 * 65536], // 5.0 in Q16.16
    [48, 16, -7n, -7n, -7n * 65536n], // -7.0 in Q48.16: a negative raw min
    [112, 16, 9n, 9n, 9n * 65536n], // 9.0 in Q112.16: zero bits, NOT fractionBits
  ];
  for (const [integerBits, fractionBits, min, max, pinned] of configs) {
    const label = `Q${integerBits}.${fractionBits} [${min},${max}]`;

    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(writer.serializeFixed({ value: pinned }, integerBits, fractionBits, min, max), true);
    assert.equal(writer.bitsProcessed(), 0, `${label} writes nothing`);
    // and the NEXT field starts at bit 0, exactly as serialize.h pins it
    assert.equal(writer.serializeInt({ value: 3 }, 0, 7), true);
    assert.equal(writer.bitsProcessed(), 3);
    writer.flush();

    const reader = new ReadStream(writer.data());
    const degenerate = {};
    const after = {};
    assert.equal(reader.serializeFixed(degenerate, integerBits, fractionBits, min, max), true);
    assert.equal(degenerate.value, pinned, `${label} recovered from the range`);
    assert.equal(reader.bitsProcessed(), 0);
    assert.equal(reader.serializeInt(after, 0, 7), true);
    assert.equal(after.value, 3);

    const measure = new MeasureStream();
    assert.equal(measure.serializeFixed({ value: pinned }, integerBits, fractionBits, min, max), true);
    assert.equal(measure.bitsProcessed(), 0, `${label} measures nothing`);
  }
});
