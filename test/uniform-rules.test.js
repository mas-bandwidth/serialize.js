// The uniform rules of IMPLEMENTING.md (reference v2.1.0, U1 to U16), the
// parts that hold in EVERY mode: the read side (a reader never traps, and a
// bad declaration refuses as value_out_of_range before any bits move), the
// whole-operation room check on write, end on a write or measure, the
// refusal names and the public fail, re-initialisation, the precomputed
// compressed float, and the audit's overlapping-copy finding. This file runs
// on both legs. The checked runtime's write-misuse throws (U1, U3, U4, U5,
// U8, U9, U16 on write) live in uniform-rules-checked.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BitReader,
  BitWriter,
  MeasureStream,
  ReadStream,
  SerializeError,
  WriteStream,
  compressedFloatParams,
  refusalName,
} from '../src/index.js';

const VOOR = SerializeError.ValueOutOfRange;

// Every bad declaration a caller can hand a read, one call each. Each must
// return false, latch value_out_of_range, consume nothing, leave its
// destination alone and never throw (U7, U16).
const BAD_READ_DECLARATIONS = [
  ['bits 0', (s, r) => s.serializeBits(r, 0)],
  ['bits 33', (s, r) => s.serializeBits(r, 33)],
  ['bits 1.5', (s, r) => s.serializeBits(r, 1.5)],
  ['bits64 0', (s, r) => s.serializeBits64(r, 0)],
  ['bits64 65', (s, r) => s.serializeBits64(r, 65)],
  ['int min > max', (s, r) => s.serializeInt(r, 5, 4)],
  ['int max above int32 (U5)', (s, r) => s.serializeInt(r, 0, 2 ** 31)],
  ['int min below int32 (U5)', (s, r) => s.serializeInt(r, -(2 ** 31) - 1, 0)],
  ['int max 0xFFFFFFFF (U5)', (s, r) => s.serializeInt(r, 0, 0xffffffff)],
  ['int non-integer bound', (s, r) => s.serializeInt(r, 0, 1.5)],
  ['int64 min > max', (s, r) => s.serializeInt64(r, 5n, 4n)],
  ['int64 Number bounds', (s, r) => s.serializeInt64(r, 0, 4)],
  ['int64 max above int64', (s, r) => s.serializeInt64(r, 0n, 2n ** 63n)],
  ['int128 min > max', (s, r) => s.serializeInt128(r, 5n, 4n)],
  ['int128 max above int128', (s, r) => s.serializeInt128(r, 0n, 2n ** 127n)],
  ['int_relative previous -1', (s, r) => s.serializeIntRelative(-1, r)],
  ['int_relative previous 2^31', (s, r) => s.serializeIntRelative(2 ** 31, r)],
  ['fixed integerBits 0', (s, r) => s.serializeFixed(r, 0, 8, 0, 0)],
  ['fixed width 12', (s, r) => s.serializeFixed(r, 4, 8, 0, 1)],
  ['fixed min > max', (s, r) => s.serializeFixed(r, 8, 8, 2, 1)],
  ['fixed bound past the Q format', (s, r) => s.serializeFixed(r, 4, 4, 0, 16)],
  ['fixed wide Number bounds', (s, r) => s.serializeFixed(r, 32, 32, 0, 1)],
  ['compressed float min == max', (s, r) => s.serializeCompressedFloat(r, 1, 1, 0.1)],
  ['compressed float resolution 0', (s, r) => s.serializeCompressedFloat(r, 0, 1, 0)],
  ['compressed float NaN bound', (s, r) => s.serializeCompressedFloat(r, NaN, 1, 0.1)],
  ['compressed float string bound', (s, r) => s.serializeCompressedFloat(r, '0', 1, 0.1)],
  ['compressed float delta / res not finite', (s, r) => s.serializeCompressedFloat(r, 0, 1e38, 1e-38)],
  ['precomputed bits not derived', (s, r) => s.serializeCompressedFloatPrecomputed(r, 1000, 11, 10, 0)],
  ['precomputed maxIntegerValue 0', (s, r) => s.serializeCompressedFloatPrecomputed(r, 0, 1, 10, 0)],
  ['precomputed maxIntegerValue 2^32 - 1', (s, r) => s.serializeCompressedFloatPrecomputed(r, 4294967295, 32, 10, 0)],
  ['precomputed delta negative', (s, r) => s.serializeCompressedFloatPrecomputed(r, 1000, 10, -10, 0)],
  ['precomputed delta infinite', (s, r) => s.serializeCompressedFloatPrecomputed(r, 1000, 10, Infinity, 0)],
  ['string bufferSize 0', (s, r) => s.serializeString(r, 0)],
  ['string bufferSize -1', (s, r) => s.serializeString(r, -1)],
  ['string bufferSize 1.5', (s, r) => s.serializeString(r, 1.5)],
  ['string bufferSize 2^31', (s, r) => s.serializeString(r, 2 ** 31)],
  ['bytes not a Uint8Array', (s) => s.serializeBytes([1, 2, 3])],
  ['bytes span offset -1 (js#31)', (s) => s.serializeBytes(new Uint8Array(4), -1, 2)],
  ['bytes span past the array (js#31)', (s) => s.serializeBytes(new Uint8Array(4), 2, 3)],
  ['bytes span length 1.5 (js#31)', (s) => s.serializeBytes(new Uint8Array(4), 0, 1.5)],
  ['object not a function', (s) => s.serializeObject(null)],
];

test('U7, U16: a bad declaration on read refuses value_out_of_range, consumes nothing and never throws', () => {
  for (const [name, call] of BAD_READ_DECLARATIONS) {
    const stream = new ReadStream(new Uint8Array(32).fill(0xff));
    const ref = { value: 'untouched' };
    let result;
    assert.doesNotThrow(() => {
      result = call(stream, ref);
    }, name);
    assert.equal(result, false, name);
    assert.equal(stream.error, VOOR, name);
    assert.equal(stream.bitsProcessed(), 0, name);
    assert.equal(ref.value, 'untouched', name);
  }
});

test('U7: the failure state is checked first, so a failed stream keeps its first reason', () => {
  for (const [name, call] of BAD_READ_DECLARATIONS) {
    const stream = new ReadStream(new Uint8Array(1));
    assert.equal(stream.serializeBits({ value: 0 }, 16), false);
    assert.equal(stream.error, SerializeError.PastEnd);
    assert.equal(call(stream, { value: 0 }), false, name);
    assert.equal(stream.error, SerializeError.PastEnd, name);
  }
});

test('U7, U16: reversed witness, the same operations with good declarations read', () => {
  const stream = new ReadStream(new Uint8Array(64));
  const ref = { value: 0 };
  assert.equal(stream.serializeBits(ref, 32), true);
  assert.equal(stream.serializeBits64(ref, 64), true);
  assert.equal(stream.serializeInt(ref, -(2 ** 31), 2 ** 31 - 1), true);
  assert.equal(stream.serializeInt64(ref, 0n, 5n), true);
  assert.equal(stream.serializeInt128(ref, 0n, 5n), true);
  assert.equal(stream.serializeFixed(ref, 4, 4, 0, 15), true);
  assert.equal(stream.serializeCompressedFloat(ref, 0, 10, 0.01), true);
  assert.equal(stream.serializeCompressedFloatPrecomputed(ref, 1000, 10, 10, 0), true);
  assert.equal(stream.serializeString(ref, 1), true);
  assert.equal(stream.serializeBytes(new Uint8Array(4), 1, 2), true);
  assert.equal(stream.serializeObject(() => true), true);
  assert.equal(stream.error, SerializeError.None);
});

test('U7: a read stream over something that is not a Uint8Array refuses, never throws', () => {
  for (const data of [undefined, null, [1, 2], new ArrayBuffer(8), 'ab']) {
    let stream;
    assert.doesNotThrow(() => {
      stream = new ReadStream(data);
    });
    assert.equal(stream.error, VOOR);
    assert.equal(stream.serializeBits({ value: 0 }, 1), false);
    assert.equal(stream.error, VOOR);
    // reset onto real data clears it (U13), and reset onto junk refuses again
    stream.reset(Uint8Array.of(1));
    assert.equal(stream.ok, true);
    assert.doesNotThrow(() => stream.reset(data));
    assert.equal(stream.error, VOOR);
  }
});

test('U10: bytes checks the room for align and payload before writing either', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 1 }, 3), true);
  // 5 align bits + 8 bytes do not fit in the 61 bits left
  assert.equal(writer.serializeBytes(new Uint8Array(8)), false);
  assert.equal(writer.error, SerializeError.PastEnd);
  assert.equal(writer.bitsProcessed(), 3);
});

test('U10: string checks the room for length, align and payload before writing any', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 1 }, 3), true);
  // the length takes 5 bits, then a 0 bit align, then 8 bytes: 3 + 5 + 64 > 64
  assert.equal(writer.serializeString({ value: 'abcdefgh' }, 32), false);
  assert.equal(writer.error, SerializeError.PastEnd);
  assert.equal(writer.bitsProcessed(), 3);
});

test('U10: reversed witness, an operation that fits exactly is written whole', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeBits({ value: 1 }, 3), true);
  assert.equal(writer.serializeString({ value: 'abcdefghijklmno' }, 32), true);
  assert.equal(writer.bitsProcessed(), 128);
  const bytes = new WriteStream(new Uint8Array(16));
  assert.equal(bytes.serializeBits({ value: 1 }, 3), true);
  assert.equal(bytes.serializeBytes(new Uint8Array(15)), true);
  assert.equal(bytes.bitsProcessed(), 128);
});

test('U12: end on a write or a measure is a no-op returning true, even after a refusal', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeEnd(), true);
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 1), false);
  assert.equal(writer.error, SerializeError.PastEnd);
  assert.equal(writer.serializeEnd(), true);
  assert.equal(writer.bitsProcessed(), 64);
  assert.equal(writer.error, SerializeError.PastEnd);

  const measure = new MeasureStream();
  assert.equal(measure.serializeEnd(), true);
  assert.equal(measure.bitsProcessed(), 0);
});

test('U12: reversed witness, end on a read still refuses trailing data', () => {
  const reader = new ReadStream(new Uint8Array(1));
  assert.equal(reader.serializeEnd(), false);
  assert.equal(reader.error, SerializeError.TrailingData);
});

test('U14: refusalName gives the family spellings, and none for no refusal', () => {
  assert.equal(refusalName(SerializeError.None), 'none');
  assert.equal(refusalName(undefined), 'none');
  for (const reason of Object.values(SerializeError)) {
    if (reason !== null) {
      assert.equal(refusalName(reason), reason);
    }
  }
  assert.equal(refusalName('bogus'), '');
  assert.deepEqual(
    Object.values(SerializeError).filter((r) => r !== null).map(refusalName),
    ['past_end', 'value_out_of_range', 'nonzero_padding', 'trailing_data', 'non_finite_float',
      'invalid_utf8', 'embedded_nul', 'non_canonical', 'rejected'],
  );
});

test('U14: ReadStream.fail latches its reason; none or anything off the list latches rejected', () => {
  const named = new ReadStream(new Uint8Array(4));
  assert.equal(named.fail(SerializeError.NonCanonical), false);
  assert.equal(named.error, SerializeError.NonCanonical);
  assert.equal(named.fail(SerializeError.PastEnd), false);
  assert.equal(named.error, SerializeError.NonCanonical); // first reason wins
  assert.equal(named.serializeBits({ value: 0 }, 1), false); // terminal

  for (const reason of [undefined, null, 'bogus', 7, 'none']) {
    const stream = new ReadStream(new Uint8Array(4));
    let result;
    assert.doesNotThrow(() => {
      result = stream.fail(reason);
    });
    assert.equal(result, false);
    assert.equal(stream.error, SerializeError.Rejected, String(reason));
  }
});

test('U6, U9, U14: fail on a write or a measure returns false, records nothing and never throws', () => {
  for (const stream of [new WriteStream(new Uint8Array(8)), new MeasureStream()]) {
    for (const reason of [SerializeError.PastEnd, SerializeError.Rejected, undefined, 'bogus']) {
      let result;
      assert.doesNotThrow(() => {
        result = stream.fail(reason);
      });
      assert.equal(result, false);
      assert.equal(stream.error, SerializeError.None);
    }
    assert.equal(stream.serializeBits({ value: 1 }, 1), true);
  }
});

test('U13: reset re-initialises every stream and clears its latch', () => {
  const reader = new ReadStream(new Uint8Array(1));
  reader.reject();
  reader.reset(Uint8Array.of(0x01));
  assert.equal(reader.ok, true);
  const ref = { value: 0 };
  assert.equal(reader.serializeBits(ref, 1), true);
  assert.equal(ref.value, 1);

  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 1);
  writer.reset(new Uint8Array(8));
  assert.equal(writer.ok, true);
  assert.equal(writer.bitsProcessed(), 0);

  const measure = new MeasureStream();
  measure.serializeBits({ value: 0 }, 7);
  measure.reset();
  assert.equal(measure.bitsProcessed(), 0);
});

test('U11: the written bytes are defined once flush has run', () => {
  const buffer = new Uint8Array(8);
  const writer = new WriteStream(buffer);
  writer.serializeBits({ value: 5 }, 3);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [5]);
});

test('U15: compressedFloatParams derives what the reference derives', () => {
  const params = compressedFloatParams(0, 10, 0.01);
  assert.equal(params.maxIntegerValue, 1000);
  assert.equal(params.bits, 10);
  assert.equal(params.delta, 10);
  assert.ok(Object.isFrozen(params));
  // the clamps: at least one step, at most the largest float32 below 2^32
  assert.equal(compressedFloatParams(0, 1, 2).maxIntegerValue, 1);
  assert.equal(compressedFloatParams(0, 1e30, 1).maxIntegerValue, 4294967040);
  assert.equal(compressedFloatParams(0, 1e30, 1).bits, 32);
});

test('U15: the precomputed compressed float is wire identical to the unified one on every stream', () => {
  const declarations = [[0, 10, 0.01], [-1, 1, 0.001], [-100, 100, 0.5], [3, 3.5, 1], [-1, 16777218, 1]];
  const values = [-1e9, -1, -0.5, 0, 0.005, 0.25, 1, 3.25, 9.995, 1e9];
  for (const [min, max, res] of declarations) {
    const params = compressedFloatParams(min, max, res);
    for (let lead = 0; lead < 8; lead++) {
      const a = new WriteStream(new Uint8Array(64));
      const b = new WriteStream(new Uint8Array(64));
      const ma = new MeasureStream();
      const mb = new MeasureStream();
      for (const s of [a, b, ma, mb]) {
        if (lead > 0) {
          s.serializeBits({ value: 0 }, lead);
        }
      }
      for (const value of values) {
        assert.equal(a.serializeCompressedFloat({ value }, min, max, res), true);
        assert.equal(b.serializeCompressedFloatPrecomputed({ value }, params.maxIntegerValue, params.bits, params.delta, min), true);
        assert.equal(ma.serializeCompressedFloat({ value }, min, max, res), true);
        assert.equal(mb.serializeCompressedFloatPrecomputed({ value }, params.maxIntegerValue, params.bits, params.delta, min), true);
      }
      a.flush();
      b.flush();
      assert.deepEqual(Array.from(b.data()), Array.from(a.data()));
      assert.equal(mb.bitsProcessed(), ma.bitsProcessed());

      const ra = new ReadStream(a.data());
      const rb = new ReadStream(a.data());
      if (lead > 0) {
        ra.serializeBits({ value: 0 }, lead);
        rb.serializeBits({ value: 0 }, lead);
      }
      for (let i = 0; i < values.length; i++) {
        const x = { value: 0 };
        const y = { value: 0 };
        assert.equal(ra.serializeCompressedFloat(x, min, max, res), true);
        assert.equal(rb.serializeCompressedFloatPrecomputed(y, params.maxIntegerValue, params.bits, params.delta, min), true);
        assert.ok(Object.is(x.value, y.value));
      }
    }
  }
});

test('U15: the precomputed read refuses a smuggled integer above maxIntegerValue', () => {
  // 1023 in 10 bits, above max_integer_value 1000
  const stream = new ReadStream(Uint8Array.of(0xff, 0x03));
  const ref = { value: 'untouched' };
  assert.equal(stream.serializeCompressedFloatPrecomputed(ref, 1000, 10, 10, 0), false);
  assert.equal(stream.error, VOOR);
  assert.equal(ref.value, 'untouched');
});

// Audit L (js): a copy whose source and destination share memory must copy
// as if through a temporary, at every size, on the write and the read side.
// The small-copy byte loop smeared an overlapping source at 64 bytes or fewer.
for (const n of [1, 4, 16, 63, 64, 65, 66, 68, 128]) {
  test(`audit overlap: a write whose source is the writer's own buffer copies exactly (${n} bytes)`, () => {
    const buffer = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      buffer[i] = i;
    }
    const expected = Array.from(buffer.subarray(0, n));
    const writer = new WriteStream(buffer);
    writer.serializeBits({ value: 0x03020100 }, 32);
    writer.serializeBits({ value: 0x07060504 }, 32);
    assert.equal(writer.serializeBytes(buffer.subarray(0, n)), true);
    writer.flush();
    assert.deepEqual(Array.from(writer.data().subarray(8, 8 + n)), expected);
  });

  test(`audit overlap: a read into the reader's own data copies exactly (${n} bytes)`, () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = (i * 7 + 1) & 0xff;
    }
    const expected = Array.from(data.subarray(8, 8 + n));
    const reader = new ReadStream(data);
    reader.serializeBits({ value: 0 }, 32);
    reader.serializeBits({ value: 0 }, 32);
    const dest = data.subarray(12, 12 + n);
    assert.equal(reader.serializeBytes(dest), true);
    assert.deepEqual(Array.from(dest), expected);
  });
}

test('audit overlap: the bitpacker copies an overlapping span exactly too', () => {
  const buffer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    buffer[i] = i + 1;
  }
  const expected = Array.from(buffer.subarray(0, 20));
  const writer = new BitWriter(buffer);
  writer.writeBits(0x04030201, 32); // the bytes already there
  writer.writeBytes(buffer, 0, 20);
  writer.flushBits();
  assert.deepEqual(Array.from(buffer.subarray(4, 24)), expected);

  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    data[i] = 64 - i;
  }
  const want = Array.from(data.subarray(4, 24));
  const reader = new BitReader(data);
  reader.readBits(32);
  reader.readBytesInto(data, 6, 20);
  assert.deepEqual(Array.from(data.subarray(6, 26)), want);
});
