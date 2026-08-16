// serializeFloat / serializeDouble tests: the uncompressed floating point
// operations. STANDARD.md ("Floating Point", ratified 2026-08-15 from the
// #56 re-audit) makes both bit transparent in BOTH directions: every pattern
// is legal on the wire -- NaNs with any payload, signaling NaNs, infinities,
// negative zero, denormals -- and the reader reproduces the transmitted
// pattern exactly. The golden vectors here are serialize.h's own
// test_golden_float_bit_transparency patterns, compared by BITS, never by
// value: NaN compares unequal to itself, -0 === 0, and a tolerance
// comparison cannot see a quieted signaling bit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

const dv = new DataView(new ArrayBuffer(8));

function float32FromBits(bits) {
  dv.setUint32(0, bits, true);
  return dv.getFloat32(0, true);
}

function float64FromBits(bits) {
  dv.setBigUint64(0, bits, true);
  return dv.getFloat64(0, true);
}

function bitsOfFloat64(value) {
  dv.setFloat64(0, value, true);
  return dv.getBigUint64(0, true);
}

// serialize.h's golden float bit transparency vectors: the little-endian
// bytes of five float32 patterns then two float64 patterns, pinned forever.
const GOLDEN_FLOAT_BYTES = Uint8Array.from([
  0x01, 0x00, 0xc0, 0x7f, // f32 0x7FC00001: quiet NaN, payload 1
  0x01, 0x00, 0x80, 0x7f, // f32 0x7F800001: SIGNALING NaN
  0x00, 0x00, 0x80, 0xff, // f32 0xFF800000: -Inf
  0x00, 0x00, 0x00, 0x80, // f32 0x80000000: -0.0
  0x01, 0x00, 0x00, 0x00, // f32 0x00000001: smallest denormal
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf4, 0x7f, // f64 0x7FF4000000000001: signaling NaN, payload 1
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, // f64 0x8000000000000000: -0.0
]);

const GOLDEN_FLOAT_PATTERNS = [0x7fc00001, 0x7f800001, 0xff800000, 0x80000000, 0x00000001];
const GOLDEN_DOUBLE_PATTERNS = [0x7ff4000000000001n, 0x8000000000000000n];

// Writes value with serializeFloat and returns the 4 wire bytes.
function writeFloatBytes(value) {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeFloat({ value }), true);
  assert.equal(writer.bitsProcessed(), 32, 'float costs exactly 32 bits');
  writer.flush();
  return writer.data();
}

// Writes value with serializeDouble and returns the 8 wire bytes.
function writeDoubleBytes(value) {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeDouble({ value }), true);
  assert.equal(writer.bitsProcessed(), 64, 'double costs exactly 64 bits');
  writer.flush();
  return writer.data();
}

test('float round trips ordinary values exactly', () => {
  // float32-representable values come back identical, not just close
  for (const value of [0, 1, -1, 0.5, Math.fround(3.1415926), Math.fround(-1e30),
    Infinity, -Infinity, 3.3895313892515355e38, 1.401298464324817e-45]) {
    const reader = new ReadStream(writeFloatBytes(value));
    const ref = {};
    assert.equal(reader.serializeFloat(ref), true, `read ${value}`);
    assert.equal(ref.value, Math.fround(value), `round trip of ${value}`);
    assert.equal(reader.bitsProcessed(), 32, 'read costs exactly 32 bits');
  }
});

test('float write rounds the number to float32: the call site conversion of the family', () => {
  // 0.1 is not float32-representable: the wire carries fround(0.1)
  const reader = new ReadStream(writeFloatBytes(0.1));
  const ref = {};
  assert.equal(reader.serializeFloat(ref), true);
  assert.equal(ref.value, Math.fround(0.1));
  assert.notEqual(ref.value, 0.1);
  // a double beyond float32 range converts to infinity, like the call site would
  assert.deepEqual(writeFloatBytes(1e300), writeFloatBytes(Infinity));
});

test('double round trips every value exactly: the number IS a float64', () => {
  for (const value of [0, 1, -1, 0.1, 1 / 3, Math.PI, 1e300, 5e-324,
    Number.MAX_SAFE_INTEGER, Infinity, -Infinity]) {
    const reader = new ReadStream(writeDoubleBytes(value));
    const ref = {};
    assert.equal(reader.serializeDouble(ref), true, `read ${value}`);
    assert.equal(ref.value, value, `round trip of ${value}`);
    assert.equal(reader.bitsProcessed(), 64, 'read costs exactly 64 bits');
  }
});

test('the golden float vectors write exactly the pinned bytes', () => {
  const writer = new WriteStream(new Uint8Array(40));
  for (const pattern of GOLDEN_FLOAT_PATTERNS) {
    // the two NaN patterns cannot be built with a hardware conversion (it
    // would quiet the signaling bit), so build them the way the reader
    // does: sign kept, the 23 mantissa bits widened into the float64 top
    const value = (pattern & 0x7f800000) === 0x7f800000 && (pattern & 0x007fffff) !== 0
      ? float64FromBits(
        (BigInt(pattern >>> 31) << 63n) | 0x7ff0000000000000n | (BigInt(pattern & 0x007fffff) << 29n))
      : float32FromBits(pattern);
    assert.equal(writer.serializeFloat({ value }), true);
  }
  for (const pattern of GOLDEN_DOUBLE_PATTERNS) {
    assert.equal(writer.serializeDouble({ value: float64FromBits(pattern) }), true);
  }
  writer.flush();
  assert.equal(writer.bytesProcessed(), GOLDEN_FLOAT_BYTES.length);
  assert.deepEqual(writer.data(), GOLDEN_FLOAT_BYTES);
});

test('the golden float vectors read back and re-encode byte-for-byte', () => {
  // the transparency proof STANDARD.md demands: read every pattern off the
  // pinned bytes, write each value straight back, and the wire is identical
  // -- quieting, canonicalizing or flushing anywhere in the pipe breaks this
  const reader = new ReadStream(GOLDEN_FLOAT_BYTES);
  const writer = new WriteStream(new Uint8Array(40));
  const ref = {};
  for (let i = 0; i < GOLDEN_FLOAT_PATTERNS.length; i++) {
    assert.equal(reader.serializeFloat(ref), true, `read f32 vector ${i}`);
    assert.equal(writer.serializeFloat(ref), true, `re-encode f32 vector ${i}`);
  }
  for (let i = 0; i < GOLDEN_DOUBLE_PATTERNS.length; i++) {
    assert.equal(reader.serializeDouble(ref), true, `read f64 vector ${i}`);
    assert.equal(bitsOfFloat64(ref.value), GOLDEN_DOUBLE_PATTERNS[i],
      `f64 vector ${i} recovered bit pattern`);
    assert.equal(writer.serializeDouble(ref), true, `re-encode f64 vector ${i}`);
  }
  writer.flush();
  assert.deepEqual(writer.data(), GOLDEN_FLOAT_BYTES);
});

test('negative zero keeps its sign both ways', () => {
  const floatRef = {};
  assert.equal(new ReadStream(writeFloatBytes(-0)).serializeFloat(floatRef), true);
  assert.equal(Object.is(floatRef.value, -0), true, 'float -0 comes back as -0');

  const doubleRef = {};
  assert.equal(new ReadStream(writeDoubleBytes(-0)).serializeDouble(doubleRef), true);
  assert.equal(Object.is(doubleRef.value, -0), true, 'double -0 comes back as -0');
});

test('floats round trip at unaligned bit positions', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeBits({ value: 1 }, 3), true);
  const float = float32FromBits(0x7fc00001); // quiet NaN payload 1 survives the shift
  assert.equal(writer.serializeFloat({ value: float }), true);
  assert.equal(writer.serializeDouble({ value: 1 / 3 }), true);
  assert.equal(writer.bitsProcessed(), 3 + 32 + 64);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeBits(ref, 3), true);
  assert.equal(reader.serializeFloat(ref), true);
  dv.setFloat32(0, ref.value, true);
  assert.equal(dv.getUint32(0, true), 0x7fc00001, 'NaN payload survives unaligned');
  assert.equal(reader.serializeDouble(ref), true);
  assert.equal(ref.value, 1 / 3);
});

test('measure prices a float at 32 bits and a double at 64, ignoring the value', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeFloat({}), true, 'measure ignores the ref');
  assert.equal(measure.bitsProcessed(), 32);
  assert.equal(measure.serializeDouble({}), true);
  assert.equal(measure.bitsProcessed(), 32 + 64);
});

test('a float write that does not fit latches Overflow and writes nothing', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 1), true);
  // 31 bits left: a float does not fit
  assert.equal(writer.serializeFloat({ value: 1.5 }), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), 33, 'the refused write consumed nothing');
});

test('a double write that does not fit latches Overflow with nothing dangling', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 1), true);
  // 63 bits left: the low dword alone would fit, the total width does not
  assert.equal(writer.serializeDouble({ value: 1.5 }), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), 1, 'no dangling low dword');
});

test('a truncated float read latches Overflow and leaves the ref alone', () => {
  const reader = new ReadStream(new Uint8Array(3)); // 24 bits: not enough
  const ref = { value: 42 };
  assert.equal(reader.serializeFloat(ref), false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(ref.value, 42, 'ref untouched on refusal');
});

test('a truncated double read latches Overflow before consuming anything', () => {
  const reader = new ReadStream(new Uint8Array(7)); // 56 bits: low dword fits, total does not
  const ref = { value: 42 };
  assert.equal(reader.serializeDouble(ref), false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(ref.value, 42, 'ref untouched on refusal');
  assert.equal(reader.bitsProcessed(), 0, 'the refused read consumed nothing');
});

test('a latched error makes float serializes no-ops, and misuse still throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 5 }, 0, 3), false, 'latch ValueOutOfRange');
  assert.equal(writer.serializeFloat({ value: 1.5 }), false);
  assert.equal(writer.serializeDouble({ value: 1.5 }), false);
  assert.equal(writer.error, SerializeError.ValueOutOfRange, 'the first error sticks');
  assert.equal(writer.bitsProcessed(), 0);
});

test('a non-number value is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeFloat({ value: '1.5' }), TypeError);
  assert.throws(() => writer.serializeDouble({ value: 1n }), TypeError);
  assert.equal(writer.ok, true, 'misuse latches nothing');
});
