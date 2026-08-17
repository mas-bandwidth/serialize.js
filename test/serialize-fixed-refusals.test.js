// serializeFixed refusals, proven both ways: every doctored vector that
// must latch sits beside its accept-boundary neighbor. The read-side
// smuggling refusal mirrors serialize.h's test_serialize_fixed_validation
// and check_fixed_wide_rejects_out_of_range: an offset of exactly
// raw_range + 1 -- one raw step past raw_max, hidden in the bit headroom of
// the offset encoding -- must latch ValueOutOfRange (reject, never clamp),
// while raw_range itself decodes to raw_max. Write-side range violations
// are latched errors in every build (the checked runtime's form of the
// reference's debug asserts), and an invalid declaration -- the JS
// translation of the reference's static asserts -- throws as caller misuse
// on every stream in every state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
  bitsRequired128,
} from '../src/index.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Hand-builds a stream encoding the given offset in the given bit count,
// split into 32-bit groups least significant first -- the same splitting
// the codec uses, so the doctored offset lands exactly where the reader
// looks.
function offsetBytes(offset, bits) {
  const writer = new WriteStream(new Uint8Array(24));
  let remaining = bits;
  let value = BigInt(offset);
  while (remaining > 0) {
    const groupBits = remaining < 32 ? remaining : 32;
    writer.serializeBits({ value: Number(value & 0xffffffffn) }, groupBits);
    value >>= 32n;
    remaining -= groupBits;
  }
  writer.flush();
  return writer.data();
}

test('reads refuse one raw step past the top of the range, on every lane', () => {
  // [integerBits, fractionBits, min, max] -- serialize.h's validation
  // matrix rows with bit headroom, one per storage lane and group shape
  const configs = [
    [8, 8, -100, 100], // narrow single group
    [16, 16, -30000, 30000],
    [32, 0, -100000, 100000],
    [16, 16, 0, 60000], // unsigned narrow
    [48, 16, -100000000000n, 100000000000n], // two groups
    [16, 48, 0n, 60000n], // unsigned wide: the raw top is past INT64_MAX
    [112, 16, -100000000000n, 100000000000n], // three groups
    [64, 64, -1000n, 1000n], // four groups
  ];
  for (const [integerBits, fractionBits, min, max] of configs) {
    const label = `Q${integerBits}.${fractionBits} [${min},${max}]`;
    const wide = typeof min === 'bigint';
    const scale = wide ? 1n << BigInt(fractionBits) : 2 ** fractionBits;
    const rawMin = wide ? min * scale : BigInt(min * scale);
    const rawRange = wide ? (max - min) * scale : BigInt((max - min) * 2 ** fractionBits);
    const bits = bitsRequired128(0n, rawRange);

    // this matrix only holds configurations with headroom
    assert.notEqual(rawRange, (1n << BigInt(bits)) - 1n, `${label} has headroom`);

    const smuggled = new ReadStream(offsetBytes(rawRange + 1n, bits));
    const ref = { value: 'untouched' };
    assert.equal(smuggled.serializeFixed(ref, integerBits, fractionBits, min, max), false, `refuse ${label}`);
    assert.equal(smuggled.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, 'untouched', 'a refused read leaves the ref unmodified');

    // the accept boundary: raw_range itself decodes to the raw maximum
    const boundary = new ReadStream(offsetBytes(rawRange, bits));
    const accepted = {};
    assert.equal(boundary.serializeFixed(accepted, integerBits, fractionBits, min, max), true, `accept ${label}`);
    assert.equal(accepted.value, wide ? rawMin + rawRange : Number(rawMin + rawRange));
  }
});

test('truncated data refuses cleanly, checked against the total width up front', () => {
  // serialize.h's own past-end case: Q48.16 over two bytes of data
  const reader = new ReadStream(new Uint8Array(2));
  const ref = { value: 'untouched' };
  assert.equal(reader.serializeFixed(ref, 48, 16, -100000000000n, 100000000000n), false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(ref.value, 'untouched');
  assert.equal(reader.bitsProcessed(), 0, 'a refused wide read consumes nothing');

  // empty data refuses the narrow lane too
  const empty = new ReadStream(new Uint8Array(0));
  assert.equal(empty.serializeFixed({}, 8, 8, -100, 100), false);
  assert.equal(empty.error, SerializeError.Overflow);
});

test('writes and measures refuse raw values outside the raw bounds as latched errors', () => {
  for (const makeStream of [
    () => new WriteStream(new Uint8Array(16)),
    () => new MeasureStream(),
  ]) {
    // narrow lane: one raw step outside each bound, and values the int32
    // raw domain cannot carry
    for (const value of [-100 * 256 - 1, 100 * 256 + 1, 1.5, NaN, Infinity]) {
      const stream = makeStream();
      assert.equal(stream.serializeFixed({ value }, 8, 8, -100, 100), false, `refuse ${value}`);
      assert.equal(stream.error, SerializeError.ValueOutOfRange);
      assert.equal(stream.bitsProcessed(), 0, 'a refused fixed write costs nothing');
    }

    // the accept boundaries: the exact raw bounds pass
    for (const value of [-100 * 256, 100 * 256]) {
      const stream = makeStream();
      assert.equal(stream.serializeFixed({ value }, 8, 8, -100, 100), true, `accept ${value}`);
      assert.equal(stream.ok, true);
    }

    // wide lane: one raw step outside each bound
    for (const value of [-1000n * 65536n - 1n, 1000n * 65536n + 1n]) {
      const stream = makeStream();
      assert.equal(stream.serializeFixed({ value }, 48, 16, -1000n, 1000n), false, `refuse ${value}`);
      assert.equal(stream.error, SerializeError.ValueOutOfRange);
    }
    const stream = makeStream();
    assert.equal(stream.serializeFixed({ value: 1000n * 65536n }, 48, 16, -1000n, 1000n), true);
  }
});

test('a degenerate range accepts ONLY its own raw value on write and measure', () => {
  // the reference asserts value == raw_min; the checked runtime latches
  for (const makeStream of [
    () => new WriteStream(new Uint8Array(16)),
    () => new MeasureStream(),
  ]) {
    for (const value of [5 * 65536 - 1, 5 * 65536 + 1, 0]) {
      const stream = makeStream();
      assert.equal(stream.serializeFixed({ value }, 16, 16, 5, 5), false, `refuse ${value}`);
      assert.equal(stream.error, SerializeError.ValueOutOfRange);
    }
    const stream = makeStream();
    assert.equal(stream.serializeFixed({ value: 5 * 65536 }, 16, 16, 5, 5), true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

test('a refused wide write puts nothing on the wire', () => {
  // 8-byte buffer: fill 40 bits, leaving 24 -- a 34-bit Q48.16 write must
  // refuse as one unit, never a dangling low group
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 8), true);
  assert.equal(writer.serializeFixed({ value: 0n }, 48, 16, -100000n, 100000n), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), 40, 'nothing written on refusal');
});

test('an invalid Q format declaration is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(16));
  const reader = new ReadStream(new Uint8Array(16));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    // the serialize.h static assert cases, translated:
    // integerBits + fractionBits must equal a storage width
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 8, 0, 100), RangeError);
    assert.throws(() => stream.serializeFixed({ value: 0 }, 20, 20, 0, 100), RangeError);
    // at least one integer bit (the sign bit counts); no negative fractions
    assert.throws(() => stream.serializeFixed({ value: 0 }, 0, 32, 0, 100), RangeError);
    assert.throws(() => stream.serializeFixed({ value: 0 }, 40, -8, 0, 100), RangeError);
    // non-integer bit counts
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16.5, 15.5, 0, 100), RangeError);
    // bounds exceed the Q16.16 whole unit capacity [-32768,32767]
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 16, -40000, 40000), RangeError);
    // the signed reading binds when min < 0: max past the signed capacity
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 16, -1, 40000), RangeError);
    // the unsigned reading binds when min >= 0: max past 2^16 - 1
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 16, 0, 65536), RangeError);
    // min must not exceed max (min == max is LEGAL: zero bits)
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 16, 200, 100), RangeError);
    // the bounds domain follows the storage width: Numbers narrow, BigInts wide
    assert.throws(() => stream.serializeFixed({ value: 0 }, 16, 16, 0n, 100n), RangeError);
    assert.throws(() => stream.serializeFixed({ value: 0n }, 48, 16, 0, 100), RangeError);
    // wide bounds live in the int64 domain, exactly the reference's
    // template parameter type
    assert.throws(
      () => stream.serializeFixed({ value: 0n }, 112, 16, 0n, INT64_MAX + 1n),
      RangeError,
    );
    assert.throws(
      () => stream.serializeFixed({ value: 0n }, 112, 16, INT64_MIN - 1n, 0n),
      RangeError,
    );
    // wide capacity: Q48.16 whole units live in [-2^47, 2^47 - 1]
    assert.throws(
      () => stream.serializeFixed({ value: 0n }, 48, 16, -(2n ** 47n) - 1n, 0n),
      RangeError,
    );
    assert.throws(
      () => stream.serializeFixed({ value: 0n }, 48, 16, 0n, 2n ** 48n),
      RangeError,
    );
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }

  // the capacity accept boundaries, beside the refusals above
  const boundaries = [
    [0, 16, 16, -32768, 32767],
    [0, 16, 16, 0, 65535],
    [0n, 48, 16, -(2n ** 47n), 2n ** 47n - 1n],
    [0n, 48, 16, 0n, 2n ** 48n - 1n],
  ];
  for (const [value, integerBits, fractionBits, min, max] of boundaries) {
    const ok = new WriteStream(new Uint8Array(16));
    assert.equal(ok.serializeFixed({ value }, integerBits, fractionBits, min, max), true);
    assert.equal(ok.ok, true);
  }
});

test('a value of the wrong domain type on write or measure is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(16));
  // narrow storage takes Numbers, wide takes BigInts
  assert.throws(() => writer.serializeFixed({ value: 0n }, 8, 8, -100, 100), TypeError);
  assert.throws(() => writer.serializeFixed({ value: 0 }, 48, 16, -1000n, 1000n), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeFixed({ value: null }, 8, 8, -100, 100), TypeError);
  assert.throws(() => measure.serializeFixed({ value: 0 }, 64, 64, -1000n, 1000n), TypeError);
});

test('a latched stream refuses fixed serializes without touching state', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeInt({ value: 9 }, 0, 7), false); // latch ValueOutOfRange
  assert.equal(writer.serializeFixed({ value: 0 }, 8, 8, -100, 100), false);
  assert.equal(writer.error, SerializeError.ValueOutOfRange);
  assert.equal(writer.bitsProcessed(), 0);

  const reader = new ReadStream(new Uint8Array(0));
  assert.equal(reader.serializeBits({}, 1), false); // latch Overflow
  const ref = { value: 'untouched' };
  assert.equal(reader.serializeFixed(ref, 8, 8, -100, 100), false);
  assert.equal(ref.value, 'untouched');
});
