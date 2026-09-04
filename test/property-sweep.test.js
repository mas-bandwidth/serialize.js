// The property sweep: randomized op programs over the whole serialize
// surface, driven by the suite's own PRNG -- a fixed-seed xorshift32, so
// every run of this file executes the identical programs and a failure
// reproduces exactly. Three properties hold for every program:
//
//   write == read   every value written round trips exactly (Object.is,
//                   so -0 survives and bit-transparent floats compare),
//                   and the reader consumes exactly the bits the writer
//                   produced;
//   measure >= write   the measure stream's conservative bound covers the
//                   real cost of the same program, whatever alignment the
//                   ops land on;
//   no throw        well-formed programs never throw on any stream.
//
// The compressed float participates on-quantum: the sweep picks a random
// quantized integer and decodes it through STANDARD.md's pinned float32
// arithmetic (every step rounding via fround), so the value is exactly
// representable on the wire and the round trip is exact -- the family's
// idempotence contract, exercised across random quanta and declarations.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, ReadStream, MeasureStream } from '../src/index.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// xorshift32, Marsaglia's original triple (13, 17, 5). The seed is fixed:
// the sweep is deterministic by design.
class XorShift32 {
  #state;

  constructor(seed) {
    this.#state = seed >>> 0;
  }

  /** The next 32-bit unsigned value. */
  next() {
    let x = this.#state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.#state = x;
    return x;
  }

  /** An integer in [0, n), n in [1, 2^32]. */
  below(n) {
    return this.next() % n;
  }

  /** A random 64-bit unsigned BigInt. */
  next64() {
    return (BigInt(this.next()) << 32n) | BigInt(this.next());
  }

  /** A random 128-bit unsigned BigInt. */
  next128() {
    return (this.next64() << 64n) | this.next64();
  }
}

const VIEW = new DataView(new ArrayBuffer(8));

// A random non-NaN float32 as a Number. NaN patterns are skipped: the
// wire carries them bit-transparently, but two NaN Numbers cannot be
// distinguished by value, so the sweep would compare blind.
function randomFloat32(rng) {
  for (;;) {
    VIEW.setUint32(0, rng.next(), true);
    const value = VIEW.getFloat32(0, true);
    if (!Number.isNaN(value)) {
      return value;
    }
  }
}

// A random non-NaN float64 as a Number.
function randomFloat64(rng) {
  for (;;) {
    VIEW.setUint32(0, rng.next(), true);
    VIEW.setUint32(4, rng.next(), true);
    const value = VIEW.getFloat64(0, true);
    if (!Number.isNaN(value)) {
      return value;
    }
  }
}

// STANDARD.md's compressed float declaration arithmetic, mirrored so the
// sweep can pick on-quantum values: float32 at every step.
function compressedFloatMaxInteger(min, max, resolution) {
  const delta = Math.fround(Math.fround(max) - Math.fround(min));
  let values = Math.fround(delta / Math.fround(resolution));
  if (!(values >= 1.0)) {
    values = 1.0;
  }
  return Math.ceil(values);
}

// The decode of a quantized integer, STANDARD.md's pinned float32
// arithmetic: the quotient rounds, the product rounds BEFORE min is added.
function compressedFloatDecode(q, min, max, resolution) {
  const maxIntegerValue = compressedFloatMaxInteger(min, max, resolution);
  const delta = Math.fround(Math.fround(max) - Math.fround(min));
  const normalized = Math.fround(Math.fround(q) / Math.fround(maxIntegerValue));
  const scaled = Math.fround(normalized * delta);
  return Math.fround(scaled + Math.fround(min));
}

const COMPRESSED_FLOAT_CONFIGS = [
  [0.0, 10.0, 0.01],
  [-100.0, 100.0, 0.01],
  [-1.0, 1.0, 0.001],
];

// Fixed point declarations across the three lanes: narrow Number, 64-bit
// BigInt two-group, and wide three/four-group storage.
const FIXED_CONFIGS = [
  [8, 8, -100, 100],
  [16, 16, -30000, 30000],
  [16, 16, 0, 60000],
  [32, 0, -100000, 100000],
  [48, 16, -100000000000n, 100000000000n],
  [64, 64, -1000n, 1000n],
  [112, 16, -144115188075855872n, 144115188075855872n],
  [64, 64, INT64_MIN, INT64_MAX],
];

const STRING_ALPHABET = '!#$%&()*+,-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz~';
const WSTRING_PALETTE = ['a', 'Z', '7', 'м', 'и', 'р', '€', 'é', '\u{1f600}', '\u{1f680}'];

// Each op: label for diagnostics, the expected value, and a run function
// applied identically to all three streams. holder is the {value} ref on
// write/measure, an empty ref on read; byte ops carry Uint8Array holders.
function randomOp(rng) {
  switch (rng.below(18)) {
    case 0: {
      const bits = 1 + rng.below(32);
      const value = (rng.next() & (bits === 32 ? 0xffffffff : (1 << bits) - 1)) >>> 0;
      return { label: `bits ${bits}`, value, run: (s, h) => s.serializeBits(h, bits) };
    }
    case 1: {
      const bits = 1 + rng.below(64);
      const value = rng.next64() & ((1n << BigInt(bits)) - 1n);
      return { label: `bits64 ${bits}`, value, run: (s, h) => s.serializeBits64(h, bits) };
    }
    case 2: {
      const a = rng.next() | 0;
      const b = rng.next() | 0;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const value = min + rng.below(max - min + 1);
      return { label: `int [${min},${max}]`, value, run: (s, h) => s.serializeInt(h, min, max) };
    }
    case 3: {
      const a = BigInt.asIntN(64, rng.next64());
      const b = BigInt.asIntN(64, rng.next64());
      const min = a < b ? a : b;
      const max = a < b ? b : a;
      const value = min + (rng.next64() % (max - min + 1n));
      return { label: `int64 [${min},${max}]`, value, run: (s, h) => s.serializeInt64(h, min, max) };
    }
    case 4: {
      const a = BigInt.asIntN(128, rng.next128());
      const b = BigInt.asIntN(128, rng.next128());
      const min = a < b ? a : b;
      const max = a < b ? b : a;
      const value = min + (rng.next128() % (max - min + 1n));
      return { label: `int128 [${min},${max}]`, value, run: (s, h) => s.serializeInt128(h, min, max) };
    }
    case 5: {
      const value = rng.next() & 0xff;
      return { label: 'uint8', value, run: (s, h) => s.serializeUint8(h) };
    }
    case 6: {
      const value = rng.next() & 0xffff;
      return { label: 'uint16', value, run: (s, h) => s.serializeUint16(h) };
    }
    case 7: {
      const value = rng.next();
      return { label: 'uint32', value, run: (s, h) => s.serializeUint32(h) };
    }
    case 8: {
      const value = rng.next64();
      return { label: 'uint64', value, run: (s, h) => s.serializeUint64(h) };
    }
    case 9: {
      const value = rng.next128();
      return { label: 'uint128', value, run: (s, h) => s.serializeUint128(h) };
    }
    case 10: {
      const value = (rng.next() & 1) === 1;
      return { label: 'bool', value, run: (s, h) => s.serializeBool(h) };
    }
    case 11: {
      const value = randomFloat32(rng);
      return { label: 'float', value, run: (s, h) => s.serializeFloat(h) };
    }
    case 12: {
      const value = randomFloat64(rng);
      return { label: 'double', value, run: (s, h) => s.serializeDouble(h) };
    }
    case 13: {
      const [min, max, resolution] = COMPRESSED_FLOAT_CONFIGS[rng.below(COMPRESSED_FLOAT_CONFIGS.length)];
      const q = rng.below(compressedFloatMaxInteger(min, max, resolution) + 1);
      const value = compressedFloatDecode(q, min, max, resolution);
      return {
        label: `compressedFloat [${min},${max}] ${resolution}`,
        value,
        run: (s, h) => s.serializeCompressedFloat(h, min, max, resolution),
      };
    }
    case 14: {
      return { label: 'align', value: null, run: (s) => s.serializeAlign() };
    }
    case 15: {
      const value = new Uint8Array(rng.below(32));
      for (let i = 0; i < value.length; i++) {
        value[i] = rng.next() & 0xff;
      }
      return { label: `bytes ${value.length}`, value, bytes: true, run: (s, h) => s.serializeBytes(h) };
    }
    case 16: {
      if ((rng.next() & 1) === 1) {
        const length = rng.below(13);
        let value = '';
        for (let i = 0; i < length; i++) {
          value += STRING_ALPHABET[rng.below(STRING_ALPHABET.length)];
        }
        return { label: `string "${value}"`, value, run: (s, h) => s.serializeString(h, 64) };
      }
      const length = rng.below(11);
      let value = '';
      for (let i = 0; i < length; i++) {
        value += WSTRING_PALETTE[rng.below(WSTRING_PALETTE.length)];
      }
      return { label: `wstring "${value}"`, value, run: (s, h) => s.serializeWideString(h, 64) };
    }
    default: {
      if ((rng.next() & 1) === 1) {
        // the int_relative domain is 0 to 2^31 - 1 inclusive; drawing
        // previous below its top keeps the headroom above non-empty
        const previous = rng.below(0x7fffffff); // [0, 2^31-2]
        const headroom = 0x7fffffff - previous;
        let value;
        switch (rng.below(4)) {
          case 0: value = previous + 1; break; // the one bit branch
          case 1: value = previous + 1 + rng.below(Math.min(headroom, 70000)); break; // the ladder
          case 2: value = previous + 1 + rng.below(headroom); break; // anywhere above
          default: value = 0x7fffffff; break; // the absolute branch's far edge
        }
        return { label: `intRelative ${previous}`, value, run: (s, h) => s.serializeIntRelative(previous, h) };
      }
      const [integerBits, fractionBits, min, max] = FIXED_CONFIGS[rng.below(FIXED_CONFIGS.length)];
      let value;
      if (typeof min === 'bigint') {
        const scale = 1n << BigInt(fractionBits);
        const rawMin = min * scale;
        const rawRange = max * scale - rawMin;
        value = rawMin + (rng.next128() % (rawRange + 1n));
      } else {
        const scale = 2 ** fractionBits;
        const rawMin = min * scale;
        const rawRange = max * scale - rawMin;
        value = rawMin + rng.below(rawRange + 1);
      }
      return {
        label: `fixed Q${integerBits}.${fractionBits} [${min},${max}]`,
        value,
        run: (s, h) => s.serializeFixed(h, integerBits, fractionBits, min, max),
      };
    }
  }
}

test('random op programs: write == read exactly, measure >= write, nothing throws', () => {
  const rng = new XorShift32(0x5eed1e55);
  const PROGRAMS = 256;

  for (let p = 0; p < PROGRAMS; p++) {
    const program = [];
    const opCount = 1 + rng.below(32);
    for (let i = 0; i < opCount; i++) {
      program.push(randomOp(rng));
    }
    const context = (i) => `program ${p} op ${i} (${program[i].label})`;

    const writer = new WriteStream(new Uint8Array(16384));
    for (let i = 0; i < program.length; i++) {
      const op = program[i];
      const holder = op.value === null ? undefined : op.bytes ? op.value : { value: op.value };
      assert.equal(op.run(writer, holder), true, `write ${context(i)}`);
    }
    writer.flush();

    const reader = new ReadStream(writer.data());
    for (let i = 0; i < program.length; i++) {
      const op = program[i];
      if (op.value === null) {
        assert.equal(op.run(reader), true, `read ${context(i)}`);
        continue;
      }
      if (op.bytes) {
        const holder = new Uint8Array(op.value.length);
        assert.equal(op.run(reader, holder), true, `read ${context(i)}`);
        assert.deepEqual(Array.from(holder), Array.from(op.value), `round trip ${context(i)}`);
        continue;
      }
      const holder = {};
      assert.equal(op.run(reader, holder), true, `read ${context(i)}`);
      assert.equal(Object.is(holder.value, op.value), true,
        `round trip ${context(i)}: read ${holder.value}, wrote ${op.value}`);
    }
    assert.equal(reader.bitsProcessed(), writer.bitsProcessed(), `bit count of program ${p}`);

    const measure = new MeasureStream();
    for (let i = 0; i < program.length; i++) {
      const op = program[i];
      const holder = op.value === null ? undefined : op.bytes ? op.value : { value: op.value };
      assert.equal(op.run(measure, holder), true, `measure ${context(i)}`);
    }
    assert.equal(measure.bitsProcessed() >= writer.bitsProcessed(), true,
      `program ${p}: measured ${measure.bitsProcessed()} bits, wrote ${writer.bitsProcessed()}`);
  }
});
