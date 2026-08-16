// serializeInt128 tests: the ranged 128-bit integer. Bit costs follow
// serialize.h's bits_required128 over the unsigned 128-bit domain, so
// ranges wider than 2^127 are exact; the offset goes out in 32-bit groups,
// least significant first, up to four groups (STANDARD.md "int128
// (ranged)"). The value sets are serialize.h's own (test_serialize_int128),
// and the golden pin's bytes were derived from STANDARD.md's stated rule --
// the three-group structure over bounds of +/- 2^70.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  bitsRequired128,
} from '../src/index.js';

const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

// Writes value over [min,max], reads it back over the same range, and
// checks both directions cost exactly bitsRequired128 bits.
function roundTrip(value, min, max) {
  const label = `${value} in [${min},${max}]`;
  const bits = bitsRequired128(BigInt.asUintN(128, min), BigInt.asUintN(128, max));

  const writer = new WriteStream(new Uint8Array(24));
  assert.equal(writer.serializeInt128({ value }, min, max), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeInt128(ref, min, max), true, `read ${label}`);
  assert.equal(ref.value, value, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeInt128({ value }, min, max), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);
}

test('every group structure round trips: one to four groups', () => {
  // one group: [0,200] is 8 bits
  roundTrip(0n, 0n, 200n);
  roundTrip(200n, 0n, 200n);

  // two groups: [-5000000000, 5000000000] is 34 bits
  roundTrip(-5000000000n, -5000000000n, 5000000000n);
  roundTrip(4123456789n, -5000000000n, 5000000000n);

  // three groups: [-2^70, 2^70] is 72 bits -- 32, 32, then 8
  roundTrip(-(2n ** 70n), -(2n ** 70n), 2n ** 70n);
  roundTrip(0n, -(2n ** 70n), 2n ** 70n);
  roundTrip(2n ** 70n, -(2n ** 70n), 2n ** 70n);

  // four groups: [-2^100, 2^100] is 102 bits -- 32, 32, 32, then 6
  roundTrip(-(2n ** 100n), -(2n ** 100n), 2n ** 100n);
  roundTrip(2n ** 100n, -(2n ** 100n), 2n ** 100n);
});

test('the wide bands the 64-bit path cannot express at all', () => {
  // serialize.h's own values for [-2^100, 2^100]: 102 bits
  const min = -(2n ** 100n);
  const max = 2n ** 100n;
  for (const value of [min, min + 1n, -1n, 0n, 1n, 2n ** 99n, max - 1n, max]) {
    roundTrip(value, min, max);
  }
});

test('the full int128 range is exact: wider than 2^127 in the unsigned domain', () => {
  // every group full, and the range subtraction would overflow if signed
  const values = [
    INT128_MIN,
    INT128_MIN + 1n,
    -1n,
    0n,
    1n,
    INT128_MAX - 1n,
    INT128_MAX,
  ];
  for (const value of values) {
    roundTrip(value, INT128_MIN, INT128_MAX);
  }
});

test('boundary values round trip at the 2^63 and 2^127 edges', () => {
  // [0, 2^63]: 64 bits -- the widest two-group range
  roundTrip(2n ** 63n, 0n, 2n ** 63n);
  // [0, 2^64]: 65 bits -- the first range needing the third group
  roundTrip(2n ** 64n, 0n, 2n ** 64n);
  roundTrip(2n ** 64n - 1n, 0n, 2n ** 64n);
  // [0, 2^96]: 97 bits -- the first range needing the fourth group
  roundTrip(2n ** 96n, 0n, 2n ** 96n);
  // [0, 2^127 - 1]: 127 bits -- the widest range with a zero minimum the
  // int128 domain can express (2^127 itself is outside int128)
  roundTrip(2n ** 127n - 1n, 0n, INT128_MAX);
  roundTrip(0n, 0n, INT128_MAX);
});

test('wire identity with serializeInt64 wherever the range fits 64 bits', () => {
  // STANDARD.md: a field may be widened from 64 to 128 bits without
  // changing the wire -- pinned by byte comparison, not assumed
  const min = -5000000000n;
  const max = 5000000000n;
  for (const value of [min, min + 1n, -1n, 0n, 1n, 4123456789n, max - 1n, max]) {
    const w128 = new WriteStream(new Uint8Array(24));
    assert.equal(w128.serializeInt128({ value }, min, max), true);
    w128.flush();

    const w64 = new WriteStream(new Uint8Array(24));
    assert.equal(w64.serializeInt64({ value }, min, max), true);
    w64.flush();

    assert.equal(w128.bitsProcessed(), w64.bitsProcessed());
    assert.deepEqual(Array.from(w128.data()), Array.from(w64.data()));

    const reader = new ReadStream(w64.data()); // read the 64-bit wire as 128
    const ref = {};
    assert.equal(reader.serializeInt128(ref, min, max), true);
    assert.equal(ref.value, value);
  }
});

test('degenerate min == max costs zero bits everywhere', () => {
  // STANDARD.md's adopted ruling: zero bits on EVERY storage width. The
  // point is wider than 2^64 so the field would take a three-group path if
  // it took any path at all.
  const point = 2n ** 100n;
  for (const pinned of [point, 0n, -1n, INT128_MIN, INT128_MAX]) {
    const writer = new WriteStream(new Uint8Array(24));
    assert.equal(writer.serializeInt128({ value: pinned }, pinned, pinned), true);
    assert.equal(writer.bitsProcessed(), 0);
    writer.flush();
    assert.equal(writer.data().length, 0);

    const reader = new ReadStream(new Uint8Array(0));
    const ref = {};
    assert.equal(reader.serializeInt128(ref, pinned, pinned), true);
    assert.equal(ref.value, pinned);
    assert.equal(reader.bitsProcessed(), 0);

    const measure = new MeasureStream();
    assert.equal(measure.serializeInt128({ value: pinned }, pinned, pinned), true);
    assert.equal(measure.bitsProcessed(), 0);
  }
});

test('the golden pin: three groups over +/- 2^70, bytes from the standard', () => {
  // serialize.h's golden vector: value -0x0123456789ABCDEF in
  // [-2^70, 2^70] is 72 bits. offset = 2^70 - 0x0123456789ABCDEF
  //   = 0x3F_FEDCBA98_76543211: groups 0x76543211, 0xFEDCBA98, then 0x3F
  //   in the 8 remaining bits.
  const goldenBytes = [
    0x11, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe, 0x3f,
  ];
  const min = -(2n ** 70n);
  const max = 2n ** 70n;
  const value = -0x0123456789abcdefn;

  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeInt128({ value }, min, max), true);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 72);
  assert.deepEqual(Array.from(writer.data()), goldenBytes);

  const reader = new ReadStream(Uint8Array.from(goldenBytes));
  const ref = {};
  assert.equal(reader.serializeInt128(ref, min, max), true);
  assert.equal(ref.value, value);
});

test('an invalid range is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(24));
  const reader = new ReadStream(new Uint8Array(24));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    // min above max
    assert.throws(() => stream.serializeInt128({ value: 0n }, 5n, 4n), RangeError);
    // bounds outside the int128 domain
    assert.throws(
      () => stream.serializeInt128({ value: 0n }, 0n, 2n ** 127n),
      RangeError,
    );
    assert.throws(
      () => stream.serializeInt128({ value: 0n }, -(2n ** 127n) - 1n, 0n),
      RangeError,
    );
    // Number bounds: the 128-bit domain is BigInt
    assert.throws(() => stream.serializeInt128({ value: 0n }, 0, 100), RangeError);
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

test('a non-BigInt value on write or measure is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(24));
  assert.throws(() => writer.serializeInt128({ value: 3 }, 0n, 7n), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeInt128({ value: null }, 0n, 7n), TypeError);
});
