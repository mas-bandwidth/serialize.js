// Checked vs production writer and measure operation-parity suite.
//
// Builds one deterministic operation table covering every supported valid
// BitWriter, WriteStream, and MeasureStream operation and internal branch:
//   - 32/64/128-bit group boundaries (bits 1..32, bits64 1..64 across single
//     and two-group splits, int128 and fixed across 1, 2, 3, and 4 groups)
//   - degenerate 0-bit ranges (int, int64, int128, fixed with min === max)
//   - signed and unsigned integer ranges (int, int64, int128, uint8, uint16,
//     uint32, uint64, uint128, bool, and all 7 int_relative tiers)
//   - all fixed-point storage widths (8, 16, 32, 64, 128), signed and
//     unsigned, fractionBits === 0 and > 0, degenerate, and 1..4 groups
//   - finite float, double, and compressed_float edge witnesses (+0.0, -0.0,
//     subnormals, normals, +-FLT_MAX, +-DBL_MAX, off-quantum two-rounding
//     witnesses, nonzero min, out-of-range finite clamps, values < 1.0 clamp,
//     values > 4294967040.0 clamp, schema#109 maxIntegerValue >= 2^23 clamp)
//   - empty and non-empty bytes and strings across aligned and unaligned bit
//     offsets, head/word/tail splits, and the SMALL_COPY_BYTES = 64 threshold,
//     including bufferSize = 1 zero-bit empty string prefix and multi-byte UTF-8
//   - alignment and end (writeAlign / serializeAlign from offsets 0..7,
//     serializeEnd, flushBits / flush on even and odd word indices)
//   - exact-capacity fit vs past-capacity overflow (tryWriteBits and every
//     WriteStream operation family: a throw that writes nothing and latches
//     nothing (IMPLEMENTING.md U9), and reset() reuse)
//
// Executes the entire table in fresh module-load processes for checked
// (NODE_ENV=development) and production (NODE_ENV=production) modes and
// compares canonical bytes, bit counts, byte counts, available bits, align
// bits, MeasureStream counts, and overflow state operation by operation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCTION } from '../../src/mode.js';
import {
  BitWriter,
  BitReader,
  WriteStream,
  ReadStream,
  MeasureStream,
  bitsRequired,
  bitsRequired64,
  bitsRequired128,
} from '../../src/index.js';

const THIS_FILE = fileURLToPath(import.meta.url);

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

// STANDARD.md's whole message: 29 operations, 843 field bits, 106 bytes.
const GOLDEN_WIRE_BYTES = Uint8Array.from([
  0x5d, 0xda, 0xf7, 0xe6, 0xd5, 0x77, 0xdf, 0x56, 0xef, 0x9f, 0x75, 0x19,
  0x52, 0xbc, 0xda, 0x0f, 0x49, 0x40, 0xf4, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0xff, 0xfc, 0xd1, 0x48, 0xe0, 0x59, 0xd1, 0x48, 0xc0, 0x7b,
  0xf3, 0x6a, 0xe2, 0x59, 0xd1, 0x48, 0x84, 0xb7, 0x06, 0xde, 0xad, 0xbe,
  0xef, 0xca, 0xfe, 0x01, 0x06, 0x67, 0x6f, 0x6c, 0x64, 0x65, 0x6e, 0x06,
  0xe7, 0xa2, 0x81, 0xe7, 0x9f, 0xb3, 0xc0, 0x60, 0x00, 0x80, 0xa2, 0x7c,
  0xfc, 0xec, 0x26, 0xcb, 0xff, 0xff, 0x4b, 0x1d, 0x1f, 0xef, 0xd2, 0x1a,
  0x1f, 0x01, 0xe9, 0xff, 0xff, 0x09, 0x19, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e,
  0x7f, 0x78, 0x6f, 0x5e, 0x4d, 0x3c, 0x2b, 0x1a, 0x09, 0x04,
]);

const GOLDEN_SCALAR_FIELDS = [
  'bits4', 'bits11', 'bits24', 'bits32', 'intSmall', 'intFull', 'flag',
  'floatValue', 'compressedFloatValue', 'doubleValue', 'uint8Value',
  'uint16Value', 'uint32Value', 'uint64Value', 'relativeNear', 'relativeFar',
  'string', 'cjk', 'fixedQ8_8', 'fixedQ16_16', 'fixedQ48_16',
  'fixedQ16_16Unsigned', 'fixedQ112_16Wide', 'fixedQ64_64Wide',
];

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
    relativeNear: 101,
    relativeFar: 2100,
    bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x01]),
    string: 'golden',
    cjk: '\u7881\u77F3',
    fixedQ8_8: -(3 * 256 + 64),
    fixedQ16_16: 1234 * 65536 + 32768,
    fixedQ48_16: -(54321n * 65536n + 12345n),
    fixedQ16_16Unsigned: 29999 * 65536 + 65535,
    fixedQ112_16Wide: -(98765432109n * 65536n + 4321n),
    fixedQ64_64Wide: (0x0123456789abcdefn << 64n) + 0x0fedcba987654321n,
  };
}

function makeGoldenRefs(values) {
  const refs = { bytes: new Uint8Array(values.bytes) };
  for (const field of GOLDEN_SCALAR_FIELDS) {
    refs[field] = { value: values[field] };
  }
  return refs;
}

function makeGoldenReadRefs() {
  const refs = { bytes: new Uint8Array(7) };
  for (const field of GOLDEN_SCALAR_FIELDS) {
    refs[field] = {};
  }
  return refs;
}

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
    stream.serializeString(refs.cjk, 8) &&
    stream.serializeAlign() &&
    stream.serializeFixed(refs.fixedQ8_8, 8, 8, -100, +100) &&
    stream.serializeFixed(refs.fixedQ16_16, 16, 16, -2000, +2000) &&
    stream.serializeFixed(refs.fixedQ48_16, 48, 16, -100000n, 100000n) &&
    stream.serializeFixed(refs.fixedQ16_16Unsigned, 16, 16, 0, 30000) &&
    stream.serializeAlign() &&
    stream.serializeFixed(refs.fixedQ112_16Wide, 112, 16, -144115188075855872n, 144115188075855872n) &&
    stream.serializeFixed(refs.fixedQ64_64Wide, 64, 64, INT64_MIN, INT64_MAX) &&
    stream.serializeEnd()
  );
}

const FLOAT_SCRATCH = new DataView(new ArrayBuffer(8));

function float32Bits(value) {
  FLOAT_SCRATCH.setFloat32(0, value, true);
  return FLOAT_SCRATCH.getUint32(0, true);
}

function float64Bits(value) {
  FLOAT_SCRATCH.setFloat64(0, value, true);
  return FLOAT_SCRATCH.getBigUint64(0, true).toString(16).padStart(16, '0');
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function makePatternBytes(length, seed = 0) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = ((i * 73) + 19 + seed) & 0xff;
  }
  return out;
}

// Snapshot of a BitWriter state at a point in time.
function snapshotBitWriter(writer, rawBuffer) {
  return {
    bitsWritten: writer.bitsWritten(),
    bytesWritten: writer.bytesWritten(),
    bitsAvailable: writer.bitsAvailable(),
    alignBits: writer.alignBits(),
    dataHex: toHex(writer.data()),
    rawHex: toHex(rawBuffer),
  };
}

// Snapshot of a WriteStream state at a point in time.
function snapshotWriteStream(writer, rawBuffer) {
  return {
    ok: writer.ok,
    error: writer.error,
    bitsProcessed: writer.bitsProcessed(),
    bytesProcessed: writer.bytesProcessed(),
    bitsAvailable: writer.bitsAvailable(),
    alignBits: writer.alignBits(),
    dataHex: toHex(writer.data()),
    rawHex: toHex(rawBuffer),
  };
}

// Snapshot of a MeasureStream state at a point in time.
function snapshotMeasureStream(measure) {
  return {
    ok: measure.ok,
    error: measure.error,
    bitsProcessed: measure.bitsProcessed(),
    bytesProcessed: measure.bytesProcessed(),
    alignBits: measure.alignBits(),
  };
}

// Deterministic BitWriter operation table covering writeBits, tryWriteBits,
// writeAlign, writeBytes (<= 64 and > 64 bytes across head/word/tail splits),
// flushBits across even/odd wordIndex and partial scratch, reset() DataView
// cache hit/miss, and exact-capacity vs past-capacity tryWriteBits.
function collectBitWriterRecords() {
  const records = [];

  // 1. writeBits and tryWriteBits across every bit width 1..32, aligned and unaligned,
  // (a value wider than its bits is write misuse since 2.1, IMPLEMENTING.md
  // U8: the checked writer throws it, so every value here fits its width).
  for (let bits = 1; bits <= 32; bits++) {
    const maxVal = bits === 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
    const midVal = bits === 32 ? 0xa5a55a5a : (0xaaaaaaaa >>> (32 - bits));
    const values = [0, 1, midVal, maxVal, maxVal];

    const bufWrite = new Uint8Array(32).fill(0xff);
    const writer = new BitWriter(bufWrite);
    writer.writeBits(0b101, 3);
    for (const v of values) {
      writer.writeBits(v, bits);
    }
    writer.writeBits(0b10101, 5);
    writer.flushBits();

    const bufTry = new Uint8Array(32).fill(0xff);
    const tryWriter = new BitWriter(bufTry);
    const stepReturns = [];
    stepReturns.push(tryWriter.tryWriteBits(0b101, 3));
    for (const v of values) {
      stepReturns.push(tryWriter.tryWriteBits(v, bits));
    }
    stepReturns.push(tryWriter.tryWriteBits(0b10101, 5));
    tryWriter.flushBits();

    records.push({
      id: `bw.bits.${bits}`,
      writeSnap: snapshotBitWriter(writer, bufWrite),
      trySnap: snapshotBitWriter(tryWriter, bufTry),
      stepReturns,
    });
  }

  // 2. Scratch boundary transitions: newScratchBits < 32, === 32 (spill === 0), > 32 (spill > 0).
  const scratchBoundaries = [
    ['lt32', [[0x7fff, 15], [0xffff, 16]]],
    ['eq32_16_16', [[0x1234, 16], [0x5678, 16]]],
    ['eq32_1_31', [[1, 1], [0x7abcdef0, 31]]],
    ['eq32_31_1', [[0x7abcdef0, 31], [1, 1]]],
    ['eq32_0_32', [[0xdeadbeef, 32], [0xcafebabe, 32]]],
    ['gt32_31_2', [[0x7fffffff, 31], [0b11, 2]]],
    ['gt32_17_32', [[0x1abcd, 17], [0xdeadbeef, 32]]],
    ['gt32_31_32', [[0x7abcdef1, 31], [0x89abcdef, 32], [0x12345678, 32]]],
  ];
  for (const [name, pairs] of scratchBoundaries) {
    const buf = new Uint8Array(24).fill(0xff);
    const writer = new BitWriter(buf);
    for (const [val, bits] of pairs) {
      writer.writeBits(val, bits);
    }
    writer.flushBits();
    records.push({
      id: `bw.scratch.${name}`,
      snap: snapshotBitWriter(writer, buf),
    });
  }

  // 3. writeAlign at every bit offset 0..15 into a pre-dirtied buffer.
  for (let preBits = 0; preBits <= 15; preBits++) {
    const buf = new Uint8Array(16).fill(0xff);
    const writer = new BitWriter(buf);
    if (preBits > 0) {
      writer.writeBits((1 << preBits) - 1, preBits);
    }
    const alignBefore = writer.alignBits();
    writer.writeAlign();
    const alignAfter = writer.alignBits();
    writer.writeBits(0xa5, 8);
    writer.flushBits();
    records.push({
      id: `bw.align.pre_${preBits}`,
      alignBefore,
      alignAfter,
      snap: snapshotBitWriter(writer, buf),
    });
  }

  // 4. writeBytes across headBytes (byte offset 0, 1, 2, 3), SMALL_COPY_BYTES = 64
  // boundary (0, 1, 2, 3, 4, 7, 15, 31, 63, 64, 65, 66, 67, 68, 96, 128, 131),
  // and subarray views with non-zero byteOffset.
  const byteLengths = [0, 1, 2, 3, 4, 7, 15, 31, 63, 64, 65, 66, 67, 68, 96, 128, 131];
  for (const headByteOffset of [0, 1, 2, 3]) {
    for (const len of byteLengths) {
      const buf = new Uint8Array(160).fill(0xff);
      const writer = new BitWriter(buf);
      for (let h = 0; h < headByteOffset; h++) {
        writer.writeBits(0x30 + h, 8);
      }
      const backing = makePatternBytes(len + 10, headByteOffset * 17 + len);
      const payload = backing.subarray(3, 3 + len);
      writer.writeBytes(payload);
      writer.writeBits(0x5a, 7);
      writer.flushBits();
      records.push({
        id: `bw.bytes.head_${headByteOffset}.len_${len}`,
        snap: snapshotBitWriter(writer, buf),
      });
    }
  }

  // 5. flushBits across even/odd #wordIndex and #scratchBits === 0 vs !== 0.
  for (let words = 0; words <= 5; words++) {
    for (const extraBits of [0, 1, 7, 15, 16, 24, 31]) {
      const buf = new Uint8Array(32).fill(0xff);
      const writer = new BitWriter(buf);
      for (let w = 0; w < words; w++) {
        writer.writeBits((0x11223344 + w * 0x01020304) >>> 0, 32);
      }
      if (extraBits > 0) {
        writer.writeBits(((1 << extraBits) - 1) >>> 0, extraBits);
      }
      writer.flushBits();
      records.push({
        id: `bw.flush.words_${words}.extra_${extraBits}`,
        snap: snapshotBitWriter(writer, buf),
      });
    }
  }

  // 6. reset() DataView cache reuse (same Uint8Array) vs fresh Uint8Array.
  {
    const bufA = new Uint8Array(16).fill(0xff);
    const bufB = new Uint8Array(24).fill(0xff);
    const writer = new BitWriter(bufA);
    writer.writeBits(0xdeadbeef, 32);
    writer.writeBits(0x1f, 5);
    writer.flushBits();
    const firstSnap = snapshotBitWriter(writer, bufA);

    bufA.fill(0xee);
    writer.reset(bufA);
    writer.writeBits(0b1101, 4);
    writer.writeAlign();
    writer.writeBits(0x42, 8);
    writer.flushBits();
    const reuseSnap = snapshotBitWriter(writer, bufA);

    writer.reset(bufB);
    writer.writeBits(0x12345678, 32);
    writer.writeBits(0x9abcdef0, 32);
    writer.writeBits(0x7, 3);
    writer.flushBits();
    const freshSnap = snapshotBitWriter(writer, bufB);

    records.push({
      id: 'bw.reset.reuse_and_fresh',
      firstSnap,
      reuseSnap,
      freshSnap,
    });
  }

  // 7. tryWriteBits exact capacity vs past-capacity overflow.
  {
    const buf = new Uint8Array(8).fill(0xff);
    const writer = new BitWriter(buf);
    const steps = [];

    steps.push({ call: '5bits', ok: writer.tryWriteBits(0x15, 5), ...snapshotBitWriter(writer, buf) });
    steps.push({ call: '32bits', ok: writer.tryWriteBits(0x12345678, 32), ...snapshotBitWriter(writer, buf) });
    // 37 bits written, 27 bits remaining: 28 bits must fail without mutating state.
    steps.push({ call: 'overflow_28bits', ok: writer.tryWriteBits(0x0fffffff, 28), ...snapshotBitWriter(writer, buf) });
    // Exact remaining 27 bits must succeed and leave bitsAvailable === 0.
    steps.push({ call: 'exact_27bits', ok: writer.tryWriteBits(0x05555555, 27), ...snapshotBitWriter(writer, buf) });
    // 1 more bit at 0 available must fail without mutating state.
    steps.push({ call: 'overflow_1bit_at_end', ok: writer.tryWriteBits(1, 1), ...snapshotBitWriter(writer, buf) });
    writer.flushBits();
    steps.push({ call: 'flushed', ok: true, ...snapshotBitWriter(writer, buf) });

    records.push({
      id: 'bw.capacity.exact_and_overflow',
      steps,
    });
  }

  return records;
}

// Builds the deterministic list of single/composite valid stream scenarios.
// Each scenario provides:
//   - id: unique name
//   - bufferBytes: multiple of 4
//   - run(stream): executes operations on WriteStream or MeasureStream, returns array of step return booleans
//   - verifyRead(reader) (optional): verifies ReadStream decodes the written wire back to expected values
function buildValidStreamScenarios() {
  const scenarios = [];

  // Helper to add a scenario in both byte-aligned and unaligned (3-bit prefix) forms.
  function addAlignedAndUnaligned(baseId, bufferBytes, opFn, verifyOpFn) {
    for (const unaligned of [false, true]) {
      const id = unaligned ? `${baseId}.unaligned3` : `${baseId}.aligned`;
      scenarios.push({
        id,
        bufferBytes,
        run(stream) {
          const returns = [];
          if (unaligned) {
            returns.push(stream.serializeBits({ value: 0b101 }, 3));
          }
          opFn(stream, returns);
          return returns;
        },
        verifyRead: verifyOpFn
          ? (reader) => {
            if (unaligned) {
              const pre = { value: 0 };
              assert.equal(reader.serializeBits(pre, 3), true, `${id}: prefix read`);
              assert.equal(pre.value, 0b101, `${id}: prefix value`);
            }
            verifyOpFn(reader, id);
          }
          : null,
      });
    }
  }

  // 1. serializeBits across all widths 1..32 (every value fits its width: U8).
  for (let bits = 1; bits <= 32; bits++) {
    const maxVal = bits === 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
    const altVal = bits === 32 ? 0x55aaaa55 : (0x55555555 & maxVal) >>> 0;
    const expectedValues = [0, 1, altVal, maxVal, altVal];
    const writeInputs = [0, 1, altVal, maxVal, altVal];

    addAlignedAndUnaligned(
      `ws.bits.w${bits}`,
      32,
      (stream, returns) => {
        for (const v of writeInputs) {
          returns.push(stream.serializeBits({ value: v }, bits));
        }
      },
      (reader, id) => {
        for (let i = 0; i < expectedValues.length; i++) {
          const ref = { value: 0 };
          assert.equal(reader.serializeBits(ref, bits), true, `${id}[${i}] read`);
          assert.equal(ref.value, expectedValues[i], `${id}[${i}] value`);
        }
      },
    );
  }

  // 2. serializeBits64 across all widths 1..64 (1..32 single group, 33..64 two groups,
  // every value fits its width: U8).
  for (let bits = 1; bits <= 64; bits++) {
    const mask = (1n << BigInt(bits)) - 1n;
    const alt = 0x5555aaaa5555aaaan & mask;
    const hiBit = 1n << BigInt(bits - 1);
    const expectedValues = [0n, 1n, hiBit, alt, mask, alt, mask];
    const writeInputs = [0n, 1n, hiBit, alt, mask, alt, mask];

    addAlignedAndUnaligned(
      `ws.bits64.w${bits}`,
      80,
      (stream, returns) => {
        for (const v of writeInputs) {
          returns.push(stream.serializeBits64({ value: v }, bits));
        }
      },
      (reader, id) => {
        for (let i = 0; i < expectedValues.length; i++) {
          const ref = { value: 0n };
          assert.equal(reader.serializeBits64(ref, bits), true, `${id}[${i}] read`);
          assert.equal(ref.value, expectedValues[i], `${id}[${i}] value`);
        }
      },
    );
  }

  // 3. serializeInt: degenerate 0-bit ranges (min === max) and signed/unsigned/wide 32-bit ranges.
  const intRanges = [
    ['deg_zero', 0, 0, [0]],
    ['deg_neg', -42, -42, [-42]],
    ['deg_pos', 123456, 123456, [123456]],
    ['deg_min32', INT32_MIN, INT32_MIN, [INT32_MIN]],
    ['deg_max32', INT32_MAX, INT32_MAX, [INT32_MAX]],
    ['bit1_unsigned', 0, 1, [0, 1]],
    ['bit1_signed', -1, 0, [-1, 0]],
    ['small_unsigned', 0, 6, [0, 1, 3, 5, 6]],
    ['small_signed', -100, 100, [-100, -99, -1, 0, 1, 99, 100]],
    ['negative_only', -5000, -1000, [-5000, -4999, -3000, -1001, -1000]],
    ['uint16_like', 0, 65535, [0, 1, 32767, 32768, 65534, 65535]],
    ['int16_like', -32768, 32767, [-32768, -32767, 0, 32766, 32767]],
    ['bit31_signed', -1073741824, 1073741823, [-1073741824, -1, 0, 1, 1073741823]],
    ['bit31_unsigned', 0, INT32_MAX, [0, 1, 1073741823, INT32_MAX - 1, INT32_MAX]],
    ['bit32_cross_zero', -1, INT32_MAX, [-1, 0, 1, INT32_MAX - 1, INT32_MAX]],
    ['bit32_neg_half', INT32_MIN, 0, [INT32_MIN, INT32_MIN + 1, -1, 0]],
    ['bit32_full', INT32_MIN, INT32_MAX, [INT32_MIN, INT32_MIN + 1, -1, 0, 1, INT32_MAX - 1, INT32_MAX]],
  ];
  for (const [name, min, max, values] of intRanges) {
    addAlignedAndUnaligned(
      `ws.int.${name}`,
      48,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeInt({ value: v }, min, max));
        }
        // Follow degenerate range with a non-empty field to pin bit offset 0 / 3 continuity.
        returns.push(stream.serializeInt({ value: 5 }, 0, 7));
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0 };
          assert.equal(reader.serializeInt(ref, min, max), true, `${id}[${i}] read`);
          assert.equal(ref.value, values[i], `${id}[${i}] value`);
        }
        const tail = { value: 0 };
        assert.equal(reader.serializeInt(tail, 0, 7), true, `${id} tail read`);
        assert.equal(tail.value, 5, `${id} tail value`);
      },
    );
  }

  // 4. serializeInt64: degenerate 0-bit, 1-group (<= 32 bits), and 2-group (33..64 bits).
  const int64Ranges = [
    ['deg_zero', 0n, 0n, [0n]],
    ['deg_neg', -999999999999n, -999999999999n, [-999999999999n]],
    ['deg_min64', INT64_MIN, INT64_MIN, [INT64_MIN]],
    ['deg_max64', INT64_MAX, INT64_MAX, [INT64_MAX]],
    ['g1_1bit', -1n, 0n, [-1n, 0n]],
    ['g1_10bit_signed', -500n, 500n, [-500n, -499n, 0n, 499n, 500n]],
    ['g1_10bit_near_max', INT64_MAX - 1000n, INT64_MAX, [INT64_MAX - 1000n, INT64_MAX - 500n, INT64_MAX]],
    ['g1_10bit_near_min', INT64_MIN, INT64_MIN + 1000n, [INT64_MIN, INT64_MIN + 500n, INT64_MIN + 1000n]],
    ['g1_32bit_unsigned', 0n, 0xffffffffn, [0n, 1n, 0x7fffffffn, 0xfffffffen, 0xffffffffn]],
    ['g1_32bit_signed', -2147483648n, 2147483647n, [-2147483648n, -1n, 0n, 1n, 2147483647n]],
    ['g2_33bit_low_edge', 0n, 0x100000000n, [0n, 1n, 0xffffffffn, 0x100000000n]],
    ['g2_33bit_signed', -2147483649n, 2147483648n, [-2147483649n, 0n, 2147483648n]],
    ['g2_38bit_signed', -100000000000n, 100000000000n, [-100000000000n, -1n, 0n, 1n, 100000000000n]],
    ['g2_48bit_signed', -140737488355328n, 140737488355327n, [-140737488355328n, 0n, 140737488355327n]],
    ['g2_63bit_pos', 0n, INT64_MAX, [0n, 1n, 0xffffffffn, 0x100000000n, INT64_MAX - 1n, INT64_MAX]],
    ['g2_64bit_neg_zero', INT64_MIN, 0n, [INT64_MIN, INT64_MIN + 1n, -1n, 0n]],
    [
      'g2_64bit_full',
      INT64_MIN,
      INT64_MAX,
      [
        INT64_MIN,
        INT64_MIN + 1n,
        INT64_MIN + 0xffffffffn,
        INT64_MIN + 0x100000000n,
        -1n,
        0n,
        1n,
        INT64_MAX - 1n,
        INT64_MAX,
      ],
    ],
  ];
  for (const [name, min, max, values] of int64Ranges) {
    addAlignedAndUnaligned(
      `ws.int64.${name}`,
      96,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeInt64({ value: v }, min, max));
        }
        returns.push(stream.serializeInt({ value: 3 }, 0, 7));
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0n };
          assert.equal(reader.serializeInt64(ref, min, max), true, `${id}[${i}] read`);
          assert.equal(ref.value, values[i], `${id}[${i}] value`);
        }
        const tail = { value: 0 };
        assert.equal(reader.serializeInt(tail, 0, 7), true, `${id} tail read`);
        assert.equal(tail.value, 3, `${id} tail value`);
      },
    );
  }

  // 5. serializeInt128: degenerate 0-bit and 1, 2, 3, and 4 groups across 1..128 bits.
  const int128Ranges = [
    ['deg_zero', 0n, 0n, [0n]],
    ['deg_neg', -123456789012345678901234567890n, -123456789012345678901234567890n, [-123456789012345678901234567890n]],
    ['deg_min128', INT128_MIN, INT128_MIN, [INT128_MIN]],
    ['deg_max128', INT128_MAX, INT128_MAX, [INT128_MAX]],
    ['g1_1bit', 0n, 1n, [0n, 1n]],
    ['g1_18bit_signed', -100000n, 100000n, [-100000n, -1n, 0n, 1n, 100000n]],
    ['g1_32bit_edge', 0n, 0xffffffffn, [0n, 1n, 0x7fffffffn, 0xffffffffn]],
    ['g1_32bit_near_min128', INT128_MIN, INT128_MIN + 0xffffffffn, [INT128_MIN, INT128_MIN + 1n, INT128_MIN + 0xffffffffn]],
    ['g2_33bit_low_edge', 0n, 0x100000000n, [0n, 1n, 0xffffffffn, 0x100000000n]],
    ['g2_50bit_signed', -(1n << 49n), (1n << 49n) - 1n, [-(1n << 49n), -1n, 0n, 1n, (1n << 49n) - 1n]],
    ['g2_64bit_high_edge', 0n, UINT64_MAX, [0n, 1n, 0xffffffffn, 0x100000000n, UINT64_MAX - 1n, UINT64_MAX]],
    ['g3_65bit_low_edge', 0n, 1n << 64n, [0n, 1n, 0xffffffffn, UINT64_MAX, 1n << 64n]],
    ['g3_80bit_signed', -(1n << 79n), (1n << 79n) - 1n, [-(1n << 79n), -1n, 0n, 1n, (1n << 79n) - 1n]],
    ['g3_96bit_high_edge', 0n, (1n << 96n) - 1n, [0n, 1n, UINT64_MAX, 1n << 64n, (1n << 96n) - 2n, (1n << 96n) - 1n]],
    ['g4_97bit_low_edge', 0n, 1n << 96n, [0n, 1n, UINT64_MAX, (1n << 96n) - 1n, 1n << 96n]],
    ['g4_112bit_signed', -(1n << 111n), (1n << 111n) - 1n, [-(1n << 111n), -1n, 0n, 1n, (1n << 111n) - 1n]],
    [
      'g4_128bit_full',
      INT128_MIN,
      INT128_MAX,
      [
        INT128_MIN,
        INT128_MIN + 1n,
        INT128_MIN + 0xffffffffn,
        INT128_MIN + 0x100000000n,
        INT128_MIN + UINT64_MAX,
        INT128_MIN + (1n << 64n),
        INT128_MIN + ((1n << 96n) - 1n),
        INT128_MIN + (1n << 96n),
        -1n,
        0n,
        1n,
        INT128_MAX - 1n,
        INT128_MAX,
      ],
    ],
  ];
  for (const [name, min, max, values] of int128Ranges) {
    addAlignedAndUnaligned(
      `ws.int128.${name}`,
      256,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeInt128({ value: v }, min, max));
        }
        returns.push(stream.serializeInt({ value: 6 }, 0, 7));
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0n };
          assert.equal(reader.serializeInt128(ref, min, max), true, `${id}[${i}] read`);
          assert.equal(ref.value, values[i], `${id}[${i}] value`);
        }
        const tail = { value: 0 };
        assert.equal(reader.serializeInt(tail, 0, 7), true, `${id} tail read`);
        assert.equal(tail.value, 6, `${id} tail value`);
      },
    );
  }

  // 6. serializeIntRelative across all 7 tiers and domain [0, 2^31 - 1] boundaries.
  const intRelativePairs = [
    // Tier 0: diff === 1 (1 bit)
    ['t0_0_1', 0, 1],
    ['t0_mid', 100, 101],
    ['t0_max', INT32_MAX - 1, INT32_MAX],
    // Tier 1: diff in [2, 6] (5 bits)
    ['t1_low', 100, 102],
    ['t1_mid', 100, 104],
    ['t1_high', 100, 106],
    ['t1_zero_base', 0, 6],
    // Tier 2: diff in [7, 23] (8 bits)
    ['t2_low', 100, 107],
    ['t2_mid', 100, 115],
    ['t2_high', 100, 123],
    // Tier 3: diff in [24, 280] (13 bits)
    ['t3_low', 1000, 1024],
    ['t3_mid', 1000, 1150],
    ['t3_high', 1000, 1280],
    // Tier 4: diff in [281, 4377] (18 bits)
    ['t4_low', 0, 281],
    ['t4_mid', 0, 2048],
    ['t4_high', 0, 4377],
    // Tier 5: diff in [4378, 69914] (23 bits)
    ['t5_low', 0, 4378],
    ['t5_mid', 0, 35000],
    ['t5_high', 0, 69914],
    ['t5_near_max', INT32_MAX - 69914, INT32_MAX],
    // Tier 6: absolute fallback (diff >= 69915, 38 bits)
    ['t6_low_pos', 0, 69915],
    ['t6_offset_low', 100, 70015],
    ['t6_large_pos', 0, 1000000],
    ['t6_near_max', INT32_MAX - 70000, INT32_MAX],
    ['t6_zero_to_max', 0, INT32_MAX],
  ];
  for (const [name, previous, current] of intRelativePairs) {
    addAlignedAndUnaligned(
      `ws.int_relative.${name}`,
      16,
      (stream, returns) => {
        returns.push(stream.serializeIntRelative(previous, { value: current }));
      },
      (reader, id) => {
        const ref = { value: 0 };
        assert.equal(reader.serializeIntRelative(previous, ref), true, `${id} read`);
        assert.equal(ref.value, current, `${id} value`);
      },
    );
  }

  // 7. serializeFixed across all storage widths (8, 16, 32, 64, 128),
  // signed and unsigned, fractionBits = 0 and > 0, degenerate min === max, and 1..4 groups.
  const narrowFixedConfigs = [
    ['w8_q4_4_signed', 4, 4, -4, 3],
    ['w8_q8_0_signed', 8, 0, -100, 100],
    ['w8_q8_0_unsigned', 8, 0, 0, 200],
    ['w8_q4_4_deg', 4, 4, 2, 2],
    ['w16_q8_8_signed', 8, 8, -100, 100],
    ['w16_q12_4_signed', 12, 4, -2000, 2000],
    ['w16_q16_0_unsigned', 16, 0, 0, 60000],
    ['w16_q8_8_deg', 8, 8, 5, 5],
    ['w32_q16_16_signed', 16, 16, -30000, 30000],
    ['w32_q16_16_unsigned', 16, 16, 0, 60000],
    ['w32_q16_16_unit', 16, 16, 0, 1],
    ['w32_q24_8_signed', 24, 8, -8000000, 8000000],
    ['w32_q32_0_signed', 32, 0, -100000, 100000],
    ['w32_q16_16_deg', 16, 16, 5, 5],
  ];
  for (const [name, integerBits, fractionBits, min, max] of narrowFixedConfigs) {
    const scale = 2 ** fractionBits;
    const rawMin = min * scale;
    const rawMax = max * scale;
    const rawRange = rawMax - rawMin;
    const candidates = [
      rawMin,
      rawMin + 1,
      rawMax - 1,
      rawMax,
      rawMin + Math.floor(rawRange / 2),
      0,
      scale,
      -scale,
      rawMin + scale - 1,
    ];
    const values = [];
    for (const v of candidates) {
      if (v >= rawMin && v <= rawMax && !values.includes(v)) {
        values.push(v);
      }
    }

    addAlignedAndUnaligned(
      `ws.fixed.${name}`,
      64,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeFixed({ value: v }, integerBits, fractionBits, min, max));
        }
        returns.push(stream.serializeInt({ value: 3 }, 0, 7));
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0 };
          assert.equal(reader.serializeFixed(ref, integerBits, fractionBits, min, max), true, `${id}[${i}] read`);
          assert.equal(ref.value, values[i], `${id}[${i}] value`);
        }
        const tail = { value: 0 };
        assert.equal(reader.serializeInt(tail, 0, 7), true, `${id} tail read`);
        assert.equal(tail.value, 3, `${id} tail value`);
      },
    );
  }

  const wideFixedConfigs = [
    ['w64_q48_16_34b', 48, 16, -100000n, 100000n],
    ['w64_q48_16_54b', 48, 16, -100000000000n, 100000000000n],
    ['w64_q32_32_signed', 32, 32, -1000000n, 1000000n],
    ['w64_q64_0_pure_int', 64, 0, -5000000000n, 5000000000n],
    ['w64_q48_16_unsigned', 48, 16, 0n, 1000000000n],
    ['w64_q48_16_asym', 48, 16, -3n, 100000n],
    ['w64_q16_48_unsigned_wide', 16, 48, 0n, 60000n],
    ['w64_q48_16_1group', 48, 16, 0n, 1n],
    ['w64_q48_16_deg', 48, 16, -7n, -7n],
    ['w128_q112_16_deg', 112, 16, 9n, 9n],
    ['w128_q112_16_g1_19b', 112, 16, -2n, 2n],
    ['w128_q128_0_g1_pure_int', 128, 0, -1000n, 1000n],
    ['w128_q112_16_g2_33b', 112, 16, -32768n, 32768n],
    ['w128_q112_16_g2_54b', 112, 16, -100000000000n, 100000000000n],
    ['w128_q112_16_g2_64b', 112, 16, -140737488355328n, 140737488355327n],
    ['w128_q112_16_g3_78b', 112, 16, -1152921504606846976n, 1152921504606846976n],
    ['w128_q112_16_g3_unsigned', 112, 16, 0n, 2305843009213693952n],
    ['w128_q64_64_g3_75b', 64, 64, -1000n, 1000n],
    ['w128_q80_48_g4_105b', 80, 48, -(1n << 55n), 1n << 55n],
    ['w128_q64_64_g4_128b', 64, 64, INT64_MIN, INT64_MAX],
  ];
  for (const [name, integerBits, fractionBits, min, max] of wideFixedConfigs) {
    const scale = 1n << BigInt(fractionBits);
    const rawMin = min * scale;
    const rawMax = max * scale;
    const rawRange = rawMax - rawMin;
    const candidates = [
      rawMin,
      rawMin + 1n,
      rawMax - 1n,
      rawMax,
      rawMin + rawRange / 2n,
      0n,
      scale,
      -scale,
      rawMin + scale - 1n,
    ];
    const values = [];
    for (const v of candidates) {
      if (v >= rawMin && v <= rawMax && !values.includes(v)) {
        values.push(v);
      }
    }

    addAlignedAndUnaligned(
      `ws.fixed.${name}`,
      192,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeFixed({ value: v }, integerBits, fractionBits, min, max));
        }
        returns.push(stream.serializeInt({ value: 5 }, 0, 7));
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0n };
          assert.equal(reader.serializeFixed(ref, integerBits, fractionBits, min, max), true, `${id}[${i}] read`);
          assert.equal(ref.value, values[i], `${id}[${i}] value`);
        }
        const tail = { value: 0 };
        assert.equal(reader.serializeInt(tail, 0, 7), true, `${id} tail read`);
        assert.equal(tail.value, 5, `${id} tail value`);
      },
    );
  }

  // 8. Fixed-width unsigned & boolean: uint8, uint16, uint32, uint64, uint128, bool.
  const uint8Values = [0, 1, 0x55, 0x7f, 0x80, 0xaa, 0xfe, 0xff];
  addAlignedAndUnaligned(
    'ws.uint8',
    24,
    (stream, returns) => {
      for (const v of uint8Values) {
        returns.push(stream.serializeUint8({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of uint8Values) {
        const ref = { value: 0 };
        assert.equal(reader.serializeUint8(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  const uint16Values = [0, 1, 0x00ff, 0x0100, 0x1234, 0x7fff, 0x8000, 0xfffe, 0xffff];
  addAlignedAndUnaligned(
    'ws.uint16',
    32,
    (stream, returns) => {
      for (const v of uint16Values) {
        returns.push(stream.serializeUint16({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of uint16Values) {
        const ref = { value: 0 };
        assert.equal(reader.serializeUint16(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  const uint32Values = [0, 1, 0x0000ffff, 0x00010000, 0x12345678, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
  addAlignedAndUnaligned(
    'ws.uint32',
    48,
    (stream, returns) => {
      for (const v of uint32Values) {
        returns.push(stream.serializeUint32({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of uint32Values) {
        const ref = { value: 0 };
        assert.equal(reader.serializeUint32(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  const uint64Values = [
    0n,
    1n,
    0xffffffffn,
    0x100000000n,
    0x0102030405060708n,
    0x7fffffffffffffffn,
    0x8000000000000000n,
    UINT64_MAX - 1n,
    UINT64_MAX,
  ];
  addAlignedAndUnaligned(
    'ws.uint64',
    88,
    (stream, returns) => {
      for (const v of uint64Values) {
        returns.push(stream.serializeUint64({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of uint64Values) {
        const ref = { value: 0n };
        assert.equal(reader.serializeUint64(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  const uint128Values = [
    0n,
    1n,
    0xffffffffn,
    0x100000000n,
    UINT64_MAX,
    1n << 64n,
    (1n << 96n) - 1n,
    1n << 96n,
    0x0102030405060708090a0b0c0d0e0f10n,
    UINT128_MAX - 1n,
    UINT128_MAX,
  ];
  addAlignedAndUnaligned(
    'ws.uint128',
    192,
    (stream, returns) => {
      for (const v of uint128Values) {
        returns.push(stream.serializeUint128({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of uint128Values) {
        const ref = { value: 0n };
        assert.equal(reader.serializeUint128(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  const boolValues = [false, true, true, false, true, false, false, true, true];
  addAlignedAndUnaligned(
    'ws.bool',
    16,
    (stream, returns) => {
      for (const v of boolValues) {
        returns.push(stream.serializeBool({ value: v }));
      }
    },
    (reader, id) => {
      for (const v of boolValues) {
        const ref = { value: false };
        assert.equal(reader.serializeBool(ref), true, `${id} read`);
        assert.equal(ref.value, v, `${id} value`);
      }
    },
  );

  // 9. serializeFloat and serializeDouble edge witnesses (+0.0, -0.0, subnormals, normals, +-max).
  const floatWitnesses = [
    0.0,
    -0.0,
    1.401298464324817e-45,
    -1.401298464324817e-45,
    1.1754942106924411e-38,
    -1.1754942106924411e-38,
    1.1754943508222875e-38,
    -1.1754943508222875e-38,
    0.5,
    -0.5,
    1.0,
    -1.0,
    3.1415927410125732,
    -273.1499938964844,
    3.4028234663852886e+38,
    -3.4028234663852886e+38,
  ];
  addAlignedAndUnaligned(
    'ws.float.witnesses',
    80,
    (stream, returns) => {
      for (const v of floatWitnesses) {
        returns.push(stream.serializeFloat({ value: v }));
      }
    },
    (reader, id) => {
      for (let i = 0; i < floatWitnesses.length; i++) {
        const ref = { value: 0 };
        assert.equal(reader.serializeFloat(ref), true, `${id}[${i}] read`);
        assert.equal(float32Bits(ref.value), float32Bits(floatWitnesses[i]), `${id}[${i}] bits`);
      }
    },
  );

  const doubleWitnesses = [
    0.0,
    -0.0,
    5e-324,
    -5e-324,
    2.225073858507201e-308,
    -2.225073858507201e-308,
    2.2250738585072014e-308,
    -2.2250738585072014e-308,
    0.5,
    -0.5,
    1.0,
    -1.0,
    Math.PI,
    -Math.E,
    9007199254740991,
    -9007199254740991,
    1.7976931348623157e+308,
    -1.7976931348623157e+308,
  ];
  addAlignedAndUnaligned(
    'ws.double.witnesses',
    160,
    (stream, returns) => {
      for (const v of doubleWitnesses) {
        returns.push(stream.serializeDouble({ value: v }));
      }
    },
    (reader, id) => {
      for (let i = 0; i < doubleWitnesses.length; i++) {
        const ref = { value: 0 };
        assert.equal(reader.serializeDouble(ref), true, `${id}[${i}] read`);
        assert.equal(float64Bits(ref.value), float64Bits(doubleWitnesses[i]), `${id}[${i}] bits`);
      }
    },
  );

  // 10. serializeCompressedFloat edge and rounding/clamp witnesses:
  //   - [0, 10] @ 0.01 (two-rounding witnesses 0.005, 0.025, 0.105, 9.995, plus clamps)
  //   - [-100, 100] @ 0.01 (nonzero min trio 0.0, -99.875, -33.34, plus out-of-range clamps)
  //   - [0, 1] @ 10 (values < 1.0 clamp to 1.0 -> 1-bit field)
  //   - [0, 1e10] @ 1 (values > 4294967040.0 clamp to 4294967040.0 -> 32-bit field)
  //   - [0, 8388609] @ 1 and [0, 16777215] @ 1 (schema#109 maxIntegerValue >= 2^23 clamp)
  const compressedFloatConfigs = [
    ['zero_to_ten_two_rounding', 0, 10, 0.01, [-5.0, 0.0, 0.005, 0.025, 0.105, 2.13, 2.5, 9.995, 10.0, 25.0]],
    ['nonzero_min_trio_and_clamps', -100, 100, 0.01, [-200.0, -100.0, -99.875, -33.34, 0.0, 33.34, 99.875, 100.0, 200.0]],
    ['coarse_values_lt_one_clamp', 0, 1, 10, [-1.0, 0.0, 0.25, 0.49, 0.5, 0.51, 0.75, 1.0, 2.0]],
    ['huge_values_gt_u32_clamp', 0, 10000000000, 1, [-100.0, 0.0, 2500000000.0, 5000000000.0, 10000000000.0, 20000000000.0]],
    ['schema109_8388609_clamp', 0, 8388609, 1, [-1.0, 0.0, 1.0, 4194304.5, 8388608.0, 8388609.0, 9000000.0]],
    ['schema109_16777215_clamp', 0, 16777215, 1, [-1.0, 0.0, 1.0, 8388607.5, 16777214.0, 16777215.0, 20000000.0]],
  ];
  for (const [name, min, max, res, values] of compressedFloatConfigs) {
    addAlignedAndUnaligned(
      `ws.compressed_float.${name}`,
      64,
      (stream, returns) => {
        for (const v of values) {
          returns.push(stream.serializeCompressedFloat({ value: v }, min, max, res));
        }
      },
      (reader, id) => {
        for (let i = 0; i < values.length; i++) {
          const ref = { value: 0 };
          assert.equal(reader.serializeCompressedFloat(ref, min, max, res), true, `${id}[${i}] read`);
          assert.equal(Number.isFinite(ref.value), true, `${id}[${i}] finite`);
          assert.equal(ref.value >= min && ref.value <= max, true, `${id}[${i}] in [${min}, ${max}]`);
        }
      },
    );
  }

  // 11. serializeBytes: empty and non-empty across aligned/unaligned bit offsets,
  // headBytes 0..3, SMALL_COPY_BYTES = 64 boundary (<= 64 and > 64), and subarray view.
  for (const preBits of [0, 1, 3, 5, 7]) {
    for (const len of [0, 1, 2, 3, 4, 7, 15, 31, 63, 64, 65, 68, 96, 128, 131]) {
      const id = `ws.bytes.pre_${preBits}.len_${len}`;
      const backing = makePatternBytes(len + 8, preBits * 31 + len);
      const payload = backing.subarray(2, 2 + len);
      scenarios.push({
        id,
        bufferBytes: 160,
        run(stream) {
          const returns = [];
          if (preBits > 0) {
            returns.push(stream.serializeBits({ value: (1 << preBits) - 1 }, preBits));
          }
          returns.push(stream.serializeBytes(payload));
          returns.push(stream.serializeBits({ value: 0x13 }, 5));
          return returns;
        },
        verifyRead(reader) {
          if (preBits > 0) {
            const pre = { value: 0 };
            assert.equal(reader.serializeBits(pre, preBits), true, `${id} pre read`);
            assert.equal(pre.value, (1 << preBits) - 1, `${id} pre val`);
          }
          const out = new Uint8Array(len);
          assert.equal(reader.serializeBytes(out), true, `${id} bytes read`);
          assert.deepEqual(out, payload, `${id} bytes match`);
          const post = { value: 0 };
          assert.equal(reader.serializeBits(post, 5), true, `${id} post read`);
          assert.equal(post.value, 0x13, `${id} post val`);
        },
      });
    }
  }

  // 12. serializeString: empty string with bufferSize = 1 (zero-bit length prefix),
  // bufferSize = 2, bufferSize = 64, max-length ASCII, > 64 byte ASCII, and multi-byte UTF-8.
  const stringCases = [
    ['empty_buf1_zero_bit_prefix', '', 1],
    ['empty_buf2_one_bit_prefix', '', 2],
    ['empty_buf64', '', 64],
    ['single_char_buf2', 'x', 2],
    ['ascii_phrase', 'hello, serialize!', 64],
    ['ascii_exact_cap63', 'a'.repeat(63), 64],
    ['ascii_gt64_bulk', '0123456789abcdef'.repeat(5) + 'tail!', 128],
    ['utf8_latin1', 'café résumé naïve', 64],
    ['utf8_cyrillic', 'Привет, мир!', 64],
    ['utf8_cjk', '日本語のビットパッキング検証', 64],
    ['utf8_emoji_4byte', '🚀🎉🔥✨🌊', 64],
    ['utf8_combining_and_bom', '\uFEFFe\u0301 a\u0308 o\u0302', 64],
    ['utf8_mixed_gt64', '🚀日本語ПриветCafé'.repeat(4), 256],
  ];
  for (const [name, str, bufferSize] of stringCases) {
    addAlignedAndUnaligned(
      `ws.string.${name}`,
      320,
      (stream, returns) => {
        returns.push(stream.serializeString({ value: str }, bufferSize));
        returns.push(stream.serializeBits({ value: 0b1011 }, 4));
      },
      (reader, id) => {
        const ref = { value: 'init' };
        assert.equal(reader.serializeString(ref, bufferSize), true, `${id} str read`);
        assert.equal(ref.value, str, `${id} str value`);
        const tail = { value: 0 };
        assert.equal(reader.serializeBits(tail, 4), true, `${id} tail read`);
        assert.equal(tail.value, 0b1011, `${id} tail value`);
      },
    );
  }

  // 13. serializeAlign and serializeEnd at every bit offset 0..7 and across even/odd wordIndex.
  for (let offset = 0; offset <= 7; offset++) {
    for (const extraWords of [0, 1, 2]) {
      const id = `ws.align_and_end.off_${offset}.words_${extraWords}`;
      scenarios.push({
        id,
        bufferBytes: 32,
        run(stream) {
          const returns = [];
          for (let w = 0; w < extraWords; w++) {
            returns.push(stream.serializeUint32({ value: (0x13579bdf + w) >>> 0 }));
          }
          if (offset > 0) {
            returns.push(stream.serializeBits({ value: (1 << offset) - 1 }, offset));
          }
          returns.push(stream.serializeAlign());
          returns.push(stream.serializeUint8({ value: 0x42 + offset }));
          if (offset > 0) {
            returns.push(stream.serializeBits({ value: offset }, offset));
          }
          returns.push(stream.serializeEnd());
          return returns;
        },
        verifyRead(reader) {
          for (let w = 0; w < extraWords; w++) {
            const word = { value: 0 };
            assert.equal(reader.serializeUint32(word), true, `${id} word ${w}`);
            assert.equal(word.value, (0x13579bdf + w) >>> 0);
          }
          if (offset > 0) {
            const pre = { value: 0 };
            assert.equal(reader.serializeBits(pre, offset), true, `${id} pre`);
            assert.equal(pre.value, (1 << offset) - 1);
          }
          assert.equal(reader.serializeAlign(), true, `${id} align`);
          const byteRef = { value: 0 };
          assert.equal(reader.serializeUint8(byteRef), true, `${id} byte`);
          assert.equal(byteRef.value, 0x42 + offset);
          if (offset > 0) {
            const post = { value: 0 };
            assert.equal(reader.serializeBits(post, offset), true, `${id} post`);
            assert.equal(post.value, offset);
          }
          assert.equal(reader.serializeEnd(), true, `${id} end`);
        },
      });
    }
  }

  // 14. The 29-op 106-byte golden wire message (includes serializeEnd).
  scenarios.push({
    id: 'ws.composite.golden_wire_106_bytes',
    bufferBytes: 128,
    run(stream) {
      const refs = makeGoldenRefs(goldenValues());
      const ok = serializeGoldenWire(stream, refs);
      return [ok];
    },
    verifyRead(reader) {
      const refs = makeGoldenReadRefs();
      assert.equal(serializeGoldenWire(reader, refs), true, 'golden wire read');
      const expected = goldenValues();
      for (const field of GOLDEN_SCALAR_FIELDS) {
        assert.equal(Object.is(refs[field].value, expected[field]), true, `golden ${field}`);
      }
      assert.deepEqual(refs.bytes, expected.bytes);
    },
  });

  return scenarios;
}

// The result of a write that may be misuse: its return, or the name of what
// it threw (U9: an operation that does not fit the room left throws).
function attempt(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof RangeError ? 'RangeError' : String(error);
  }
}

// Writes zero bits, 32 at a time: true when every write returned true.
function fillBits(stream, bits) {
  let ok = true;
  for (let rem = bits; rem > 0; rem -= 32) {
    ok = stream.serializeBits({ value: 0 }, Math.min(rem, 32)) && ok;
  }
  return ok;
}

// Capacity-boundary scenarios for WriteStream: for every operation family,
// tests exact remaining capacity fit (bitsAvailable() === cost -> true, 0 bits left),
// 1-bit short overflow (bitsAvailable() === cost - 1 -> a RangeError, U9),
// no latch afterwards (what still fits is written), and reset(buffer) reuse.
function collectOverflowBoundaryRecords() {
  // Each entry: [id, costBits, executeOp(stream)]
  const ops = [
    ['bits_1', 1, (s) => s.serializeBits({ value: 1 }, 1)],
    ['bits_17', 17, (s) => s.serializeBits({ value: 0x15555 }, 17)],
    ['bits_32', 32, (s) => s.serializeBits({ value: 0xdeadbeef }, 32)],
    ['bits64_20', 20, (s) => s.serializeBits64({ value: 0xabcden }, 20)],
    ['bits64_33', 33, (s) => s.serializeBits64({ value: 0x123456789n }, 33)],
    ['bits64_64', 64, (s) => s.serializeBits64({ value: 0x0102030405060708n }, 64)],
    ['int_10bit', 10, (s) => s.serializeInt({ value: 50 }, -100, 900)],
    ['int_32bit', 32, (s) => s.serializeInt({ value: 0 }, INT32_MIN, INT32_MAX)],
    ['int64_g1_16bit', 16, (s) => s.serializeInt64({ value: 0n }, -32768n, 32767n)],
    ['int64_g2_38bit', 38, (s) => s.serializeInt64({ value: 42n }, -100000000000n, 100000000000n)],
    ['int64_g2_64bit', 64, (s) => s.serializeInt64({ value: 0n }, INT64_MIN, INT64_MAX)],
    ['int128_g1_18bit', 18, (s) => s.serializeInt128({ value: 7n }, -100000n, 100000n)],
    ['int128_g2_50bit', 50, (s) => s.serializeInt128({ value: 7n }, -(1n << 49n), (1n << 49n) - 1n)],
    ['int128_g3_80bit', 80, (s) => s.serializeInt128({ value: 7n }, -(1n << 79n), (1n << 79n) - 1n)],
    ['int128_g4_128bit', 128, (s) => s.serializeInt128({ value: 0n }, INT128_MIN, INT128_MAX)],
    ['int_relative_t0_1b', 1, (s) => s.serializeIntRelative(10, { value: 11 })],
    ['int_relative_t3_13b', 13, (s) => s.serializeIntRelative(10, { value: 50 })],
    ['int_relative_t6_38b', 38, (s) => s.serializeIntRelative(10, { value: 70000 })],
    ['fixed_w16_16b', 16, (s) => s.serializeFixed({ value: -832 }, 8, 8, -100, 100)],
    ['fixed_w64_34b', 34, (s) => s.serializeFixed({ value: 65536n }, 48, 16, -100000n, 100000n)],
    ['fixed_w128_78b', 78, (s) => s.serializeFixed({ value: 0n }, 112, 16, -1152921504606846976n, 1152921504606846976n)],
    ['fixed_w128_128b', 128, (s) => s.serializeFixed({ value: 0n }, 64, 64, INT64_MIN, INT64_MAX)],
    ['uint8', 8, (s) => s.serializeUint8({ value: 0xab })],
    ['uint16', 16, (s) => s.serializeUint16({ value: 0xabcd })],
    ['uint32', 32, (s) => s.serializeUint32({ value: 0xabcdef01 })],
    ['uint64', 64, (s) => s.serializeUint64({ value: 0x0102030405060708n })],
    ['uint128', 128, (s) => s.serializeUint128({ value: 0x0102030405060708090a0b0c0d0e0f10n })],
    ['bool', 1, (s) => s.serializeBool({ value: true })],
    ['float', 32, (s) => s.serializeFloat({ value: 1.5 })],
    ['double', 64, (s) => s.serializeDouble({ value: 2.5 })],
    ['compressed_float_10b', 10, (s) => s.serializeCompressedFloat({ value: 2.5 }, 0, 10, 0.01)],
  ];

  const records = [];
  const totalBits = 192; // 24 bytes (multiple of 8)
  const totalBytes = totalBits / 8;

  function primeBitOffset(stream, bitsToConsume) {
    let rem = bitsToConsume;
    while (rem >= 32) {
      stream.serializeBits({ value: 0x55aaaa55 }, 32);
      rem -= 32;
    }
    if (rem > 0) {
      stream.serializeBits({ value: ((1 << rem) - 1) >>> 0 }, rem);
    }
  }

  for (const [rawName, cost, opFn] of ops) {
    const name = rawName.trim();

    // Case A: Exact fit (bitsAvailable() === cost).
    const exactBuf = new Uint8Array(totalBytes).fill(0xff);
    const exactWriter = new WriteStream(exactBuf);
    primeBitOffset(exactWriter, totalBits - cost);
    const availBeforeExact = exactWriter.bitsAvailable();
    const exactRet = opFn(exactWriter);
    // Degenerate 0-bit operations still work when 0 bits remain!
    const degAfterExact = exactWriter.serializeInt({ value: 7 }, 7, 7);
    const degFixedAfterExact = exactWriter.serializeFixed({ value: 5 * 65536 }, 16, 16, 5, 5);
    exactWriter.flush();

    // Case B: 1-bit short overflow (bitsAvailable() === cost - 1).
    const shortBuf = new Uint8Array(totalBytes).fill(0xff);
    const shortWriter = new WriteStream(shortBuf);
    primeBitOffset(shortWriter, totalBits - (cost - 1));
    const availBeforeShort = shortWriter.bitsAvailable();
    const shortRet = attempt(() => opFn(shortWriter));
    const bitsAfterShort = shortWriter.bitsProcessed();
    // No latch (U9): the misuse failed nothing, so the cost - 1 bits still
    // left are written, then a degenerate 0-bit int, an align and an end
    // (a no-op returning true on a write, U12).
    const stickyBitsRet = fillBits(shortWriter, cost - 1);
    const stickyDegRet = shortWriter.serializeInt({ value: 7 }, 7, 7);
    const stickyAlignRet = shortWriter.serializeAlign();
    const stickyEndRet = shortWriter.serializeEnd();
    shortWriter.flush();
    const shortSnap = snapshotWriteStream(shortWriter, shortBuf);

    // Recovery via reset(buffer):
    const recoverBuf = new Uint8Array(totalBytes).fill(0xff);
    shortWriter.reset(recoverBuf);
    const recoverRet = opFn(shortWriter);
    shortWriter.flush();
    const recoverSnap = snapshotWriteStream(shortWriter, recoverBuf);

    records.push({
      id: `ws.overflow.${name}`,
      cost,
      availBeforeExact,
      exactRet,
      degAfterExact,
      degFixedAfterExact,
      exactSnap: snapshotWriteStream(exactWriter, exactBuf),
      availBeforeShort,
      shortRet,
      bitsAfterShort,
      stickyReturns: [stickyBitsRet, stickyDegRet, stickyAlignRet, stickyEndRet],
      shortSnap,
      recoverRet,
      recoverSnap,
    });
  }

  // Bytes and String and Align/End specific overflow boundaries:
  // 1. serializeAlign when 3 bits remain in buffer, then 1-byte serializeBytes at 0 bytes left.
  {
    const buf = new Uint8Array(8).fill(0xff); // 64 bits
    const writer = new WriteStream(buf);
    writer.serializeBits({ value: 0xdeadbeef }, 32);
    writer.serializeBits({ value: 0x1fffffff }, 29); // 3 bits left, alignBits() === 3 fits!
    const exactBytesRet = writer.serializeAlign();
    const overflowBytesRet = attempt(() => writer.serializeBytes(new Uint8Array(1))); // 0 bytes left after 64 bits!
    writer.flush();
    records.push({
      id: 'ws.overflow.bytes_after_align_at_end',
      exactBytesRet,
      overflowBytesRet,
      snap: snapshotWriteStream(writer, buf),
    });
  }

  // 2. serializeString overflow: length prefix overflows vs payload bytes overflow after align.
  {
    // Length prefix needs 6 bits (bufferSize = 64); give only 5 bits available.
    const bufPrefix = new Uint8Array(8).fill(0xff);
    const wPrefix = new WriteStream(bufPrefix);
    wPrefix.serializeBits({ value: 0xdeadbeef }, 32);
    wPrefix.serializeBits({ value: 0x07ffffff }, 27); // 5 bits left
    const prefixRet = attempt(() => wPrefix.serializeString({ value: 'hi' }, 64));
    wPrefix.flush();

    // Length prefix fits (6 bits) + align (2 bits) = 8 bits -> 3 bytes left, but string is 4 bytes.
    const bufPayload = new Uint8Array(8).fill(0xff);
    const wPayload = new WriteStream(bufPayload);
    wPayload.serializeBits({ value: 0xdeadbeef }, 32);
    const payloadRet = attempt(() => wPayload.serializeString({ value: 'abcd' }, 64));
    wPayload.flush();

    // 3-byte string fits in remaining 4 bytes (6-bit length + 2-bit align + 24-bit payload = 32 bits).
    const bufExact = new Uint8Array(8).fill(0xff);
    const wExact = new WriteStream(bufExact);
    wExact.serializeBits({ value: 0xdeadbeef }, 32);
    const exactRet = wExact.serializeString({ value: 'abc' }, 64);
    wExact.flush();

    records.push({
      id: 'ws.overflow.string_stages',
      prefixRet,
      prefixSnap: snapshotWriteStream(wPrefix, bufPrefix),
      payloadRet,
      payloadSnap: snapshotWriteStream(wPayload, bufPayload),
      exactRet,
      exactSnap: snapshotWriteStream(wExact, bufExact),
    });
  }

  return records;
}

// Collects the complete parity snapshot in the current process.
function collectFullParitySnapshot() {
  const bitWriterRecords = collectBitWriterRecords();
  const scenarios = buildValidStreamScenarios();
  const streamRecords = [];

  for (const scenario of scenarios) {
    const rawBuffer = new Uint8Array(scenario.bufferBytes).fill(0xff);
    const writer = new WriteStream(rawBuffer);
    const writeReturns = scenario.run(writer);
    writer.flush();

    const measure = new MeasureStream();
    const measureReturns = scenario.run(measure);

    streamRecords.push({
      id: scenario.id,
      writeReturns,
      writeSnap: snapshotWriteStream(writer, rawBuffer),
      measureReturns,
      measureSnap: snapshotMeasureStream(measure),
    });
  }

  const overflowRecords = collectOverflowBoundaryRecords();

  return {
    production: PRODUCTION,
    bitWriterClass: BitWriter.name,
    bitReaderClass: BitReader.name,
    writeStreamClass: WriteStream.name,
    readStreamClass: ReadStream.name,
    measureStreamClass: MeasureStream.name,
    bitWriterRecords,
    streamRecords,
    overflowRecords,
  };
}

// Compares checked and production parity snapshots operation by operation.
function compareParitySnapshots(checked, prod) {
  assert.equal(checked.production, false, 'checked child must load with PRODUCTION === false');
  assert.equal(prod.production, true, 'production child must load with PRODUCTION === true');
  assert.equal(checked.bitWriterClass, 'CheckedBitWriter');
  assert.equal(prod.bitWriterClass, 'ProductionBitWriter');
  assert.equal(checked.writeStreamClass, 'CheckedWriteStream');
  assert.equal(prod.writeStreamClass, 'ProductionWriteStream');
  assert.equal(checked.measureStreamClass, 'CheckedMeasureStream');
  assert.equal(prod.measureStreamClass, 'ProductionMeasureStream');
  assert.equal(checked.bitReaderClass, 'BitReader');
  assert.equal(prod.bitReaderClass, 'BitReader');
  assert.equal(checked.readStreamClass, 'ReadStream');
  assert.equal(prod.readStreamClass, 'ReadStream');

  assert.equal(
    prod.bitWriterRecords.length,
    checked.bitWriterRecords.length,
    'BitWriter record count parity',
  );
  for (let i = 0; i < checked.bitWriterRecords.length; i++) {
    const c = checked.bitWriterRecords[i];
    const p = prod.bitWriterRecords[i];
    assert.equal(p.id, c.id, `BitWriter record index ${i} id`);
    assert.deepEqual(p, c, `BitWriter parity mismatch at ${c.id}`);
  }

  assert.equal(
    prod.streamRecords.length,
    checked.streamRecords.length,
    'WriteStream/MeasureStream record count parity',
  );
  for (let i = 0; i < checked.streamRecords.length; i++) {
    const c = checked.streamRecords[i];
    const p = prod.streamRecords[i];
    assert.equal(p.id, c.id, `stream record index ${i} id`);
    assert.deepEqual(p.writeReturns, c.writeReturns, `${c.id}: write step return parity`);
    assert.equal(p.writeSnap.ok, c.writeSnap.ok, `${c.id}: write ok parity`);
    assert.equal(p.writeSnap.error, c.writeSnap.error, `${c.id}: write error parity`);
    assert.equal(
      p.writeSnap.bitsProcessed,
      c.writeSnap.bitsProcessed,
      `${c.id}: write bitsProcessed parity`,
    );
    assert.equal(
      p.writeSnap.bytesProcessed,
      c.writeSnap.bytesProcessed,
      `${c.id}: write bytesProcessed parity`,
    );
    assert.equal(
      p.writeSnap.bitsAvailable,
      c.writeSnap.bitsAvailable,
      `${c.id}: write bitsAvailable parity`,
    );
    assert.equal(p.writeSnap.alignBits, c.writeSnap.alignBits, `${c.id}: write alignBits parity`);
    assert.equal(p.writeSnap.dataHex, c.writeSnap.dataHex, `${c.id}: canonical wire bytes parity`);
    assert.equal(p.writeSnap.rawHex, c.writeSnap.rawHex, `${c.id}: flushed raw buffer parity`);

    assert.deepEqual(p.measureReturns, c.measureReturns, `${c.id}: measure step return parity`);
    assert.equal(p.measureSnap.ok, c.measureSnap.ok, `${c.id}: measure ok parity`);
    assert.equal(p.measureSnap.error, c.measureSnap.error, `${c.id}: measure error parity`);
    assert.equal(
      p.measureSnap.bitsProcessed,
      c.measureSnap.bitsProcessed,
      `${c.id}: measure bitsProcessed parity`,
    );
    assert.equal(
      p.measureSnap.bytesProcessed,
      c.measureSnap.bytesProcessed,
      `${c.id}: measure bytesProcessed parity`,
    );
    assert.equal(
      p.measureSnap.alignBits,
      c.measureSnap.alignBits,
      `${c.id}: measure alignBits parity`,
    );

    // MeasureStream is an exact match for non-aligning scenarios and a conservative
    // upper bound (charging 7 bits per alignment) for aligning scenarios.
    const hasAlignment =
      c.id.startsWith('ws.bytes.') ||
      c.id.startsWith('ws.string.') ||
      c.id.startsWith('ws.align_and_end.') ||
      c.id === 'ws.composite.golden_wire_106_bytes';
    if (hasAlignment) {
      assert.equal(
        p.measureSnap.bitsProcessed >= p.writeSnap.bitsProcessed,
        true,
        `${c.id}: production MeasureStream bounds WriteStream bitsProcessed`,
      );
      assert.equal(
        p.measureSnap.bytesProcessed >= p.writeSnap.bytesProcessed,
        true,
        `${c.id}: production MeasureStream bounds WriteStream bytesProcessed`,
      );
    } else {
      assert.equal(
        p.measureSnap.bitsProcessed,
        p.writeSnap.bitsProcessed,
        `${c.id}: production MeasureStream vs WriteStream exact bitsProcessed`,
      );
      assert.equal(
        p.measureSnap.bytesProcessed,
        p.writeSnap.bytesProcessed,
        `${c.id}: production MeasureStream vs WriteStream exact bytesProcessed`,
      );
    }
    assert.equal(
      p.measureSnap.alignBits,
      7,
      `${c.id}: production MeasureStream alignBits is 7`,
    );
  }

  assert.equal(
    prod.overflowRecords.length,
    checked.overflowRecords.length,
    'overflow boundary record count parity',
  );
  for (let i = 0; i < checked.overflowRecords.length; i++) {
    const c = checked.overflowRecords[i];
    const p = prod.overflowRecords[i];
    assert.equal(p.id, c.id, `overflow record index ${i} id`);
    assert.deepEqual(p, c, `overflow parity mismatch at ${c.id}`);
  }
}

function runSnapshotChild(nodeEnv) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), `serialize-parity-${nodeEnv}-`));
  try {
    const outPath = path.join(tmpDir, 'snapshot.json');
    const result = spawnSync(
      process.execPath,
      [THIS_FILE, '--dump-parity', outPath],
      {
        env: { ...process.env, NODE_ENV: nodeEnv },
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `child (${NODE_ENVLabel(nodeEnv)}) exited with ${result.status}: ${result.stderr}`,
    );
    return JSON.parse(readFileSync(outPath, 'utf8'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function NODE_ENVLabel(nodeEnv) {
  return `NODE_ENV=${nodeEnv}`;
}

if (process.argv[2] === '--dump-parity') {
  const snapshot = collectFullParitySnapshot();
  writeFileSync(process.argv[3], JSON.stringify(snapshot), 'utf8');
} else {
  test('in-process valid stream table: every scenario writes, measures, and decodes back through ReadStream', () => {
  const scenarios = buildValidStreamScenarios();
  assert.ok(scenarios.length >= 250, `expected comprehensive scenario count, got ${scenarios.length}`);

  for (const scenario of scenarios) {
    const rawBuffer = new Uint8Array(scenario.bufferBytes).fill(0xff);
    const writer = new WriteStream(rawBuffer);
    const writeReturns = scenario.run(writer);
    for (let i = 0; i < writeReturns.length; i++) {
      assert.equal(writeReturns[i], true, `${scenario.id}: write step ${i} must succeed`);
    }
    assert.equal(writer.ok, true, `${scenario.id}: writer.ok`);
    assert.equal(writer.error, null, `${scenario.id}: writer.error`);
    writer.flush();

    const measure = new MeasureStream();
    const measureReturns = scenario.run(measure);
    assert.deepEqual(measureReturns, writeReturns, `${scenario.id}: measure returns match write`);
    assert.equal(
      measure.bitsProcessed() >= writer.bitsProcessed(),
      true,
      `${scenario.id}: measure bits >= write bits`,
    );
    assert.equal(
      measure.bytesProcessed() >= writer.bytesProcessed(),
      true,
      `${scenario.id}: measure bytes >= write bytes`,
    );
    assert.equal(measure.alignBits(), 7, `${scenario.id}: measure alignBits`);

    if (scenario.verifyRead) {
      const reader = new ReadStream(writer.data());
      scenario.verifyRead(reader);
      assert.equal(reader.ok, true, `${scenario.id}: reader.ok`);
      assert.equal(reader.error, null, `${scenario.id}: reader.error`);
      const hasEnd =
        scenario.id.startsWith('ws.align_and_end.') ||
        scenario.id === 'ws.composite.golden_wire_106_bytes';
      if (hasEnd) {
        assert.equal(
          reader.bitsProcessed(),
          writer.bytesProcessed() * 8,
          `${scenario.id}: reader bitsProcessed after serializeEnd`,
        );
      } else {
        assert.equal(
          reader.bitsProcessed(),
          writer.bitsProcessed(),
          `${scenario.id}: reader bitsProcessed`,
        );
      }
    }
  }

  // Also sanity-check the golden wire bytes match GOLDEN_WIRE_BYTES.
  const goldenBuf = new Uint8Array(128);
  const goldenWriter = new WriteStream(goldenBuf);
  assert.equal(serializeGoldenWire(goldenWriter, makeGoldenRefs(goldenValues())), true);
  goldenWriter.flush();
  assert.deepEqual(goldenWriter.data(), GOLDEN_WIRE_BYTES);
  assert.equal(bitsRequired(0, 0), 0);
  assert.equal(bitsRequired64(0n, 0n), 0);
  assert.equal(bitsRequired128(0n, 0n), 0);
});

test('fresh module-load parity: checked (NODE_ENV=development) and production (NODE_ENV=production) are wire- and count-identical across the entire table', () => {
  const checkedSnapshot = runSnapshotChild('development');
  const productionSnapshot = runSnapshotChild('production');

  compareParitySnapshots(checkedSnapshot, productionSnapshot);

  // Also verify every overflow record threw on the 1-bit short case and latched nothing (U9).
  for (const rec of productionSnapshot.overflowRecords) {
    if ('shortSnap' in rec) {
      assert.equal(rec.exactRet, true, `${rec.id}: exact fit must succeed`);
      assert.equal(rec.exactSnap.ok, true, `${rec.id}: exact fit ok`);
      assert.equal(rec.exactSnap.error, null, `${rec.id}: exact fit error`);
      assert.equal(rec.exactSnap.bitsAvailable, 0, `${rec.id}: exact fit leaves 0 bits available`);
      assert.equal(rec.shortRet, 'RangeError', `${rec.id}: 1-bit short throws (U9)`);
      assert.equal(rec.bitsAfterShort, 192 - (rec.cost - 1), `${rec.id}: 1-bit short writes nothing`);
      assert.equal(rec.shortSnap.ok, true, `${rec.id}: 1-bit short latches nothing`);
      assert.equal(rec.shortSnap.error, null, `${rec.id}: 1-bit short records no reason`);
      assert.equal(rec.shortSnap.bitsAvailable, 0, `${rec.id}: the room left is still written`);
      assert.deepEqual(
        rec.stickyReturns,
        // end on a write is a no-op returning true (IMPLEMENTING.md U12)
        [true, true, true, true],
        `${rec.id}: no latch, later operations that fit are written`,
      );
      assert.equal(rec.recoverRet, true, `${rec.id}: reset() reuses the stream`);
      assert.equal(rec.recoverSnap.ok, true, `${rec.id}: reset() restores ok === true`);
      assert.equal(rec.recoverSnap.error, null, `${rec.id}: reset() clears error`);
    }
  }
});

test('sensitivity control: planted production-only byte, bit-count, measure-count, and overflow divergences are each caught by name', () => {
  const checkedSnapshot = collectFullParitySnapshot();
  const cloneJson = (obj) => JSON.parse(JSON.stringify(obj));
  // Create a synthetic checked/production pair from the live snapshot, then
  // plant one production-only divergence at a time and prove compareParitySnapshots
  // rejects each with the offending operation id in the failure message.
  const baseChecked = {
    ...cloneJson(checkedSnapshot),
    production: false,
    bitWriterClass: 'CheckedBitWriter',
    writeStreamClass: 'CheckedWriteStream',
    measureStreamClass: 'CheckedMeasureStream',
  };
  const baseProd = {
    ...cloneJson(checkedSnapshot),
    production: true,
    bitWriterClass: 'ProductionBitWriter',
    writeStreamClass: 'ProductionWriteStream',
    measureStreamClass: 'ProductionMeasureStream',
  };

  // Baseline unmutated pair passes.
  compareParitySnapshots(baseChecked, baseProd);

  // 1. Planted production BitWriter 1-bit wire divergence.
  {
    const mutated = cloneJson(baseProd);
    const target = mutated.bitWriterRecords.find((r) => r.id === 'bw.bits.17');
    assert.ok(target);
    const origHex = target.writeSnap.dataHex;
    const flippedFirstByte = ((parseInt(origHex.slice(0, 2), 16) ^ 0x01) & 0xff)
      .toString(16)
      .padStart(2, '0');
    target.writeSnap.dataHex = flippedFirstByte + origHex.slice(2);
    assert.throws(
      () => compareParitySnapshots(baseChecked, mutated),
      /bw\.bits\.17/,
      'planted BitWriter byte divergence must fail naming bw.bits.17',
    );
  }

  // 2. Planted production WriteStream canonical byte divergence on 128-bit fixed-point.
  {
    const mutated = cloneJson(baseProd);
    const target = mutated.streamRecords.find(
      (r) => r.id === 'ws.fixed.w128_q112_16_g3_78b.unaligned3',
    );
    assert.ok(target);
    const origHex = target.writeSnap.dataHex;
    const flipped = ((parseInt(origHex.slice(0, 2), 16) ^ 0x80) & 0xff)
      .toString(16)
      .padStart(2, '0');
    target.writeSnap.dataHex = flipped + origHex.slice(2);
    assert.throws(
      () => compareParitySnapshots(baseChecked, mutated),
      /ws\.fixed\.w128_q112_16_g3_78b\.unaligned3: canonical wire bytes parity/,
      'planted WriteStream byte divergence must fail naming the exact scenario',
    );
  }

  // 3. Planted production WriteStream bit-count divergence.
  {
    const mutated = cloneJson(baseProd);
    const target = mutated.streamRecords.find(
      (r) => r.id === 'ws.int_relative.t5_high.aligned',
    );
    assert.ok(target);
    target.writeSnap.bitsProcessed += 1;
    assert.throws(
      () => compareParitySnapshots(baseChecked, mutated),
      /ws\.int_relative\.t5_high\.aligned: write bitsProcessed parity/,
      'planted WriteStream bit-count divergence must fail naming the exact scenario',
    );
  }

  // 4. Planted production MeasureStream bit-count divergence.
  {
    const mutated = cloneJson(baseProd);
    const target = mutated.streamRecords.find(
      (r) => r.id === 'ws.string.empty_buf1_zero_bit_prefix.aligned',
    );
    assert.ok(target);
    target.measureSnap.bitsProcessed += 1;
    assert.throws(
      () => compareParitySnapshots(baseChecked, mutated),
      /ws\.string\.empty_buf1_zero_bit_prefix\.aligned: measure bitsProcessed parity/,
      'planted MeasureStream bit-count divergence must fail naming the exact scenario',
    );
  }

  // 5. Planted production overflow state divergence.
  {
    const mutated = cloneJson(baseProd);
    const target = mutated.overflowRecords.find(
      (r) => r.id === 'ws.overflow.int128_g4_128bit',
    );
    assert.ok(target);
    target.shortRet = false;
    assert.throws(
      () => compareParitySnapshots(baseChecked, mutated),
      /overflow parity mismatch at ws\.overflow\.int128_g4_128bit/,
      'planted overflow divergence must fail naming the exact overflow scenario',
    );
  }
});
}
