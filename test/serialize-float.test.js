// serializeFloat / serializeDouble tests: the uncompressed floating point
// operations. Format 2.0 (STANDARD.md, "Finite values only, every one bit
// exact") carries FINITE values only: a pattern whose exponent field is all
// ones -- NaN with any payload, either sign, signaling or quiet, and both
// infinities -- is refused on read as non_finite_float with the destination
// unwritten, and the checked writer latches the same reason. Every finite
// pattern travels bit exact: negative zero and the subnormals are never
// flushed, canonicalized or re-signed. Patterns are compared by BITS, never
// by value: -0 === 0, and a tolerance comparison cannot see a flushed
// subnormal.

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

function bitsOfFloat32(value) {
  dv.setFloat32(0, value, true);
  return dv.getUint32(0, true);
}

function bitsOfFloat64(value) {
  dv.setFloat64(0, value, true);
  return dv.getBigUint64(0, true);
}

function float32Bytes(bits) {
  return Uint8Array.from([bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, bits >>> 24]);
}

function float64Bytes(bits) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, bits, true);
  return bytes;
}

// The finite edges, little-endian on the wire and pinned by bits: negative
// zero, the smallest and largest subnormals, the smallest normal and the
// largest finite value, with their negative twins.
const FINITE_FLOAT_PATTERNS = [
  0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x007fffff, 0x807fffff,
  0x00800000, 0x7f7fffff, 0xff7fffff, 0x40490fda,
];
const FINITE_DOUBLE_PATTERNS = [
  0x0000000000000000n, 0x8000000000000000n, 0x0000000000000001n, 0x800fffffffffffffn,
  0x0010000000000000n, 0x7fefffffffffffffn, 0xffefffffffffffffn, 0x3fd5555555555555n,
];

// The non-finite patterns: both infinities, quiet and signaling NaNs of both
// signs, a payload, every payload bit, and for double a NaN whose payload
// lives only in the LOW dword -- the exponent sits in the high one.
const NON_FINITE_FLOAT_PATTERNS = [
  0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001, 0x7fc00001,
  0x7fffffff, 0xffffffff,
];
const NON_FINITE_DOUBLE_PATTERNS = [
  0x7ff0000000000000n, 0xfff0000000000000n, 0x7ff8000000000000n, 0xfff8000000000000n,
  0x7ff0000000000001n, 0x7ff4000000000001n, 0x7fffffffffffffffn, 0xffffffffffffffffn,
];

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
    3.3895313892515355e38, 1.401298464324817e-45]) {
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
});

test('double round trips every finite value exactly: the number IS a float64', () => {
  for (const value of [0, 1, -1, 0.1, 1 / 3, Math.PI, 1e300, 5e-324,
    Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const reader = new ReadStream(writeDoubleBytes(value));
    const ref = {};
    assert.equal(reader.serializeDouble(ref), true, `read ${value}`);
    assert.equal(ref.value, value, `round trip of ${value}`);
    assert.equal(reader.bitsProcessed(), 64, 'read costs exactly 64 bits');
  }
});

test('every finite edge pattern writes, reads and re-encodes bit exact', () => {
  for (const pattern of FINITE_FLOAT_PATTERNS) {
    const bytes = writeFloatBytes(float32FromBits(pattern));
    assert.deepEqual(bytes, float32Bytes(pattern), `float 0x${pattern.toString(16)} writes its bytes`);
    const ref = {};
    assert.equal(new ReadStream(bytes).serializeFloat(ref), true);
    assert.equal(bitsOfFloat32(ref.value), pattern, `float 0x${pattern.toString(16)} reads its bits`);
    assert.deepEqual(writeFloatBytes(ref.value), bytes, 'and re-encodes byte for byte');
  }
  for (const pattern of FINITE_DOUBLE_PATTERNS) {
    const bytes = writeDoubleBytes(float64FromBits(pattern));
    assert.deepEqual(bytes, float64Bytes(pattern), `double 0x${pattern.toString(16)} writes its bytes`);
    const ref = {};
    assert.equal(new ReadStream(bytes).serializeDouble(ref), true);
    assert.equal(bitsOfFloat64(ref.value), pattern, `double 0x${pattern.toString(16)} reads its bits`);
    assert.deepEqual(writeDoubleBytes(ref.value), bytes, 'and re-encodes byte for byte');
  }
});

test('a non-finite float pattern is refused as non_finite_float, the destination unwritten', () => {
  for (const pattern of NON_FINITE_FLOAT_PATTERNS) {
    const reader = new ReadStream(float32Bytes(pattern));
    const ref = { value: 42 };
    assert.equal(reader.serializeFloat(ref), false, `0x${pattern.toString(16)} refused`);
    assert.equal(reader.error, SerializeError.NonFiniteFloat);
    assert.equal(ref.value, 42, 'ref untouched on refusal');
  }
  // the accept-boundary neighbours: the largest finite magnitudes, one
  // below the all-ones exponent
  for (const pattern of [0x7f7fffff, 0xff7fffff]) {
    const ref = {};
    assert.equal(new ReadStream(float32Bytes(pattern)).serializeFloat(ref), true);
    assert.equal(bitsOfFloat32(ref.value), pattern);
  }
});

test('a non-finite double pattern is refused as non_finite_float, the destination unwritten', () => {
  for (const pattern of NON_FINITE_DOUBLE_PATTERNS) {
    const reader = new ReadStream(float64Bytes(pattern));
    const ref = { value: 42 };
    assert.equal(reader.serializeDouble(ref), false, `0x${pattern.toString(16)} refused`);
    assert.equal(reader.error, SerializeError.NonFiniteFloat);
    assert.equal(ref.value, 42, 'ref untouched on refusal');
  }
  for (const pattern of [0x7fefffffffffffffn, 0xffefffffffffffffn]) {
    const ref = {};
    assert.equal(new ReadStream(float64Bytes(pattern)).serializeDouble(ref), true);
    assert.equal(bitsOfFloat64(ref.value), pattern);
  }
});

test('the checked writer latches a non-finite float as non_finite_float and writes nothing', () => {
  // 1e300 is a finite double that narrows to +Infinity in float32: the
  // rule is tested after the narrowing, on the bits that would ship
  for (const value of [NaN, Infinity, -Infinity, 1e300, -1e300, float32FromBits(0x7f800001)]) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.throws(() => writer.serializeFloat({ value }), RangeError, `float ${value} refused`);
    assert.equal(writer.ok, true);
    assert.equal(writer.bitsProcessed(), 0, 'nothing written');
  }
  // the largest finite float32 is accepted, and so is a double just above
  // it that still rounds DOWN to it
  const fltMax = float32FromBits(0x7f7fffff);
  assert.deepEqual(writeFloatBytes(fltMax), float32Bytes(0x7f7fffff));
  assert.deepEqual(writeFloatBytes(fltMax * (1 + 2 ** -30)), float32Bytes(0x7f7fffff));
});

test('the checked writer latches a non-finite double as non_finite_float and writes nothing', () => {
  for (const value of [NaN, Infinity, -Infinity, float64FromBits(0x7ff0000000000001n)]) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.throws(() => writer.serializeDouble({ value }), RangeError, `double ${value} refused`);
    assert.equal(writer.ok, true);
    assert.equal(writer.bitsProcessed(), 0, 'nothing written');
  }
  assert.deepEqual(writeDoubleBytes(Number.MAX_VALUE), float64Bytes(0x7fefffffffffffffn));
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
  const float = float32FromBits(0x807fffff); // the largest negative subnormal survives the shift
  assert.equal(writer.serializeFloat({ value: float }), true);
  assert.equal(writer.serializeDouble({ value: 1 / 3 }), true);
  assert.equal(writer.bitsProcessed(), 3 + 32 + 64);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeBits(ref, 3), true);
  assert.equal(reader.serializeFloat(ref), true);
  assert.equal(bitsOfFloat32(ref.value), 0x807fffff, 'subnormal survives unaligned');
  assert.equal(reader.serializeDouble(ref), true);
  assert.equal(ref.value, 1 / 3);
});

test('measure prices a float at 32 bits and a double at 64', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeFloat({ value: 0.5 }), true);
  assert.equal(measure.bitsProcessed(), 32);
  assert.equal(measure.serializeDouble({ value: 0.5 }), true);
  assert.equal(measure.bitsProcessed(), 32 + 64);
});

test('a float write that does not fit throws (U9) and writes nothing', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 1), true);
  // 31 bits left: a float does not fit
  assert.throws(() => writer.serializeFloat({ value: 1.5 }), RangeError);
  assert.equal(writer.error, SerializeError.None);
  assert.equal(writer.bitsProcessed(), 33, 'the refused write consumed nothing');
});

test('a double write that does not fit throws (U9) and writes nothing', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 1), true);
  // 63 bits left: the low dword alone would fit, the total width does not
  assert.throws(() => writer.serializeDouble({ value: 1.5 }), RangeError);
  assert.equal(writer.error, SerializeError.None);
  assert.equal(writer.bitsProcessed(), 1, 'no dangling low dword');
});

test('a truncated float read latches PastEnd and leaves the ref alone', () => {
  const reader = new ReadStream(new Uint8Array(3)); // 24 bits: not enough
  const ref = { value: 42 };
  assert.equal(reader.serializeFloat(ref), false);
  assert.equal(reader.error, SerializeError.PastEnd);
  assert.equal(ref.value, 42, 'ref untouched on refusal');
});

test('a truncated double read latches PastEnd before consuming anything', () => {
  const reader = new ReadStream(new Uint8Array(7)); // 56 bits: low dword fits, total does not
  const ref = { value: 42 };
  assert.equal(reader.serializeDouble(ref), false);
  assert.equal(reader.error, SerializeError.PastEnd);
  assert.equal(ref.value, 42, 'ref untouched on refusal');
  assert.equal(reader.bitsProcessed(), 0, 'the refused read consumed nothing');
});

test('a full write stream throws on float serializes and latches nothing (U9)', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeUint64({ value: 0n }), true);
  assert.throws(() => writer.serializeBool({ value: true }), RangeError);
  assert.throws(() => writer.serializeFloat({ value: 1.5 }), RangeError);
  assert.throws(() => writer.serializeDouble({ value: 1.5 }), RangeError);
  assert.equal(writer.error, SerializeError.None);
  assert.equal(writer.bitsProcessed(), 64);
});

test('a non-number value is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeFloat({ value: '1.5' }), TypeError);
  assert.throws(() => writer.serializeDouble({ value: 1n }), TypeError);
  assert.equal(writer.ok, true, 'misuse latches nothing');
});
