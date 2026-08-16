// serializeInt64 tests: the ranged 64-bit integer. Bit costs follow
// serialize.h's bits_required64 over the unsigned 64-bit domain, so ranges
// wider than 2^63 are exact; offsets needing more than 32 bits go low dword
// first (STANDARD.md "int64 (ranged)"). Values and bounds are BigInts. The
// value sets are serialize.h's own test values (test_serialize_int64_full_range),
// and the pinned wire bytes are derived from the standard's offset rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  bitsRequired64,
} from '../src/index.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Writes value over [min,max], reads it back over the same range, and
// checks both directions cost exactly bitsRequired64 bits.
function roundTrip(value, min, max) {
  const label = `${value} in [${min},${max}]`;
  const bits = bitsRequired64(BigInt.asUintN(64, min), BigInt.asUintN(64, max));

  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeInt64({ value }, min, max), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeInt64(ref, min, max), true, `read ${label}`);
  assert.equal(ref.value, value, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeInt64({ value }, min, max), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);
}

test('small ranges use the single dword path and the minimal bits', () => {
  // serialize.h: bits_required64(-100,100) == 8, same as the 32 bit path
  roundTrip(55n, -100n, 100n);
  roundTrip(-100n, -100n, 100n);
  roundTrip(100n, -100n, 100n);

  // the STANDARD's examples at 64-bit width: [0,7] is 3 bits, [0,8] is 4
  roundTrip(7n, 0n, 7n);
  roundTrip(8n, 0n, 8n);
});

test('ranges spanning more than 32 bits use the two dword path', () => {
  // serialize.h's own values for [-5000000000, +5000000000]: 34 bits
  const min = -5000000000n;
  const max = 5000000000n;
  for (const value of [min, min + 1n, -1n, 0n, 1n, 4123456789n, max - 1n, max]) {
    roundTrip(value, min, max);
  }
});

test('boundary values round trip at the 2^31 and 2^32 edges', () => {
  // [0, 2^31 - 1]: 31 bits -- still one group
  roundTrip(2n ** 31n - 1n, 0n, 2n ** 31n - 1n);
  // [0, 2^31]: 32 bits -- the widest single group
  roundTrip(2n ** 31n, 0n, 2n ** 31n);
  // [0, 2^32 - 1]: 32 bits
  roundTrip(2n ** 32n - 1n, 0n, 2n ** 32n - 1n);
  // [0, 2^32]: 33 bits -- the first range needing the high group
  roundTrip(2n ** 32n, 0n, 2n ** 32n);
  roundTrip(2n ** 32n - 1n, 0n, 2n ** 32n);
});

test('the full int64 range is exact: wider than 2^63 in the unsigned domain', () => {
  // serialize.h: ranges wider than 2^63 overflow if the arithmetic is signed
  const values = [
    INT64_MIN,
    INT64_MIN + 1n,
    -1n,
    0n,
    1n,
    INT64_MAX - 1n,
    INT64_MAX,
  ];
  for (const value of values) {
    roundTrip(value, INT64_MIN, INT64_MAX);
  }
});

test('degenerate min == max costs zero bits everywhere', () => {
  // serialize.h's degenerate 64-bit point is 2^40: wider than 2^32, so the
  // field would take the two-dword path if it took any path at all
  const point = 2n ** 40n;
  for (const pinned of [point, 0n, -1n, INT64_MIN, INT64_MAX]) {
    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(writer.serializeInt64({ value: pinned }, pinned, pinned), true);
    assert.equal(writer.bitsProcessed(), 0);
    writer.flush();
    assert.equal(writer.data().length, 0);

    // read: the value materializes from the range alone, even from EMPTY data
    const reader = new ReadStream(new Uint8Array(0));
    const ref = {};
    assert.equal(reader.serializeInt64(ref, pinned, pinned), true);
    assert.equal(ref.value, pinned);
    assert.equal(reader.bitsProcessed(), 0);

    const measure = new MeasureStream();
    assert.equal(measure.serializeInt64({ value: pinned }, pinned, pinned), true);
    assert.equal(measure.bitsProcessed(), 0);
  }

  // and the NEXT field starts at bit 0, exactly as serialize.h pins it
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeInt64({ value: point }, point, point), true);
  assert.equal(writer.serializeInt({ value: 3 }, 0, 7), true);
  assert.equal(writer.bitsProcessed(), 3);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const degenerate = {};
  const after = {};
  assert.equal(reader.serializeInt64(degenerate, point, point), true);
  assert.equal(reader.serializeInt(after, 0, 7), true);
  assert.equal(degenerate.value, point);
  assert.equal(after.value, 3);
});

test('pinned wire bytes: full-range int64 is the unsigned offset from -2^63', () => {
  // value -1 -> offset 0xFFFFFFFFFFFFFFFF - 0x8000000000000000
  //          = 0x7FFFFFFFFFFFFFFF -> lo dword FF FF FF FF, hi FF FF FF 7F
  // value  0 -> offset 0x8000000000000000 -> 00 00 00 00 00 00 00 80
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeInt64({ value: -1n }, INT64_MIN, INT64_MAX), true);
  assert.equal(writer.serializeInt64({ value: 0n }, INT64_MIN, INT64_MAX), true);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
  ]);

  const reader = new ReadStream(writer.data());
  const x = {};
  const y = {};
  assert.equal(reader.serializeInt64(x, INT64_MIN, INT64_MAX), true);
  assert.equal(reader.serializeInt64(y, INT64_MIN, INT64_MAX), true);
  assert.equal(x.value, -1n);
  assert.equal(y.value, 0n);
});

test('pinned wire bytes: the 34-bit two dword split', () => {
  // 4123456789 in [-5000000000, 5000000000]: offset 9123456789
  //   = 0x2_1FCC_E715 -> lo dword 0x1FCCE715, then 0b10 in the 2 high bits
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(
    writer.serializeInt64({ value: 4123456789n }, -5000000000n, 5000000000n),
    true,
  );
  writer.flush();
  assert.equal(writer.bitsProcessed(), 34);
  assert.deepEqual(Array.from(writer.data()), [0x15, 0xe7, 0xcc, 0x1f, 0x02]);

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeInt64(ref, -5000000000n, 5000000000n), true);
  assert.equal(ref.value, 4123456789n);
});

test('where the range fits 32 bits the wire is identical to serializeInt', () => {
  // one offset rule at every width: the 64-bit form of a small range costs
  // the same bits and produces the same bytes as the 32-bit form
  const cases = [
    [55n, -100n, 100n],
    [-3n, -5n, 5n],
    [2147483647n, -2147483648n, 2147483647n],
  ];
  for (const [value, min, max] of cases) {
    const wide = new WriteStream(new Uint8Array(8));
    assert.equal(wide.serializeInt64({ value }, min, max), true);
    wide.flush();

    const narrow = new WriteStream(new Uint8Array(8));
    assert.equal(
      narrow.serializeInt({ value: Number(value) }, Number(min), Number(max)),
      true,
    );
    narrow.flush();

    assert.equal(wide.bitsProcessed(), narrow.bitsProcessed());
    assert.deepEqual(Array.from(wide.data()), Array.from(narrow.data()));
  }
});

test('an invalid range is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(16));
  const reader = new ReadStream(new Uint8Array(16));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    // min above max
    assert.throws(() => stream.serializeInt64({ value: 0n }, 5n, 4n), RangeError);
    // bounds outside the int64 domain
    assert.throws(
      () => stream.serializeInt64({ value: 0n }, 0n, 2n ** 63n),
      RangeError,
    );
    assert.throws(
      () => stream.serializeInt64({ value: 0n }, -(2n ** 63n) - 1n, 0n),
      RangeError,
    );
    // Number bounds: the 64-bit domain is BigInt
    assert.throws(() => stream.serializeInt64({ value: 0n }, 0, 100), RangeError);
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

test('a non-BigInt value on write or measure is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.throws(() => writer.serializeInt64({ value: 3 }, 0n, 7n), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeInt64({ value: null }, 0n, 7n), TypeError);
});
