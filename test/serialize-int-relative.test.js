// serializeIntRelative tests: the flag-ladder relative integer
// (STANDARD.md "int_relative"). A difference of 1 costs a single bit, the
// payload tiers cost 5/8/13/18/23 bits, and past the last tier six zero
// flags carry current itself as 32 raw bits -- 38 bits, the ABSOLUTE form.
// The semantics are pinned: strictly increasing in the unsigned 32-bit
// domain, no wrapping (STANDARD.md, adopted 2026-08-15). Every pinned byte
// vector below was produced by the canonical serialize.h reference itself
// (serialize_int_relative_internal over a WriteStream, uint32_t
// instantiation) -- the same probe method as the compressed-float pins.
//
// Wrap-mirror cases follow serialize.h's own read-side reconstruction test
// (test_int_relative_validation): a payload tier reconstructs
// previous + difference mod 2^32, exactly the reference's uint32 arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, ReadStream, MeasureStream } from '../src/index.js';

// Writes current relative to previous, reads it back, and checks all three
// streams agree on the exact tier cost.
function roundTrip(previous, current, bits) {
  const label = `${current} after ${previous}`;

  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeIntRelative(previous, { value: current }), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeIntRelative(previous, ref), true, `read ${label}`);
  assert.equal(ref.value, current, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeIntRelative(previous, { value: current }), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);
}

test('every tier round trips at its exact bit cost', () => {
  // one representative per tier, previous = 100
  roundTrip(100, 101, 1); // difference 1: a single bit
  roundTrip(100, 105, 5); // 2..6
  roundTrip(100, 120, 8); // 7..23
  roundTrip(100, 300, 13); // 24..280
  roundTrip(100, 1000, 18); // 281..4377
  roundTrip(100, 10000, 23); // 4378..69914
  roundTrip(100, 100000, 38); // past the ladder: absolute, 32 raw bits
});

test('tier edges: each boundary difference lands in its own tier', () => {
  // both sides of every tier boundary, previous = 100
  roundTrip(100, 102, 5); // difference 2: the second tier's low edge
  roundTrip(100, 106, 5); // 6: its high edge
  roundTrip(100, 107, 8); // 7
  roundTrip(100, 123, 8); // 23
  roundTrip(100, 124, 13); // 24
  roundTrip(100, 380, 13); // 280
  roundTrip(100, 381, 18); // 281
  roundTrip(100, 4477, 18); // 4377
  roundTrip(100, 4478, 23); // 4378
  roundTrip(100, 70014, 23); // 69914
  roundTrip(100, 70015, 38); // 69915: the first difference past the ladder
});

test('the unsigned 32-bit domain is exact to its edges', () => {
  roundTrip(0, 1, 1); // the smallest legal pair
  roundTrip(0, 0xffffffff, 38); // the full span: absolute tier
  roundTrip(0xfffffffe, 0xffffffff, 1); // difference 1 at the very top
  roundTrip(0x7fffffff, 0x80000000, 1); // across the int32 sign boundary
  roundTrip(0, 69915, 38); // gap wider than every payload tier
});

test('pinned wire bytes: every tier, from the reference implementation', () => {
  // each vector: [previous, current, bits, bytes...] produced by
  // serialize.h's serialize_int_relative_internal (uint32_t) itself
  const vectors = [
    [100, 101, 1, [0x01]],
    [100, 105, 5, [0x0e]],
    [100, 120, 8, [0x6c]],
    [100, 300, 13, [0x08, 0x0b]],
    [100, 1000, 18, [0x70, 0x4d, 0x00]],
    [100, 10000, 23, [0xa0, 0x64, 0x05]],
    [100, 100000, 38, [0x00, 0xa8, 0x61, 0x00, 0x00]],
    [0, 0xffffffff, 38, [0xc0, 0xff, 0xff, 0xff, 0x3f]],
  ];
  for (const [previous, current, bits, bytes] of vectors) {
    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(writer.serializeIntRelative(previous, { value: current }), true);
    assert.equal(writer.bitsProcessed(), bits, `bits of ${current} after ${previous}`);
    writer.flush();
    assert.deepEqual(
      Array.from(writer.data()),
      bytes,
      `bytes of ${current} after ${previous}`,
    );

    // and the pinned bytes decode back to the exact value
    const reader = new ReadStream(Uint8Array.from(bytes));
    const ref = {};
    assert.equal(reader.serializeIntRelative(previous, ref), true);
    assert.equal(ref.value, current);
  }
});

test('the reference validation round trip: 100 to 100000 takes the absolute tier', () => {
  // serialize.h test_int_relative_validation's legitimate fallback case
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeIntRelative(100, { value: 100000 }), true);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeIntRelative(100, ref), true);
  assert.equal(ref.value, 100000);
});

test('payload tiers reconstruct in the unsigned domain and wrap mod 2^32', () => {
  // serialize.h's own read-side reconstruction test, at the uint32 top:
  // write differences 1 and 5 from previous 10, read them back against
  // previous 0xFFFFFFFF -- the reference wraps, and so does this port.
  // (A conforming writer can never produce these pairs; the wrap is the
  // reader mirroring the reference's uint32 arithmetic, not a wrapping
  // sequence semantic -- STANDARD.md pins that none exists.)
  const cases = [
    [1, 0], // 0xFFFFFFFF + 1 wraps to 0
    [5, 4], // 0xFFFFFFFF + 5 wraps to 4
  ];
  for (const [difference, expected] of cases) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeIntRelative(10, { value: 10 + difference }), true);
    writer.flush();

    const reader = new ReadStream(writer.data());
    const ref = {};
    assert.equal(reader.serializeIntRelative(0xffffffff, ref), true);
    assert.equal(ref.value, expected, `wrap of difference ${difference}`);
  }
});

test('sequence use: consecutive values cost one bit each', () => {
  // the common case for sequence numbers: a run of +1 steps
  const writer = new WriteStream(new Uint8Array(8));
  let previous = 1000;
  for (let i = 0; i < 16; i++) {
    assert.equal(writer.serializeIntRelative(previous, { value: previous + 1 }), true);
    previous += 1;
  }
  assert.equal(writer.bitsProcessed(), 16);
  writer.flush();

  const reader = new ReadStream(writer.data());
  previous = 1000;
  for (let i = 0; i < 16; i++) {
    const ref = {};
    assert.equal(reader.serializeIntRelative(previous, ref), true);
    assert.equal(ref.value, previous + 1);
    previous = ref.value;
  }
});
