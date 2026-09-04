// The JavaScript half of the cross language interop harness.
//
// Its twin is interop/interop.cpp, built in CI against the real C++ serialize
// library at the release .github/workflows/ci.yml pins. The two halves run head
// to head on every push and pull request: each writes the boundary message, the
// two files must be byte identical, and each must decode the other's file to the
// exact values and re-encode it to the exact bytes.
//
//     node interop/interop.mjs write  <file>   write the boundary message out
//     node interop/interop.mjs read   <file>   decode the other half's bytes, check every
//                                              value, re-encode, require byte identity
//     node interop/interop.mjs refuse <file>   every proper prefix of a valid stream is a
//                                              truncated stream, and every one must be REFUSED
//
// THE MESSAGE is the boundary set: every operation STANDARD.md defines, at the
// values where implementations disagree. Zero bit ranges on all three ranged
// widths and on fixed point; the domain edges of int, int64, int128 and
// int_relative; the maximum widths of bits, uint128 and the four group fixed
// point path; both sides of the alignment rule, including the align inside a
// zero length bytes; empty and full strings; and the wide string cases the
// surrogate rule governs, up to the largest code unit.
//
// WHAT IT DELIBERATELY DOES NOT CARRY: a NaN payload. STANDARD.md's bit
// transparency claim covers it, but a NaN's payload bits do not survive every
// language's float type on the way to the wire, so a difference here would say
// nothing about the wire format. This port pins its own NaN patterns in its own
// suite, where the claim can be tested honestly.
//
// Any change to the sequence below must be mirrored in interop/interop.cpp, and
// never changes the wire format.

import { readFileSync, writeFileSync } from 'node:fs';

import { ReadStream, WriteStream } from '../src/index.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

// --------------------------------------------------------------------------
// the sequence, mirrored field for field from interop/interop.cpp

// raw bit groups: Number below 33 bits, BigInt above, which is the port's split
// between serializeBits and serializeBits64. The wire does not know the difference.
const BITS_VECTORS = [
  { bits: 1, value: 1 },                          // the minimum width, at its maximum value
  { bits: 1, value: 0 },                          // and at its minimum
  { bits: 7, value: 0x7f },                       // a sub-byte width, all ones
  { bits: 31, value: 0x7fffffff },                // one below the single group maximum
  { bits: 32, value: 0xffffffff },                // the widest single group, all ones
  { bits: 32, value: 0 },                         // and all zeros
  { bits: 33, value: 0x1ffffffffn },              // the first width past the 32 bit split
  { bits: 64, value: 0xffffffffffffffffn },       // the maximum width, all ones
  { bits: 64, value: 0n },                        // and all zeros
];

const UINT8_VALUES = [0x00, 0xff];
const UINT16_VALUES = [0x0000, 0xffff];
const UINT32_VALUES = [0x00000000, 0xffffffff];
const UINT64_VALUES = [0n, 0xffffffffffffffffn];
const UINT128_VALUES = [
  0n,
  2n ** 128n - 1n,
  (0x0123456789abcdefn << 64n) | 0x0fedcba987654321n,
];

const INT_VECTORS = [
  { min: 42, max: 42, value: 42 },                        // degenerate: zero bits, mid sequence
  { min: -100, max: 100, value: -100 },                   // the bottom of the range
  { min: -100, max: 100, value: 100 },                    // the top of the range
  { min: INT32_MIN, max: INT32_MAX, value: INT32_MIN },   // the full domain, 32 bits on the wire
  { min: INT32_MIN, max: INT32_MAX, value: INT32_MAX },
  { min: -100, max: 100, value: -37 },                    // a live field after the degenerate one
];

const INT64_VECTORS = [
  { min: 10000000000n, max: 10000000000n, value: 10000000000n },  // degenerate, bounds past 2^32
  { min: -5000000000n, max: 5000000000n, value: -5000000000n },   // wider than 32 bits, bottom
  { min: -5000000000n, max: 5000000000n, value: 5000000000n },    // and top
  { min: INT64_MIN, max: INT64_MAX, value: INT64_MIN },           // the full domain, 64 bits
  { min: INT64_MIN, max: INT64_MAX, value: INT64_MAX },
];

// 2^100 + 7: a degenerate bound no 64 bit path can carry
const INT128_DEGENERATE = (1n << 100n) + 7n;

const INT128_VECTORS = [
  { min: INT128_DEGENERATE, max: INT128_DEGENERATE, value: INT128_DEGENERATE },
  // bounds inside the 64 bit domain: the bytes are identical to serializeInt64 here
  { min: -5000000000n, max: 5000000000n, value: 5000000000n },
  { min: INT128_MIN, max: INT128_MAX, value: INT128_MIN },
  { min: INT128_MIN, max: INT128_MAX, value: INT128_MAX },
];

const RELATIVE_VECTORS = [
  { previous: 0, current: 1 },                    // one-bit
  { previous: 0, current: 2 },                    // bounded-3, both ends
  { previous: 0, current: 6 },
  { previous: 0, current: 7 },                    // bounded-5
  { previous: 0, current: 23 },
  { previous: 0, current: 24 },                   // bounded-9
  { previous: 0, current: 280 },
  { previous: 0, current: 281 },                  // bounded-13
  { previous: 0, current: 4377 },
  { previous: 0, current: 4378 },                 // bounded-17
  { previous: 0, current: 69914 },
  { previous: 0, current: 69915 },                // absolute, at its smallest difference
  { previous: 2147483646, current: 2147483647 },  // one-bit, at the top of the domain
  { previous: 0, current: 2147483647 },           // absolute, at the top of the domain
];

// floats are given as bit patterns, so no decimal literal is parsed twice
const FLOAT_BITS = [
  0x00000000,   // +0
  0x80000000,   // -0
  0x7f800000,   // +infinity
  0xff800000,   // -infinity
  0x7f7fffff,   // the largest finite float32
  0x00800000,   // the smallest normal
  0x00000001,   // the smallest subnormal
  0x3f800000,   // 1.0
  0xbf800000,   // -1.0
];

const DOUBLE_BITS = [
  0x0000000000000000n,   // +0
  0x8000000000000000n,   // -0
  0x7ff0000000000000n,   // +infinity
  0xfff0000000000000n,   // -infinity
  0x7fefffffffffffffn,   // the largest finite float64
  0x0010000000000000n,   // the smallest normal
  0x0000000000000001n,   // the smallest subnormal
  0x3ff0000000000000n,   // 1.0
  0xbff0000000000000n,   // -1.0
];

const COMPRESSED_FLOAT_VECTORS = [
  { value: 0.0, min: 0.0, max: 10.0, res: 0.01 },           // the bottom of the range: integer 0
  { value: 10.0, min: 0.0, max: 10.0, res: 0.01 },          // the top: the maximum integer
  { value: 0.005, min: 0.0, max: 10.0, res: 0.01 },         // between quanta: 1 under float32, 0 widened
  { value: 0.025, min: 0.0, max: 10.0, res: 0.01 },         // between quanta: 3 vs 2
  { value: 0.105, min: 0.0, max: 10.0, res: 0.01 },         // between quanta: 11 vs 10
  { value: 9.995, min: 0.0, max: 10.0, res: 0.01 },         // between quanta: 1000 vs 999
  { value: -100.0, min: -100.0, max: 100.0, res: 0.01 },    // the bottom of a range with a non-zero min
  { value: -42.573, min: -100.0, max: 100.0, res: 0.01 },   // off quantum over a non-zero min
  { value: 8388609.0, min: 0.0, max: 8388609.0, res: 1.0 }, // clamp witness A (schema#109)
  { value: 16777215.0, min: 0.0, max: 16777215.0, res: 1.0 },  // clamp witness B
  { value: 0.0, min: 0.0, max: 1.0, res: 1.0 },             // a one bit field, both codes
  { value: 1.0, min: 0.0, max: 1.0, res: 1.0 },
];

const BYTES_VECTORS = [
  { length: 0, fill: 0x00 },   // zero length: the align happens anyway
  { length: 8, fill: 0x00 },
  { length: 8, fill: 0xff },
  { length: 1, fill: 0x5a },
];

const STRING_BUFFER_SIZE = 16;
const STRINGS = [
  '',                                       // empty
  '0123456789abcde',                        // fifteen bytes: the most buffer size 16 carries
  '\u043C\u0438\u0440',                     // "\u043C\u0438\u0440", six UTF-8 bytes: explicit code points, so no
                                            // source file encoding can reach the wire
];

const WSTRING_BUFFER_SIZE = 8;
const WIDE_STRINGS = [
  '',                                       // empty
  '\u043C\u0438\u0440',                     // basic plane
  '\uE000',                                 // the first code unit above the surrogate block
  '\uFFFF',                                 // the largest code unit there is
  'A\uD83D\uDE00B',                          // U+1F600 as its surrogate pair: four code units
  'abcdefg',                                // seven code units, the most buffer size 8 carries
];

// --------------------------------------------------------------------------
// bit pattern conversion: the float fields are defined by their bits, and
// compared by their bits, because a value comparison cannot see -0.0

const SCRATCH = new DataView(new ArrayBuffer(8));

function floatFromBits(bits) {
  SCRATCH.setUint32(0, bits >>> 0, true);
  return SCRATCH.getFloat32(0, true);
}

function bitsFromFloat(value) {
  SCRATCH.setFloat32(0, value, true);
  return SCRATCH.getUint32(0, true);
}

function doubleFromBits(bits) {
  SCRATCH.setBigUint64(0, bits, true);
  return SCRATCH.getFloat64(0, true);
}

function bitsFromDouble(value) {
  SCRATCH.setFloat64(0, value, true);
  return SCRATCH.getBigUint64(0, true);
}

// --------------------------------------------------------------------------
// the message

/** Holders for every field, filled from the tables for the write side. */
function interopData() {
  return {
    bits: BITS_VECTORS.map((vector) => ({ value: vector.value })),
    bools: [{ value: true }, { value: false }],
    uint8: UINT8_VALUES.map((value) => ({ value })),
    uint16: UINT16_VALUES.map((value) => ({ value })),
    uint32: UINT32_VALUES.map((value) => ({ value })),
    uint64: UINT64_VALUES.map((value) => ({ value })),
    uint128: UINT128_VALUES.map((value) => ({ value })),
    int: INT_VECTORS.map((vector) => ({ value: vector.value })),
    int64: INT64_VECTORS.map((vector) => ({ value: vector.value })),
    int128: INT128_VECTORS.map((vector) => ({ value: vector.value })),
    fixedQ8_8Min: { value: -100 * 256 },                    // the bottom of the range
    fixedQ8_8Max: { value: 100 * 256 },                     // the top
    fixedQ16_16Degenerate: { value: 7 * 65536 },            // min === max: zero bits
    fixedQ48_16Min: { value: -100000n * 65536n },           // 34 bits on the wire
    fixedQ48_16Max: { value: 100000n * 65536n },
    fixedQ112_16Max: { value: 144115188075855872n << 16n }, // 75 bits, three groups
    fixedQ64_64Degenerate: { value: 5n << 64n },            // zero bits at 128 bit storage
    fixedQ64_64Max: { value: INT64_MAX << 64n },            // 128 bits, four groups
    relative: RELATIVE_VECTORS.map((vector) => ({ value: vector.current })),
    floats: FLOAT_BITS.map((bits) => ({ value: floatFromBits(bits) })),
    doubles: DOUBLE_BITS.map((bits) => ({ value: doubleFromBits(bits) })),
    compressedFloats: COMPRESSED_FLOAT_VECTORS.map((vector) => ({ value: vector.value })),
    filler: { value: 5 },
    bytes: BYTES_VECTORS.map((vector) => new Uint8Array(vector.length).fill(vector.fill)),
    strings: STRINGS.map((value) => ({ value })),
    wideStrings: WIDE_STRINGS.map((value) => ({ value })),
  };
}

/** Empty holders for the read side: the stream fills every one of them. */
function readData() {
  const data = interopData();
  for (const key of Object.keys(data)) {
    const field = data[key];
    if (Array.isArray(field)) {
      data[key] = field.map((entry) =>
        entry instanceof Uint8Array ? new Uint8Array(entry.length) : {});
    } else {
      data[key] = {};
    }
  }
  return data;
}

// the port splits raw bits at 32; the wire does not
function serializeBitsField(stream, ref, bits) {
  return bits <= 32 ? stream.serializeBits(ref, bits) : stream.serializeBits64(ref, bits);
}

/** The message, operation for operation. The && chain stops at the first refusal. */
function interopSerialize(stream, data) {
  // ----- raw bit groups
  for (let i = 0; i < BITS_VECTORS.length; i++) {
    if (!serializeBitsField(stream, data.bits[i], BITS_VECTORS[i].bits)) return false;
  }

  // ----- bool, both codes
  for (const ref of data.bools) {
    if (!stream.serializeBool(ref)) return false;
  }

  // both sides of the alignment rule: the stream is unaligned here, so the first
  // align pads and the second must write nothing at all
  if (!stream.serializeAlign()) return false;
  if (!stream.serializeAlign()) return false;

  // ----- the fixed width unsigned helpers, at their domain edges
  for (const ref of data.uint8) if (!stream.serializeUint8(ref)) return false;
  for (const ref of data.uint16) if (!stream.serializeUint16(ref)) return false;
  for (const ref of data.uint32) if (!stream.serializeUint32(ref)) return false;
  for (const ref of data.uint64) if (!stream.serializeUint64(ref)) return false;
  for (const ref of data.uint128) if (!stream.serializeUint128(ref)) return false;

  // ----- ranged integers
  for (let i = 0; i < INT_VECTORS.length; i++) {
    if (!stream.serializeInt(data.int[i], INT_VECTORS[i].min, INT_VECTORS[i].max)) return false;
  }
  for (let i = 0; i < INT64_VECTORS.length; i++) {
    if (!stream.serializeInt64(data.int64[i], INT64_VECTORS[i].min, INT64_VECTORS[i].max)) return false;
  }
  for (let i = 0; i < INT128_VECTORS.length; i++) {
    if (!stream.serializeInt128(data.int128[i], INT128_VECTORS[i].min, INT128_VECTORS[i].max)) return false;
  }

  // ----- fixed point, at the ends of its ranges and degenerate on two storage widths
  if (!stream.serializeAlign()) return false;
  if (!stream.serializeFixed(data.fixedQ8_8Min, 8, 8, -100, 100)) return false;
  if (!stream.serializeFixed(data.fixedQ8_8Max, 8, 8, -100, 100)) return false;
  if (!stream.serializeFixed(data.fixedQ16_16Degenerate, 16, 16, 7, 7)) return false;
  if (!stream.serializeFixed(data.fixedQ48_16Min, 48, 16, -100000n, 100000n)) return false;
  if (!stream.serializeFixed(data.fixedQ48_16Max, 48, 16, -100000n, 100000n)) return false;
  if (!stream.serializeFixed(data.fixedQ112_16Max, 112, 16, -144115188075855872n, 144115188075855872n)) return false;
  if (!stream.serializeFixed(data.fixedQ64_64Degenerate, 64, 64, 5n, 5n)) return false;
  if (!stream.serializeFixed(data.fixedQ64_64Max, 64, 64, INT64_MIN, INT64_MAX)) return false;

  // ----- int_relative: every tier at both ends, and the domain edges
  for (let i = 0; i < RELATIVE_VECTORS.length; i++) {
    if (!stream.serializeIntRelative(RELATIVE_VECTORS[i].previous, data.relative[i])) return false;
  }

  // ----- float and double, bit transparent at the domain edges
  for (const ref of data.floats) if (!stream.serializeFloat(ref)) return false;
  for (const ref of data.doubles) if (!stream.serializeDouble(ref)) return false;

  // ----- compressed_float
  for (let i = 0; i < COMPRESSED_FLOAT_VECTORS.length; i++) {
    const vector = COMPRESSED_FLOAT_VECTORS[i];
    if (!stream.serializeCompressedFloat(data.compressedFloats[i], vector.min, vector.max, vector.res)) {
      return false;
    }
  }

  // ----- bytes. The three bit filler leaves the stream unaligned, so the align
  // that begins the first block -- a ZERO LENGTH one -- is load bearing.
  if (!stream.serializeBits(data.filler, 3)) return false;
  for (const block of data.bytes) {
    if (!stream.serializeBytes(block)) return false;
  }

  // ----- string: empty, full, and multi-byte UTF-8
  for (const ref of data.strings) {
    if (!stream.serializeString(ref, STRING_BUFFER_SIZE)) return false;
  }

  // ----- wstring: empty, basic plane, the code unit boundaries, a surrogate pair, full
  for (const ref of data.wideStrings) {
    if (!stream.serializeWideString(ref, WSTRING_BUFFER_SIZE)) return false;
  }

  return true;
}

/**
 * What a conforming reader recovers. Everything is exact except the compressed
 * floats, which are lossy by construction: the reader returns the nearest
 * quantum, so they are compared within one resolution step.
 */
function interopCheck(data) {
  const problems = [];
  const equal = (label, actual, expected) => {
    if (actual !== expected) problems.push(`${label}: got ${actual}, expected ${expected}`);
  };

  for (let i = 0; i < BITS_VECTORS.length; i++) equal(`bits[${i}]`, data.bits[i].value, BITS_VECTORS[i].value);
  equal('bool[0]', data.bools[0].value, true);
  equal('bool[1]', data.bools[1].value, false);
  for (let i = 0; i < UINT8_VALUES.length; i++) equal(`uint8[${i}]`, data.uint8[i].value, UINT8_VALUES[i]);
  for (let i = 0; i < UINT16_VALUES.length; i++) equal(`uint16[${i}]`, data.uint16[i].value, UINT16_VALUES[i]);
  for (let i = 0; i < UINT32_VALUES.length; i++) equal(`uint32[${i}]`, data.uint32[i].value, UINT32_VALUES[i]);
  for (let i = 0; i < UINT64_VALUES.length; i++) equal(`uint64[${i}]`, data.uint64[i].value, UINT64_VALUES[i]);
  for (let i = 0; i < UINT128_VALUES.length; i++) equal(`uint128[${i}]`, data.uint128[i].value, UINT128_VALUES[i]);
  for (let i = 0; i < INT_VECTORS.length; i++) equal(`int[${i}]`, data.int[i].value, INT_VECTORS[i].value);
  for (let i = 0; i < INT64_VECTORS.length; i++) equal(`int64[${i}]`, data.int64[i].value, INT64_VECTORS[i].value);
  for (let i = 0; i < INT128_VECTORS.length; i++) equal(`int128[${i}]`, data.int128[i].value, INT128_VECTORS[i].value);

  const expected = interopData();
  for (const field of [
    'fixedQ8_8Min', 'fixedQ8_8Max', 'fixedQ16_16Degenerate', 'fixedQ48_16Min',
    'fixedQ48_16Max', 'fixedQ112_16Max', 'fixedQ64_64Degenerate', 'fixedQ64_64Max',
    'filler',
  ]) {
    equal(field, data[field].value, expected[field].value);
  }

  for (let i = 0; i < RELATIVE_VECTORS.length; i++) {
    equal(`int_relative[${i}]`, data.relative[i].value, RELATIVE_VECTORS[i].current);
  }
  for (let i = 0; i < FLOAT_BITS.length; i++) {
    equal(`float[${i}]`, bitsFromFloat(data.floats[i].value), FLOAT_BITS[i] >>> 0);
  }
  for (let i = 0; i < DOUBLE_BITS.length; i++) {
    equal(`double[${i}]`, bitsFromDouble(data.doubles[i].value), DOUBLE_BITS[i]);
  }
  for (let i = 0; i < COMPRESSED_FLOAT_VECTORS.length; i++) {
    const vector = COMPRESSED_FLOAT_VECTORS[i];
    const decoded = data.compressedFloats[i].value;
    if (!(Math.abs(decoded - vector.value) <= vector.res)) {
      problems.push(`compressed_float[${i}]: got ${decoded}, expected ${vector.value} within ${vector.res}`);
    }
  }
  for (let i = 0; i < BYTES_VECTORS.length; i++) {
    const block = data.bytes[i];
    const want = expected.bytes[i];
    if (block.length !== want.length || block.some((byte, index) => byte !== want[index])) {
      problems.push(`bytes[${i}]: got ${block}, expected ${want}`);
    }
  }
  for (let i = 0; i < STRINGS.length; i++) equal(`string[${i}]`, data.strings[i].value, STRINGS[i]);
  for (let i = 0; i < WIDE_STRINGS.length; i++) equal(`wstring[${i}]`, data.wideStrings[i].value, WIDE_STRINGS[i]);

  return problems;
}

// --------------------------------------------------------------------------
// the three modes

// a multiple of 8, as the write stream requires
const BUFFER_BYTES = 1024;

function encode(data) {
  const buffer = new Uint8Array(BUFFER_BYTES);
  const stream = new WriteStream(buffer);
  if (!interopSerialize(stream, data)) {
    throw new Error(`interop js: serialize failed (${String(stream.error)})`);
  }
  stream.flush();
  return buffer.subarray(0, stream.bytesProcessed());
}

function write(path) {
  const bytes = encode(interopData());
  writeFileSync(path, bytes);
  console.log(`interop js: wrote ${bytes.length} bytes to ${path}`);
}

function read(path) {
  const input = new Uint8Array(readFileSync(path));
  const data = readData();
  const stream = new ReadStream(input);
  if (!interopSerialize(stream, data)) {
    throw new Error(`interop js: could not decode ${path} (${String(stream.error)})`);
  }
  const problems = interopCheck(data);
  if (problems.length > 0) {
    throw new Error(`interop js: ${path} decoded to unexpected values:\n  ${problems.join('\n  ')}`);
  }
  // re-encode what was decoded: the bytes must be identical to the input
  const reencoded = encode(data);
  if (reencoded.length !== input.length || reencoded.some((byte, index) => byte !== input[index])) {
    throw new Error(`interop js: re-encoded bytes differ from ${path}`);
  }
  console.log(`interop js: decoded and re-encoded ${input.length} bytes from ${path}, byte identical`);
}

// The hostile half: every proper prefix of a valid stream is a truncated stream,
// and a conforming reader refuses every one of them without ever throwing.
function refuse(path) {
  const input = new Uint8Array(readFileSync(path));
  for (let length = 0; length < input.length; length++) {
    const truncated = input.subarray(0, length);
    const data = readData();
    const stream = new ReadStream(truncated);
    let accepted;
    try {
      accepted = interopSerialize(stream, data);
    } catch (error) {
      throw new Error(`interop js refuse: the ${length} byte prefix of ${path} THREW: ${error}`);
    }
    if (accepted) {
      throw new Error(`interop js refuse: the ${length} byte prefix of ${path} was ACCEPTED`);
    }
  }
  console.log(`interop js: refused all ${input.length} truncated prefixes of ${path}`);
}

const [mode, path] = process.argv.slice(2);
if (!path || !['write', 'read', 'refuse'].includes(mode)) {
  console.error('usage: node interop/interop.mjs write|read|refuse <file>');
  process.exit(2);
}
try {
  if (mode === 'write') write(path);
  else if (mode === 'read') read(path);
  else refuse(path);
} catch (error) {
  console.error(error.message ?? error);
  process.exit(1);
}
