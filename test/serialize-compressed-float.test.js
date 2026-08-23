// serializeCompressedFloat conformance tests: the quantized float
// (STANDARD.md, "compressed_float"). The arithmetic is float32 with TWO
// roundings on each side -- the writer's product rounds BEFORE 0.5 is added,
// the reader's product rounds BEFORE min is added -- and the roundings are
// part of the format: fused or widened arithmetic changes the bytes on the
// write side and decodes a value one ulp off on the read side. The vectors
// here are the family's DISCRIMINATING pins, from serialize.h's
// test_compressed_float_conformance_nonzero_min and STANDARD.md's own vector
// table: values that land between quanta, decoded values compared by BITS
// with no tolerance -- a tolerance comparison cannot see a one-ulp
// divergence, which is exactly the bug class these vectors exist to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
} from '../src/index.js';

const dv = new DataView(new ArrayBuffer(4));

function bitsOfFloat32(value) {
  dv.setFloat32(0, value, true);
  return dv.getUint32(0, true);
}

// serialize.h's test_compressed_float_conformance_nonzero_min, pinned
// forever: 0.0, -99.875, -33.34 over [-100,100] at resolution 0.01
// (max_integer_value 20000, 15 bits each), then an align -- 48 bits, 6
// bytes. The comments carry what the wrong-but-plausible arithmetic
// produces, so a regression names its own bug.
const NONZERO_MIN_DECLARATION = [-100, 100, 0.01];
const NONZERO_MIN_VALUES = [0.0, -99.875, -33.34];
const NONZERO_MIN_BYTES = Uint8Array.from([0x10, 0xa7, 0x06, 0x80, 0x82, 0x06]);
const NONZERO_MIN_DECODED_BITS = [
  0x00000000, // 0.0 exactly -- under -ffast-math reciprocal division this row breaks
  0xc2c7bd71, // -99.87
  0xc2055c2a, // -33.340004 -- a fused decode gives 0xC2055C29, one ulp off
];

function nonzeroMinTrioSerialize(stream, refs) {
  const [min, max, resolution] = NONZERO_MIN_DECLARATION;
  for (const ref of refs) {
    if (!stream.serializeCompressedFloat(ref, min, max, resolution)) {
      return false;
    }
  }
  return stream.serializeAlign();
}

test('the nonzero-min conformance trio writes exactly the pinned bytes', () => {
  const writer = new WriteStream(new Uint8Array(64));
  const refs = NONZERO_MIN_VALUES.map((value) => ({ value }));
  assert.equal(nonzeroMinTrioSerialize(writer, refs), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), NONZERO_MIN_BYTES.length);
  assert.deepEqual(writer.data(), NONZERO_MIN_BYTES);
});

test('the nonzero-min pinned bytes decode to bit-exact float32 patterns', () => {
  // the decoded floats are pinned by BITS, never by tolerance: the
  // divergence this detects -- a fused multiply-add in the decode -- is a
  // single ulp, invisible to any tolerance comparison
  const reader = new ReadStream(NONZERO_MIN_BYTES);
  const refs = [{ value: -1 }, { value: -1 }, { value: -1 }];
  assert.equal(nonzeroMinTrioSerialize(reader, refs), true);
  for (let i = 0; i < refs.length; i++) {
    assert.equal(bitsOfFloat32(refs[i].value), NONZERO_MIN_DECODED_BITS[i],
      `decoded bit pattern of vector ${i}`);
  }
});

test('the writer quantizes with two float32 roundings: the [0,10] vector table', () => {
  // STANDARD.md's own table over [0,10] at resolution 0.01
  // (max_integer_value 1000, 10 bits). Every value here lands BETWEEN
  // quanta except the anchor: on-quantum values agree under float32, double
  // and FMA alike, so they can never discriminate -- which is how the arm64
  // writer divergence shipped in C++ v1.8.0 with every suite green.
  const cases = [
    [0.005, 1], // half a quantum above min: an FMA rounds once and writes 0
    [0.025, 3], // double arithmetic writes 2
    [0.105, 11], // double arithmetic writes 10
    [9.995, 1000], // double arithmetic writes 999
    [2.5, 250], // on-quantum anchor: agrees under every arithmetic
  ];
  for (const [value, integer] of cases) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeCompressedFloat({ value }, 0, 10, 0.01), true);
    assert.equal(writer.bitsProcessed(), 10, 'the declaration prices 10 bits');
    writer.flush();

    // read the raw quantized integer back off the wire
    const reader = new ReadStream(writer.data());
    const ref = {};
    assert.equal(reader.serializeBits(ref, 10), true);
    assert.equal(ref.value, integer,
      `${value} over [0,10] at 0.01 quantizes to ${integer}`);
  }
});

test('the reader decodes with two float32 roundings: integer 384 pinned by bits', () => {
  // over [-100,100] at 0.01, integer 384 must decode to
  // float32(float32(384/20000) * 200) + (-100): bits 0xC2C051EC
  // (-96.160004). A fused decode gives 0xC2C051EB (-96.159996), one ulp
  // off -- and a zero min can never catch it, because adding zero is
  // exact. The Go port's contraction test pins this same vector.
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 384 }, 15), true);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeCompressedFloat(ref, -100, 100, 0.01), true);
  assert.equal(reader.bitsProcessed(), 15, 'the declaration prices 15 bits');
  assert.equal(bitsOfFloat32(ref.value), 0xc2c051ec, 'decoded bit pattern');
});

test('a round trip recovers the nearest quantum: lossy by construction', () => {
  // 2.13 over [0,10] at 0.01 -- the C++ golden wire's compressed float
  // value: the round trip lands within the resolution, never exactly on
  // the input (which is not float32-representable to begin with)
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeCompressedFloat({ value: 2.13 }, 0, 10, 0.01), true);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeCompressedFloat(ref, 0, 10, 0.01), true);
  assert.ok(Math.abs(ref.value - 2.13) <= 0.01, `|${ref.value} - 2.13| within resolution`);

  // the recovered quantum is a fixed point: re-encoding it reproduces the wire
  const rewriter = new WriteStream(new Uint8Array(8));
  assert.equal(rewriter.serializeCompressedFloat({ value: ref.value }, 0, 10, 0.01), true);
  rewriter.flush();
  assert.deepEqual(rewriter.data(), writer.data());
});

test('huge delta over resolution clamps to the largest float32 below 2^32', () => {
  // [0,1e10] at resolution 1: values = 1e10 clamps to 4294967040, so the
  // integer domain stays inside uint32 -- 32 bits, no overflow. 5e9 sits
  // exactly halfway: it writes integer 2147483520 and comes back exact
  // (serialize.h's test_compressed_float_validation, second block).
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeCompressedFloat({ value: 5000000000 }, 0, 10000000000, 1), true);
  assert.equal(writer.bitsProcessed(), 32, 'the clamped domain prices 32 bits');
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeCompressedFloat(ref, 0, 10000000000, 1), true);
  assert.ok(Math.abs(ref.value - 5000000000) <= 4096, `${ref.value} within the coarse quantum`);
});

test('finite values outside [min,max] clamp, never refuse', () => {
  // the compressed float CLAMPS out-of-range values into the declaration --
  // the writer's normalized value is clamped to [0,1] (STANDARD.md) -- so
  // unlike the ranged integers there is no ValueOutOfRange on the write
  // side for a finite value: -200 writes the bytes of min, +200 the bytes
  // of max
  const wire = (value) => {
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeCompressedFloat({ value }, -100, 100, 0.01), true);
    assert.equal(writer.ok, true, `${value} clamps, never refuses`);
    writer.flush();
    return writer.data();
  };
  assert.deepEqual(wire(-200), wire(-100), 'below min clamps to min');
  assert.deepEqual(wire(200), wire(100), 'above max clamps to max');

  const low = new ReadStream(wire(-200));
  const ref = {};
  assert.equal(low.serializeCompressedFloat(ref, -100, 100, 0.01), true);
  assert.equal(ref.value, -100, 'clamped low decodes to min exactly');
  const high = new ReadStream(wire(200));
  assert.equal(high.serializeCompressedFloat(ref, -100, 100, 0.01), true);
  assert.equal(ref.value, 100, 'clamped high decodes to max exactly');
});

test('measure prices a compressed float at the declaration bit count', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeCompressedFloat({ value: 5 }, 0, 10, 0.01), true);
  assert.equal(measure.bitsProcessed(), 10, '[0,10] at 0.01: 10 bits');
  assert.equal(measure.serializeCompressedFloat({ value: 0 }, -100, 100, 0.01), true);
  assert.equal(measure.bitsProcessed(), 10 + 15, '[-100,100] at 0.01: 15 bits');
  assert.equal(measure.serializeCompressedFloat({ value: 0 }, 0, 10000000000, 1), true);
  assert.equal(measure.bitsProcessed(), 10 + 15 + 32, 'the clamped domain: 32 bits');
  // a clamping value measures like any other: it will write successfully
  assert.equal(measure.serializeCompressedFloat({ value: -200 }, -100, 100, 0.01), true);
  assert.equal(measure.bitsProcessed(), 10 + 15 + 32 + 15);
  assert.equal(measure.ok, true);
});

// The normative integer clamp (STANDARD.md, "The integer clamp is
// normative", 2026-08-23; schema#109, ruled by Glenn live). Once
// max_integer_value >= 2^23 the float32 ulp at the top of the range reaches
// 1, so floor(scaled + 0.5) can land ONE ABOVE max_integer_value when the
// value written is max. Two witnesses, both mandated by STANDARD.md, and
// they fail in two different ways without the clamp -- which is why both are
// pinned rather than one standing in for the other:
//
//   A. [0, 8388609] resolution 1 -- max_integer_value 8388609, 24 bits. The
//      unclamped code 8388610 FITS the field, so the wire is well formed and
//      the writer reports success; the reader's own
//      integerValue > max_integer_value check then REFUSES the packet. A
//      conforming writer's top-of-range value rejected by its own reader.
//
//   B. [0, 16777215] resolution 1 -- max_integer_value 16777215, 24 bits.
//      The unclamped code 16777216 needs 25 bits, so writeBits masks the top
//      bit away and the value decodes as 0 -- silent corruption, no error on
//      either side. This is the class where implementations diverged on the
//      wire before the ruling.
//
// Both write `max` and must round-trip to `max` exactly, compared by BITS.
const CLAMP_WITNESSES = [
  { declaration: [0, 8388609], maxIntegerValue: 8388609, bits: 24 },
  { declaration: [0, 16777215], maxIntegerValue: 16777215, bits: 24 },
];

test('the normative integer clamp: top-of-range round-trips in both witness declarations', () => {
  for (const { declaration, maxIntegerValue, bits } of CLAMP_WITNESSES) {
    const [min, max] = declaration;
    const label = `[${min}, ${max}] resolution 1`;

    const measure = new MeasureStream();
    assert.equal(measure.serializeCompressedFloat({ value: max }, min, max, 1), true);
    assert.equal(measure.bitsProcessed(), bits, `${label}: ${bits} bits`);

    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(
      writer.serializeCompressedFloat({ value: max }, min, max, 1),
      true,
      `${label}: writing max succeeds`,
    );
    writer.flush();
    assert.equal(writer.error, null, `${label}: no error latched on write`);

    const reader = new ReadStream(writer.data());
    const ref = { value: 0 };
    assert.equal(
      reader.serializeCompressedFloat(ref, min, max, 1),
      true,
      `${label}: the reader accepts its own writer's top-of-range code`,
    );
    assert.equal(reader.error, null, `${label}: no error latched on read`);
    assert.equal(
      bitsOfFloat32(ref.value),
      bitsOfFloat32(max),
      `${label}: max round-trips to max exactly`,
    );
  }
});

test('the normative integer clamp: the raw quantization would exceed max_integer_value', () => {
  // The arithmetic this clamp exists to correct, recomputed independently of
  // the library so the test states WHY the clamp is load bearing rather than
  // only that the result is right. If either row stops exceeding, the
  // witness has stopped witnessing and must be re-derived.
  for (const { declaration, maxIntegerValue } of CLAMP_WITNESSES) {
    const [min, max] = declaration;
    const delta = Math.fround(Math.fround(max) - Math.fround(min));
    const normalized = Math.fround(Math.fround(Math.fround(max) - Math.fround(min)) / delta);
    const scaled = Math.fround(normalized * Math.fround(maxIntegerValue));
    const unclamped = Math.floor(Math.fround(scaled + 0.5));
    assert.equal(
      unclamped,
      maxIntegerValue + 1,
      `[${min}, ${max}]: unclamped quantization lands one above max_integer_value`,
    );
  }
});
