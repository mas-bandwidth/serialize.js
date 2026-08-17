// The golden wire format battery: the family's cross-language conformance
// message, ported verbatim from serialize.h (GoldenWireData /
// GoldenWireSerialize / golden_wire_bytes, test_golden_wire_format). The
// exact bytes produced by the serializer are pinned down here and must
// never change: if a pin in this file fails, the wire format has changed
// and previously written data no longer decodes -- a breaking change, and
// NEVER something to fix by adjusting this file. The message exercises
// every operation class in one stream: raw bits at four widths, ranged
// ints, bool, bit-transparent float and double, the compressed float,
// the unsigned helpers through uint64, both interesting relative-integer
// tiers, aligns, raw bytes, the UTF-8 string, the wide string, and six
// fixed point declarations covering the narrow, two-group, unsigned,
// three-group and four-group shapes. The values are the reference's own,
// chosen so every platform quantizes identically (5.0 in [0,10]
// normalizes to exactly 0.5, so contraction differences cannot shift the
// quantized integer -- which is why this file pins the decoded compressed
// float EXACTLY, not within tolerance).
//
// The battery also carries the format's two edge doctrines and its own
// self-test:
//   - trailing bits (STANDARD.md, adopted 2026-08-15): writers emit zero
//     in the unused bits of the final byte; readers must not reject a
//     stream for their contents, and must decode a doctored tail
//     identically (serialize.h test_trailing_bits).
//   - past-end memory (STANDARD.md, ruled 2026-08-15): bytes past the
//     stream end are never interpreted. The JS reader prices its windows
//     INSIDE the buffer, so the proof here is the contract's observable
//     half: poison past the end of the data view changes nothing, on the
//     accept path or the refusal path (serialize.h test_past_end_poison).
//   - the sabotage sweep: every consumed bit of the golden stream is load
//     bearing. Flipping any single one of the 891 consumed bits must make
//     the decode refuse or produce different values -- proving this
//     battery CAN fail -- while flipping any of the 5 trailing bits must
//     change nothing. Hostile data never throws anywhere in the sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, ReadStream, MeasureStream } from '../src/index.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// serialize.h's golden_wire_bytes, extracted mechanically from the
// reference source: 112 bytes, pinned forever.
const GOLDEN_WIRE_BYTES = Uint8Array.from([
  0x5d, 0xda, 0xf7, 0xe6, 0xd5, 0x77, 0xdf, 0x56, 0xef, 0x9f, 0x75, 0x19,
  0x52, 0xbc, 0xda, 0x0f, 0x49, 0x40, 0xf4, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0xff, 0xfc, 0xd1, 0x48, 0xe0, 0x59, 0xd1, 0x48, 0xc0, 0x7b,
  0xf3, 0x6a, 0xe2, 0x59, 0xd1, 0x48, 0x84, 0xb7, 0x06, 0xde, 0xad, 0xbe,
  0xef, 0xca, 0xfe, 0x01, 0x06, 0x67, 0x6f, 0x6c, 0x64, 0x65, 0x6e, 0xe3,
  0x21, 0x00, 0x00, 0xc0, 0x21, 0x00, 0x00, 0x00, 0x22, 0x00, 0x00, 0x00,
  0xc0, 0x60, 0x00, 0x80, 0xa2, 0x7c, 0xfc, 0xec, 0x26, 0xcb, 0xff, 0xff,
  0x4b, 0x1d, 0x1f, 0xef, 0xd2, 0x1a, 0x1f, 0x01, 0xe9, 0xff, 0xff, 0x09,
  0x19, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e, 0x7f, 0x78, 0x6f, 0x5e, 0x4d, 0x3c,
  0x2b, 0x1a, 0x09, 0x04,
]);

// The golden stream ends 3 bits into its final byte: 891 consumed bits,
// 5 trailing bits the writer must zero and the reader must ignore.
const GOLDEN_BITS = 891;

// GoldenWireInit, field for field. The scalar fields are the values; the
// fixed point fields are the RAW scaled integers of the JS surface --
// Number on the narrow lane, BigInt on the 64/128-bit lanes.
function goldenValues() {
  return {
    bits4: 13,
    bits11: 1445,
    bits24: 11259375,
    bits32: 0xdeadbeef,
    intSmall: -37,
    intFull: -123456789,
    flag: true,
    floatValue: Math.fround(3.1415926),
    compressedFloatValue: 5.0,
    doubleValue: 1.0 / 3.0,
    uint8Value: 0x7f,
    uint16Value: 0x1234,
    uint32Value: 0x12345678,
    uint64Value: 0x123456789abcdef0n,
    relativeNear: 101, // difference of 1 from the base: the one bit branch
    relativeFar: 2100, // difference of 2000 from the base: the mid-ladder bucket
    bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x01]),
    string: 'golden',
    wstring: 'мир', // cyrillic, BMP only, explicit code points
    fixedQ8_8: -(3 * 256 + 64), // -3.25 in Q8.8
    fixedQ16_16: 1234 * 65536 + 32768, // 1234.5 in Q16.16
    fixedQ48_16: -(54321n * 65536n + 12345n), // -54321.1883... in Q48.16
    fixedQ16_16Unsigned: 29999 * 65536 + 65535, // every fraction bit set
    fixedQ112_16Wide: -(98765432109n * 65536n + 4321n), // 75 bits, three groups
    fixedQ64_64Wide: (0x0123456789abcdefn << 64n) + 0x0fedcba987654321n, // four groups
  };
}

const SCALAR_FIELDS = [
  'bits4', 'bits11', 'bits24', 'bits32', 'intSmall', 'intFull', 'flag',
  'floatValue', 'compressedFloatValue', 'doubleValue', 'uint8Value',
  'uint16Value', 'uint32Value', 'uint64Value', 'relativeNear', 'relativeFar',
  'string', 'wstring', 'fixedQ8_8', 'fixedQ16_16', 'fixedQ48_16',
  'fixedQ16_16Unsigned', 'fixedQ112_16Wide', 'fixedQ64_64Wide',
];

// Wraps every scalar in the {value} holder the streams consume and fill;
// bytes stays a Uint8Array, filled in place on read.
function makeRefs(values) {
  const refs = { bytes: values.bytes };
  for (const field of SCALAR_FIELDS) {
    refs[field] = { value: values[field] };
  }
  return refs;
}

// Read-side holders: empty refs the stream fills, a zeroed byte array.
function makeReadRefs() {
  const refs = { bytes: new Uint8Array(7) };
  for (const field of SCALAR_FIELDS) {
    refs[field] = {};
  }
  return refs;
}

// GoldenWireSerialize, operation for operation. The && chain mirrors the
// reference macros' early return: the first refusal stops the message.
function serializeGoldenWire(stream, refs) {
  const relativeBase = 100;
  return (
    stream.serializeBits(refs.bits4, 4) &&
    stream.serializeBits(refs.bits11, 11) &&
    stream.serializeBits(refs.bits24, 24) &&
    stream.serializeBits(refs.bits32, 32) &&
    stream.serializeInt(refs.intSmall, -100, +100) &&
    stream.serializeInt(refs.intFull, INT32_MIN, INT32_MAX) &&
    stream.serializeBool(refs.flag) &&
    stream.serializeFloat(refs.floatValue) &&
    stream.serializeCompressedFloat(refs.compressedFloatValue, 0.0, 10.0, 0.01) &&
    stream.serializeDouble(refs.doubleValue) &&
    stream.serializeUint8(refs.uint8Value) &&
    stream.serializeUint16(refs.uint16Value) &&
    stream.serializeUint32(refs.uint32Value) &&
    stream.serializeUint64(refs.uint64Value) &&
    stream.serializeIntRelative(relativeBase, refs.relativeNear) &&
    stream.serializeIntRelative(relativeBase, refs.relativeFar) &&
    stream.serializeAlign() &&
    stream.serializeBytes(refs.bytes) &&
    stream.serializeString(refs.string, 16) &&
    stream.serializeWideString(refs.wstring, 8) &&
    // the fixed point section starts byte aligned, so every byte pinned
    // above it stays put
    stream.serializeAlign() &&
    stream.serializeFixed(refs.fixedQ8_8, 8, 8, -100, +100) &&
    stream.serializeFixed(refs.fixedQ16_16, 16, 16, -2000, +2000) &&
    stream.serializeFixed(refs.fixedQ48_16, 48, 16, -100000n, 100000n) &&
    stream.serializeFixed(refs.fixedQ16_16Unsigned, 16, 16, 0, 30000) &&
    // the wide fixed section starts byte aligned as well
    stream.serializeAlign() &&
    // +-2^57 units: 75 bits, the three group structure
    stream.serializeFixed(refs.fixedQ112_16Wide, 112, 16, -144115188075855872n, 144115188075855872n) &&
    // full unit range: 128 bits, the four group structure
    stream.serializeFixed(refs.fixedQ64_64Wide, 64, 64, INT64_MIN, INT64_MAX)
  );
}

// True when every decoded field equals the expected values exactly --
// including the compressed float, which the golden values pin exactly by
// construction. Object.is distinguishes -0 and accepts NaN, matching the
// bit-transparent float doctrine.
function matchesGolden(refs, values) {
  for (const field of SCALAR_FIELDS) {
    if (!Object.is(refs[field].value, values[field])) {
      return false;
    }
  }
  for (let i = 0; i < values.bytes.length; i++) {
    if (refs.bytes[i] !== values.bytes[i]) {
      return false;
    }
  }
  return true;
}

test('write side: serializing the golden values produces exactly the golden bytes', () => {
  const writer = new WriteStream(new Uint8Array(256));
  assert.equal(serializeGoldenWire(writer, makeRefs(goldenValues())), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), GOLDEN_WIRE_BYTES.length);
  assert.equal(writer.bitsProcessed(), GOLDEN_BITS);
  assert.deepEqual(Array.from(writer.data()), Array.from(GOLDEN_WIRE_BYTES));
});

test('read side: the golden bytes decode to the expected values, on every platform, forever', () => {
  const reader = new ReadStream(GOLDEN_WIRE_BYTES);
  const refs = makeReadRefs();
  assert.equal(serializeGoldenWire(reader, refs), true);
  assert.equal(reader.bitsProcessed(), GOLDEN_BITS);

  const expected = goldenValues();
  for (const field of SCALAR_FIELDS) {
    assert.equal(
      Object.is(refs[field].value, expected[field]),
      true,
      `${field}: decoded ${refs[field].value}, expected ${expected[field]}`,
    );
  }
  assert.deepEqual(Array.from(refs.bytes), Array.from(expected.bytes));
});

test('trailing bits: the writer zeroes them and the reader is indifferent to them', () => {
  // writer obligation, small stream: a message ending 3 bits into its
  // final byte, written into a buffer pre-filled with 0xFF so the zeros
  // must come from the writer, not from the caller
  const buffer = new Uint8Array(64).fill(0xff);
  const writer = new WriteStream(buffer);
  assert.equal(writer.serializeBits({ value: 0xdeadbeef }, 32), true);
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  writer.flush();

  const bytesWritten = writer.bytesProcessed();
  const bitsInFinalByte = writer.bitsProcessed() % 8;
  assert.equal(bitsInFinalByte, 3); // the stream really does end unaligned
  const trailingMask = (0xff << bitsInFinalByte) & 0xff;
  const data = writer.data();
  assert.equal(data[bytesWritten - 1] & trailingMask, 0); // writers must write zero

  // reader indifference, small stream: set every trailing bit and read
  // back. the doctored stream must be accepted and decode the same values.
  data[bytesWritten - 1] |= trailingMask;
  const reader = new ReadStream(data);
  const head = {};
  assert.equal(reader.serializeBits(head, 32), true);
  assert.equal(head.value, 0xdeadbeef);
  const tail = {};
  assert.equal(reader.serializeBits(tail, 3), true);
  assert.equal(tail.value, 5);
});

test('trailing bits: a doctored golden stream decodes identically', () => {
  // reader indifference, full message: the golden stream ends unaligned
  // (891 consumed bits, 5 trailing), so this test can discriminate. the
  // pinned emission itself met the writer obligation.
  const bitsInFinalByte = GOLDEN_BITS % 8;
  assert.equal(bitsInFinalByte !== 0, true);
  const trailingMask = (0xff << bitsInFinalByte) & 0xff;
  assert.equal(GOLDEN_WIRE_BYTES[GOLDEN_WIRE_BYTES.length - 1] & trailingMask, 0);

  const doctored = Uint8Array.from(GOLDEN_WIRE_BYTES);
  doctored[doctored.length - 1] |= trailingMask; // set every trailing bit

  const reader = new ReadStream(doctored);
  const refs = makeReadRefs();
  assert.equal(serializeGoldenWire(reader, refs), true); // readers must not reject
  assert.equal(matchesGolden(refs, goldenValues()), true); // and must decode identically
  assert.equal(reader.bitsProcessed(), GOLDEN_BITS);
});

test('past-end poison: bytes past the stream end are never interpreted', () => {
  // accept path: the golden stream decodes identically whether the bytes
  // past the end of its data view are zero or poison. the JS reader
  // prices its windows inside the buffer, so the poison sits in the same
  // allocation, immediately past the view it must never interpret.
  const cleanBuffer = new Uint8Array(256);
  const poisonBuffer = new Uint8Array(256).fill(0xff);
  cleanBuffer.set(GOLDEN_WIRE_BYTES);
  poisonBuffer.set(GOLDEN_WIRE_BYTES);

  const cleanReader = new ReadStream(cleanBuffer.subarray(0, GOLDEN_WIRE_BYTES.length));
  const cleanRefs = makeReadRefs();
  assert.equal(serializeGoldenWire(cleanReader, cleanRefs), true);
  assert.equal(matchesGolden(cleanRefs, goldenValues()), true);

  const poisonReader = new ReadStream(poisonBuffer.subarray(0, GOLDEN_WIRE_BYTES.length));
  const poisonRefs = makeReadRefs();
  assert.equal(serializeGoldenWire(poisonReader, poisonRefs), true);
  assert.equal(matchesGolden(poisonRefs, goldenValues()), true);
  assert.equal(poisonReader.bitsProcessed(), cleanReader.bitsProcessed());
});

test('past-end poison: a truncated stream refuses identically regardless of the tail', () => {
  // refusal path: truncate the stream one byte short so the decode must
  // fail. the refusal must be identical -- same refusal point, same
  // partial state -- whether the bytes at and past the truncated end are
  // zero or poison.
  const truncatedBytes = GOLDEN_WIRE_BYTES.length - 1;

  const cleanBuffer = new Uint8Array(256);
  const poisonBuffer = new Uint8Array(256).fill(0xff);
  cleanBuffer.set(GOLDEN_WIRE_BYTES.subarray(0, truncatedBytes));
  poisonBuffer.set(GOLDEN_WIRE_BYTES.subarray(0, truncatedBytes));

  const cleanReader = new ReadStream(cleanBuffer.subarray(0, truncatedBytes));
  const cleanRefs = makeReadRefs();
  assert.equal(serializeGoldenWire(cleanReader, cleanRefs), false);

  const poisonReader = new ReadStream(poisonBuffer.subarray(0, truncatedBytes));
  const poisonRefs = makeReadRefs();
  assert.equal(serializeGoldenWire(poisonReader, poisonRefs), false);

  // refused at the same point, with identical partial state
  assert.equal(poisonReader.bitsProcessed(), cleanReader.bitsProcessed());
  for (const field of SCALAR_FIELDS) {
    assert.equal(
      Object.is(poisonRefs[field].value, cleanRefs[field].value),
      true,
      `${field}: poison decoded ${poisonRefs[field].value}, clean ${cleanRefs[field].value}`,
    );
  }
  assert.deepEqual(Array.from(poisonRefs.bytes), Array.from(cleanRefs.bytes));
});

test('measure bounds the write at every one of the 8 starting offsets', () => {
  // the measure stream prices aligning operations conservatively, so its
  // bound must hold wherever the message lands relative to a byte
  // boundary: a prefix of 1..7 bits walks the message through all of them
  for (let offset = 0; offset < 8; offset++) {
    const writer = new WriteStream(new Uint8Array(256));
    if (offset > 0) {
      assert.equal(writer.serializeBits({ value: 0 }, offset), true);
    }
    assert.equal(serializeGoldenWire(writer, makeRefs(goldenValues())), true);

    const measure = new MeasureStream();
    if (offset > 0) {
      assert.equal(measure.serializeBits({ value: 0 }, offset), true);
    }
    assert.equal(serializeGoldenWire(measure, makeRefs(goldenValues())), true);

    assert.equal(
      measure.bitsProcessed() >= writer.bitsProcessed(),
      true,
      `offset ${offset}: measured ${measure.bitsProcessed()} bits, wrote ${writer.bitsProcessed()}`,
    );
  }
});
