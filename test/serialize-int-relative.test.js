// serializeIntRelative tests: the flag-ladder relative integer
// (STANDARD.md "int_relative"). A difference of 1 costs a single bit, the
// payload tiers cost 5/8/13/18/23 bits, and past the last tier six zero
// flags carry current itself as 32 raw bits -- 38 bits, the ABSOLUTE form.
// The semantics are pinned: strictly increasing, no wrapping (STANDARD.md,
// adopted 2026-08-15), over the domain 0 to 2^31 - 1 inclusive
// (STANDARD.md, adopted 2026-09-04). Every pinned byte vector below was
// produced by the C++ implementation itself
// (serialize_int_relative_internal over a WriteStream, uint32_t
// instantiation) -- the same probe method as the compressed-float pins.
//
// Reconstruction happens in a width that cannot wrap and is then checked
// against the domain in EVERY tier; the shared corpus
// (test/conformance.test.js) carries the accept/refuse twins for each one.

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

test('the domain is exact to its edges', () => {
  // the domain is 0 to 2^31 - 1 inclusive (STANDARD.md, adopted
  // 2026-09-04): both endpoints legal, nothing above
  roundTrip(0, 1, 1); // the smallest legal pair
  roundTrip(0, 0x7fffffff, 38); // the full span: absolute tier
  roundTrip(0x7ffffffe, 0x7fffffff, 1); // difference 1 at the domain top
  roundTrip(0x7fffffff - 69914, 0x7fffffff, 23); // the last bounded tier, at the top
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
    // the domain maximum through the absolute tier: the same bytes as the
    // corpus's absolute-accept-domain-maximum vector
    [0, 0x7fffffff, 38, [0xc0, 0xff, 0xff, 0xff, 0x1f]],
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

test('every tier reconstructs without wrapping and refuses past the domain', () => {
  // The domain rule (STANDARD.md, adopted 2026-09-04): reconstruct in a
  // width that cannot wrap, then refuse anything above 2^31 - 1. Read each
  // tier's bytes against a previous whose reconstruction leaves the
  // domain, and against the previous one step inside it -- the same bytes,
  // so a reader that judged the bytes rather than the reconstructed value
  // would pass one and fail the other.
  const tiers = [
    // [difference, consumed]
    [1, 1],
    [2, 5],
    [7, 8],
    [24, 13],
    [281, 18],
    [4378, 23],
  ];
  for (const [difference, consumed] of tiers) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeIntRelative(10, { value: 10 + difference }), true);
    writer.flush();
    const bytes = writer.data();

    // one past the domain top: refused, and the destination untouched
    const past = new ReadStream(bytes);
    const refused = { value: -1 };
    assert.equal(past.serializeIntRelative(0x7fffffff, refused), false, `refuse difference ${difference}`);
    assert.equal(refused.value, -1, 'a refused read leaves the ref unmodified');

    // the accept twin, sharing those bytes: the reconstruction lands
    // exactly on the domain top
    const inside = new ReadStream(bytes);
    const accepted = {};
    assert.equal(inside.serializeIntRelative(0x7fffffff - difference, accepted), true);
    assert.equal(accepted.value, 0x7fffffff, `difference ${difference} at the domain top`);
    assert.equal(inside.bitsProcessed(), consumed);
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
