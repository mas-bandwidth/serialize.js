// serialize.js benchmark.
//
// A deliberate operation-for-operation mirror of serialize.c's bench.c --
// itself a mirror of the C++ library's bench.cpp -- so the outputs of all the
// family's benchmarks can be read side by side. Same operations in the same
// order, same iteration counts, same buffer sizes, same LCG-driven input
// data, same best-of-five-trials discipline, same reporting format and units.
//
//   node bench/bench.js           the rows, human readable, as the C bench prints them
//   node bench/bench.js --csv     the same numbers as CSV: row,op,units,value
//
// Iteration counts are overridable so the harness can be run at a different
// scale and the timings checked for linearity -- a benchmark whose loop has
// been optimized away does not scale with its iteration count:
//
//   BENCH_BITPACKER_PASSES=256 BENCH_STREAM_PACKETS=100000 node bench/bench.js
//
// GOLDEN GATED: before any row is timed, the exact buffers its loops write
// are verified byte for byte against pins produced by serialize.c's own bench
// data paths (tending has the dump tool's shape; the pins below carry the hex).
// The 64-bit LCG here is the C bench's LCG carried in two 32-bit lanes, and
// the pins prove it: variant 0 diverges on any error in a single step, and
// variant 63 diverges on any error anywhere in 64 chained steps, in any field,
// in any serialize operation. The read leg then decodes every variant buffer
// and verifies every field. A bench that fails its goldens reports nothing.
//
// WHAT IT EXISTS TO ANSWER
//
// Where the JavaScript runtime lands against the other five implementations,
// on the same rows -- in BOTH of its modes. The write path forks at module
// load on NODE_ENV (see src/mode.js): a plain run measures the CHECKED
// variants (the development default), and NODE_ENV=production measures the
// caller-trust release shape, the number that answers the family's release
// benches. The golden gate runs in either mode, so a production run proves
// its wire before it times a row. Two costs are structural and deliberately
// left visible rather than
// benched around: the streams' reset() path re-wraps the buffer in a DataView
// per packet (the library's own allocation-free-reuse surface, measured as
// shipped), and the stream row's uint64 field crosses the BigInt edge per
// packet, because serializeUint64 takes a BigInt -- that is the library's
// real wide edge and the bench pays it honestly, exactly where a generated
// caller would.
//
// WHAT IS DELIBERATELY NOT MIRRORED
//
// bench.cpp's compile time rows (its template parameter surface) have no
// counterpart in JavaScript, the same omission serialize.c makes. And where
// bench.c writes separate write/read/measure functions per shape -- C has no
// other way -- this bench writes ONE serialize function per shape and runs it
// against all three streams: the family's defining pattern, and exactly what
// generated JavaScript looks like. The wire is identical; the pins prove it.
//
// Only numbers from a quiet machine are meaningful, and only as ratios
// between family legs measured back to back on the same machine.

import { BitWriter, BitReader, WriteStream, ReadStream, MeasureStream } from '../src/index.js';

/* --------------------------------------------------------------------------
   harness
   -------------------------------------------------------------------------- */

const NUM_TRIALS = 5;
const NUM_VARIANTS = 64;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    process.stderr.write(`${name} must be a positive integer\n`);
    process.exit(1);
  }
  return value;
}

const BITPACKER_BUFFER_SIZE = 64 * 1024;
const BITPACKER_NUM_PASSES = envInt('BENCH_BITPACKER_PASSES', 4096);
const STREAM_NUM_PACKETS = envInt('BENCH_STREAM_PACKETS', 1000000);

const CSV = process.argv.includes('--csv');

function now() {
  return Number(process.hrtime.bigint()) * 1e-9;
}

// the g_sink of the C bench: computed values flow here, and the module
// publishes it at exit, so no loop's work can be proven unobservable
let sink = 0;

const results = []; // { row, op, units, value }

function report(row, op, units, value) {
  results.push({ row, op, units, value });
}

function print(line) {
  if (!CSV) {
    process.stdout.write(line);
  }
}

function toHex(data, bytes) {
  let hex = '';
  for (let i = 0; i < bytes; i++) {
    hex += data[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function gateFail(row, what, expected, got) {
  process.stderr.write(`GOLDEN GATE FAILED: ${row} ${what}\n  expected ${expected}\n  got      ${got}\n`);
  process.stderr.write('reporting nothing.\n');
  process.exit(1);
}

/* --------------------------------------------------------------------------
   the C bench's uint64 LCG, carried in two 32-bit lanes

   rng = rng * 6364136223846793005 + 1442695040888963407 (mod 2^64), lane
   arithmetic exact in the double domain: the low 32x32 product goes through
   16-bit limbs (every partial sum stays far below 2^53), the cross products
   only matter mod 2^32 so Math.imul carries them, and the carries are
   recovered by exact subtraction. BigInt never steps the generator.
   -------------------------------------------------------------------------- */

const LCG_MUL_LO = 0x4c957f2d;
const LCG_MUL_HI = 0x5851f42d;
const LCG_ADD_LO = 0xf767814f;
const LCG_ADD_HI = 0x14057b7e;

const rng = { lo: 1, hi: 0 };

function lcgSeed() {
  rng.lo = 1;
  rng.hi = 0;
}

function lcgStep() {
  const aLo = rng.lo;
  const aHi = rng.hi;
  const aL = aLo & 0xffff;
  const aH = aLo >>> 16;
  const low = aL * (LCG_MUL_LO & 0xffff) + (aL * (LCG_MUL_LO >>> 16) + aH * (LCG_MUL_LO & 0xffff)) * 65536;
  const pLo = low >>> 0;
  const carry = (low - pLo) / 4294967296;
  const hi =
    (aH * (LCG_MUL_LO >>> 16) + carry + (Math.imul(aLo, LCG_MUL_HI) >>> 0) + (Math.imul(aHi, LCG_MUL_LO) >>> 0)) %
    4294967296;
  const sLo = pLo + LCG_ADD_LO;
  rng.lo = sLo >>> 0;
  rng.hi = ((hi + LCG_ADD_HI + (sLo >= 4294967296 ? 1 : 0)) % 4294967296) >>> 0;
}

// the low 32 bits of (rng >> s), for s in [0,63]
function shr64(lo, hi, s) {
  if (s === 0) {
    return lo;
  }
  if (s < 32) {
    return ((lo >>> s) | (hi << (32 - s))) >>> 0;
  }
  return hi >>> (s - 32);
}

/* --------------------------------------------------------------------------
   pins

   Produced by serialize.c's own bench data paths (its static vary and write
   functions, run to the letter): the bitpacker's pass buffer, and for each
   packet shape the first and last of the 64 variant buffers the read leg
   decodes. Byte identical across the family, so these gate this bench's wire
   against the C reference, not against itself.
   -------------------------------------------------------------------------- */

const PIN_BITPACKER = {
  bytesPerPass: 65518,
  first64:
    'e5e6dd7856e4a656da4c1f909b173ac12a3e2f56da3c5011ce0b72f32e37efc6' +
    'b32237b5d266fa80dcbcd00956f179b1d2e6818a705e909b77b979379e15b9a9',
  last8: 'cd0315e1bc20376f',
};

const PIN_STREAM = {
  bytesPerPacket: 49,
  variant0: '44fd43634d97ff0006d03f0000f0850000a08001809085f800fa8758dfaed800ac1f3e5d7c9bbad9f81736557493b2d1f0',
  variant63: '7e6bc3e30c348874a5bb360182748e0000a080018090858274d786d778b6ae016b1f3e5d7c9bbad9f81736557493b2d1f0',
};

const PIN_INT = {
  bytesPerPacket: 14,
  variant0: '44fd43634df7f390f5be45153d1b',
  variant63: '7e6bc3e30c14d7508df23ce1b915',
};

const PIN_BITS = {
  bytesPerPacket: 20,
  variant0: 'fc073080fe51ff10eb5bdfec8acd07d03fc4fa06',
  variant63: '41a42bddb5f1daf01acf7866eb1aa4bb36bcc603',
};

const PIN_GEN = {
  bytesPerPacket: 21,
  variant0: '00fdfd43ac6f7cf0430cb1c6fa1ec007d03fc4fa66',
  variant63: 'ba6b6bc36b3c416ac30bafbdc69116a4bb36bcc6d3',
};

/* --------------------------------------------------------------------------
   bitpacker

   The raw bit packer with mixed widths: 227 bits per group of 16 writes,
   repeated until fewer than 256 bits remain in a 64KB buffer.
   -------------------------------------------------------------------------- */

const NUM_WIDTHS = 16;
const BITPACKER_WIDTHS = [1, 32, 7, 13, 3, 25, 8, 19, 4, 28, 11, 16, 2, 30, 6, 22];
const bitpackerValues = new Uint32Array(NUM_WIDTHS);

for (let i = 0; i < NUM_WIDTHS; i++) {
  const width = BITPACKER_WIDTHS[i];
  const mask = width === 32 ? 0xffffffff : ((1 << width) >>> 0) - 1;
  bitpackerValues[i] = (Math.imul(0x9e3779b9, i + 1) & mask) >>> 0;
}

// One pass, held byte for byte against the C reference, then read back in
// full. Returns the written pass buffer and its size for the timing loops.
function gateBitpacker() {
  const buffer = new Uint8Array(BITPACKER_BUFFER_SIZE);
  const writer = new BitWriter(buffer);
  const reader = new BitReader(buffer);

  while (writer.bitsAvailable() >= 256) {
    for (let i = 0; i < NUM_WIDTHS; i++) {
      writer.writeBits(bitpackerValues[i], BITPACKER_WIDTHS[i]);
    }
  }
  writer.flushBits();
  const bytesPerPass = writer.bytesWritten();
  if (bytesPerPass !== PIN_BITPACKER.bytesPerPass) {
    gateFail('bitpacker', 'bytes per pass', String(PIN_BITPACKER.bytesPerPass), String(bytesPerPass));
  }
  const first64 = toHex(buffer, 64);
  if (first64 !== PIN_BITPACKER.first64) {
    gateFail('bitpacker', 'first 64 bytes', PIN_BITPACKER.first64, first64);
  }
  const last8 = toHex(buffer.subarray(bytesPerPass - 8), 8);
  if (last8 !== PIN_BITPACKER.last8) {
    gateFail('bitpacker', 'last 8 bytes', PIN_BITPACKER.last8, last8);
  }
  reader.reset(buffer);
  while (reader.bitsRemaining() >= 256) {
    for (let i = 0; i < NUM_WIDTHS; i++) {
      const value = reader.readBits(BITPACKER_WIDTHS[i]);
      if (value !== bitpackerValues[i]) {
        gateFail('bitpacker', 'read back', String(bitpackerValues[i]), String(value));
      }
    }
  }

  return { buffer, bytesPerPass };
}

function benchBitpacker({ buffer, bytesPerPass }) {
  const writer = new BitWriter(buffer);
  const reader = new BitReader(buffer);

  let bestWrite = Infinity;
  let bestRead = Infinity;

  for (let trial = 0; trial < NUM_TRIALS; trial++) {
    let start = now();
    for (let pass = 0; pass < BITPACKER_NUM_PASSES; pass++) {
      writer.reset(buffer);
      while (writer.bitsAvailable() >= 256) {
        for (let i = 0; i < NUM_WIDTHS; i++) {
          writer.writeBits(bitpackerValues[i], BITPACKER_WIDTHS[i]);
        }
      }
      writer.flushBits();
      sink = (sink + writer.bytesWritten()) | 0;
    }
    let elapsed = now() - start;
    if (elapsed < bestWrite) {
      bestWrite = elapsed;
    }

    start = now();
    for (let pass = 0; pass < BITPACKER_NUM_PASSES; pass++) {
      reader.reset(buffer);
      let sum = 0;
      while (reader.bitsRemaining() >= 256) {
        for (let i = 0; i < NUM_WIDTHS; i++) {
          sum += reader.readBits(BITPACKER_WIDTHS[i]);
        }
      }
      sink = (sink + sum) | 0;
    }
    elapsed = now() - start;
    if (elapsed < bestRead) {
      bestRead = elapsed;
    }
  }

  const totalMB = (bytesPerPass * BITPACKER_NUM_PASSES) / (1024 * 1024);
  report('bitpacker', 'write', 'MB/s', totalMB / bestWrite);
  report('bitpacker', 'read', 'MB/s', totalMB / bestRead);
  print(`bitpacker write:  ${(totalMB / bestWrite).toFixed(1).padStart(8)} MB/s\n`);
  print(`bitpacker read:   ${(totalMB / bestRead).toFixed(1).padStart(8)} MB/s\n`);
}

/* --------------------------------------------------------------------------
   packet shapes

   Each shape is one serialize function run against all three streams, a
   vary function that drives most fields from the serially dependent LCG the
   optimizer cannot fold, and a field-equality check for the read gate.
   Packets are { value } holder objects created once and mutated in place:
   the loops allocate nothing of their own, so what the timings show is the
   library, plus the two structural costs named at the top of this file.
   -------------------------------------------------------------------------- */

// shape: the representative stream packet (ints, bits, bool, floats, uint64, bytes)

function makeBenchPacket() {
  return {
    a: { value: 0 },
    b: { value: 0 },
    c: { value: 0 },
    bits7: { value: 0 },
    bits13: { value: 0 },
    bits23: { value: 0 },
    flag: { value: false },
    x: { value: 0 },
    y: { value: 0 },
    z: { value: 0 },
    big: { value: 0n },
    blob: new Uint8Array(17),
  };
}

function initBenchPacket(p) {
  p.a.value = -37;
  p.b.value = 12345;
  p.c.value = 987654;
  p.bits7.value = 97;
  p.bits13.value = 5000;
  p.bits23.value = 1234567;
  p.flag.value = true;
  p.x.value = 1.5;
  p.y.value = -3.25;
  p.z.value = 100.125;
  p.big.value = 0x123456789abcdef0n;
  for (let i = 0; i < 17; i++) {
    p.blob[i] = (i * 31) & 0xff;
  }
}

function varyBenchPacket(p) {
  lcgStep();
  const lo = rng.lo;
  const hi = rng.hi;
  p.a.value = (shr64(lo, hi, 8) & 63) - 32;
  p.b.value = shr64(lo, hi, 16) & 65535;
  p.c.value = (shr64(lo, hi, 24) & 0xfffff) - 500000;
  p.bits7.value = lo & 127;
  p.bits13.value = shr64(lo, hi, 3) & 8191;
  p.bits23.value = shr64(lo, hi, 5) & 8388607;
  p.flag.value = (lo & 1) !== 0;
  p.x.value = lo & 0xffff; // exact in float32
  p.big.value = (BigInt(hi) << 32n) | BigInt(lo); // the library's BigInt edge
  p.blob[0] = hi & 0xff;
}

function serializeBenchPacket(stream, p) {
  return (
    stream.serializeInt(p.a, -100, 100) &&
    stream.serializeInt(p.b, 0, 65535) &&
    stream.serializeInt(p.c, -1000000, 1000000) &&
    stream.serializeBits(p.bits7, 7) &&
    stream.serializeBits(p.bits13, 13) &&
    stream.serializeBits(p.bits23, 23) &&
    stream.serializeBool(p.flag) &&
    stream.serializeFloat(p.x) &&
    stream.serializeFloat(p.y) &&
    stream.serializeFloat(p.z) &&
    stream.serializeUint64(p.big) &&
    stream.serializeBytes(p.blob)
  );
}

function checkBenchPacket(expected, decoded) {
  if (
    expected.a.value !== decoded.a.value ||
    expected.b.value !== decoded.b.value ||
    expected.c.value !== decoded.c.value ||
    expected.bits7.value !== decoded.bits7.value ||
    expected.bits13.value !== decoded.bits13.value ||
    expected.bits23.value !== decoded.bits23.value ||
    expected.flag.value !== decoded.flag.value ||
    expected.x.value !== decoded.x.value ||
    expected.y.value !== decoded.y.value ||
    expected.z.value !== decoded.z.value ||
    expected.big.value !== decoded.big.value
  ) {
    return false;
  }
  for (let i = 0; i < 17; i++) {
    if (expected.blob[i] !== decoded.blob[i]) {
      return false;
    }
  }
  return true;
}

// shape 1: a realistic packet of ten bounded ints

function makeIntFields() {
  return {
    f0: { value: 0 },
    f1: { value: 0 },
    f2: { value: 0 },
    f3: { value: 0 },
    f4: { value: 0 },
    f5: { value: 0 },
    f6: { value: 0 },
    f7: { value: 0 },
    f8: { value: 0 },
    f9: { value: 0 },
  };
}

function varyIntFields(f) {
  lcgStep();
  const lo = rng.lo;
  const hi = rng.hi;
  f.f0.value = (shr64(lo, hi, 8) & 63) - 32;
  f.f1.value = shr64(lo, hi, 16) & 65535;
  f.f2.value = (shr64(lo, hi, 24) & 0xfffff) - 500000;
  f.f3.value = shr64(lo, hi, 2) & 3;
  f.f4.value = (shr64(lo, hi, 11) & 15) - 8;
  f.f5.value = shr64(lo, hi, 22) & 511;
  f.f6.value = (shr64(lo, hi, 33) & 2047) - 1024;
  f.f7.value = shr64(lo, hi, 40) & 255;
  f.f8.value = (shr64(lo, hi, 30) & 0xfffff) - 500000;
  f.f9.value = shr64(lo, hi, 57) & 63;
}

function serializeIntFields(stream, f) {
  return (
    stream.serializeInt(f.f0, -100, 100) &&
    stream.serializeInt(f.f1, 0, 65535) &&
    stream.serializeInt(f.f2, -1000000, 1000000) &&
    stream.serializeInt(f.f3, 0, 3) &&
    stream.serializeInt(f.f4, -15, 15) &&
    stream.serializeInt(f.f5, 0, 1000) &&
    stream.serializeInt(f.f6, -2048, 2047) &&
    stream.serializeInt(f.f7, 0, 255) &&
    stream.serializeInt(f.f8, -600000, 600000) &&
    stream.serializeInt(f.f9, 0, 100)
  );
}

function checkIntFields(expected, decoded) {
  return (
    expected.f0.value === decoded.f0.value &&
    expected.f1.value === decoded.f1.value &&
    expected.f2.value === decoded.f2.value &&
    expected.f3.value === decoded.f3.value &&
    expected.f4.value === decoded.f4.value &&
    expected.f5.value === decoded.f5.value &&
    expected.f6.value === decoded.f6.value &&
    expected.f7.value === decoded.f7.value &&
    expected.f8.value === decoded.f8.value &&
    expected.f9.value === decoded.f9.value
  );
}

// shape 2: mixed bit widths including one wider than 32 bits. The 48-bit
// field travels as its low dword then the 16-bit remainder in two lanes --
// STANDARD.md's splitting rule, and exactly what generated JavaScript writes
// by hand to keep a hot timestamp out of the BigInt domain.

function makeBitsFields() {
  return {
    b7: { value: 0 },
    b13: { value: 0 },
    b23: { value: 0 },
    b3: { value: 0 },
    b32: { value: 0 },
    b11: { value: 0 },
    b19: { value: 0 },
    b48lo: { value: 0 },
    b48hi: { value: 0 },
  };
}

function varyBitsFields(f) {
  lcgStep();
  const lo = rng.lo;
  const hi = rng.hi;
  f.b7.value = lo & 127;
  f.b13.value = shr64(lo, hi, 3) & 8191;
  f.b23.value = shr64(lo, hi, 5) & 8388607;
  f.b3.value = shr64(lo, hi, 29) & 7;
  f.b32.value = shr64(lo, hi, 16);
  f.b11.value = shr64(lo, hi, 37) & 2047;
  f.b19.value = shr64(lo, hi, 44) & 524287;
  f.b48lo.value = lo;
  f.b48hi.value = hi & 0xffff;
}

function serializeBitsFields(stream, f) {
  return (
    stream.serializeBits(f.b7, 7) &&
    stream.serializeBits(f.b13, 13) &&
    stream.serializeBits(f.b23, 23) &&
    stream.serializeBits(f.b3, 3) &&
    stream.serializeBits(f.b32, 32) &&
    stream.serializeBits(f.b11, 11) &&
    stream.serializeBits(f.b19, 19) &&
    stream.serializeBits(f.b48lo, 32) &&
    stream.serializeBits(f.b48hi, 16)
  );
}

function checkBitsFields(expected, decoded) {
  return (
    expected.b7.value === decoded.b7.value &&
    expected.b13.value === decoded.b13.value &&
    expected.b23.value === decoded.b23.value &&
    expected.b3.value === decoded.b3.value &&
    expected.b32.value === decoded.b32.value &&
    expected.b11.value === decoded.b11.value &&
    expected.b19.value === decoded.b19.value &&
    expected.b48lo.value === decoded.b48lo.value &&
    expected.b48hi.value === decoded.b48hi.value
  );
}

// shape 3: a "generated packet" mixing bounded ints, bits and bools, the way
// schema generated code looks. The 48-bit timestamp travels in two lanes.

function makeGenFields() {
  return {
    sequence: { value: 0 },
    ackBits: { value: 0 },
    entityId: { value: 0 },
    posX: { value: 0 },
    posY: { value: 0 },
    posZ: { value: 0 },
    yaw: { value: 0 },
    moving: { value: false },
    firing: { value: false },
    timestampLo: { value: 0 },
    timestampHi: { value: 0 },
    weapon: { value: 0 },
  };
}

function varyGenFields(f) {
  lcgStep();
  const lo = rng.lo;
  const hi = rng.hi;
  f.sequence.value = shr64(lo, hi, 8) & 65535;
  f.ackBits.value = shr64(lo, hi, 16);
  f.entityId.value = lo & 4095;
  f.posX.value = (shr64(lo, hi, 20) & 32767) - 16384;
  f.posY.value = (shr64(lo, hi, 25) & 32767) - 16384;
  f.posZ.value = (shr64(lo, hi, 30) & 32767) - 16384;
  f.yaw.value = shr64(lo, hi, 3) & 511;
  f.moving.value = (lo & 1) !== 0;
  f.firing.value = (lo & 2) !== 0;
  f.timestampLo.value = lo;
  f.timestampHi.value = hi & 0xffff;
  f.weapon.value = shr64(lo, hi, 60) & 15;
}

function serializeGenFields(stream, f) {
  return (
    stream.serializeInt(f.sequence, 0, 65535) &&
    stream.serializeBits(f.ackBits, 32) &&
    stream.serializeBits(f.entityId, 12) &&
    stream.serializeInt(f.posX, -16384, 16383) &&
    stream.serializeInt(f.posY, -16384, 16383) &&
    stream.serializeInt(f.posZ, -16384, 16383) &&
    stream.serializeBits(f.yaw, 9) &&
    stream.serializeBool(f.moving) &&
    stream.serializeBool(f.firing) &&
    stream.serializeBits(f.timestampLo, 32) &&
    stream.serializeBits(f.timestampHi, 16) &&
    stream.serializeInt(f.weapon, 0, 15)
  );
}

function checkGenFields(expected, decoded) {
  return (
    expected.sequence.value === decoded.sequence.value &&
    expected.ackBits.value === decoded.ackBits.value &&
    expected.entityId.value === decoded.entityId.value &&
    expected.posX.value === decoded.posX.value &&
    expected.posY.value === decoded.posY.value &&
    expected.posZ.value === decoded.posZ.value &&
    expected.yaw.value === decoded.yaw.value &&
    expected.moving.value === decoded.moving.value &&
    expected.firing.value === decoded.firing.value &&
    expected.timestampLo.value === decoded.timestampLo.value &&
    expected.timestampHi.value === decoded.timestampHi.value &&
    expected.weapon.value === decoded.weapon.value
  );
}

/* --------------------------------------------------------------------------
   variant generation and the golden gate, shared by every packet shape
   -------------------------------------------------------------------------- */

// Pre-writes the 64 variant buffers the read leg decodes, using the same LCG
// sequence as the write loop, then holds the wire against the C pins and
// decodes every variant back, verifying every field. Returns the variant
// views and the constant per-packet byte size.
function gateShape(shape) {
  const { row, packet, decoded, init, vary, serialize, check, pin } = shape;

  init(packet);
  lcgSeed();
  const variants = [];
  let bytesPerPacket = 0;
  const writer = new WriteStream(new Uint8Array(256));
  for (let k = 0; k < NUM_VARIANTS; k++) {
    const buffer = new Uint8Array(256);
    vary(packet);
    writer.reset(buffer);
    if (!serialize(writer, packet)) {
      gateFail(row, 'variant write', 'ok', String(writer.error));
    }
    writer.flush();
    bytesPerPacket = writer.bytesProcessed();
    variants.push(buffer.subarray(0, bytesPerPacket));
  }

  if (bytesPerPacket !== pin.bytesPerPacket) {
    gateFail(row, 'bytes per packet', String(pin.bytesPerPacket), String(bytesPerPacket));
  }
  const hex0 = toHex(variants[0], bytesPerPacket);
  if (hex0 !== pin.variant0) {
    gateFail(row, 'variant 0 wire', pin.variant0, hex0);
  }
  const hex63 = toHex(variants[63], bytesPerPacket);
  if (hex63 !== pin.variant63) {
    gateFail(row, 'variant 63 wire', pin.variant63, hex63);
  }

  // decode every variant and verify every field against a replay of the LCG
  init(packet);
  lcgSeed();
  const reader = new ReadStream(variants[0]);
  for (let k = 0; k < NUM_VARIANTS; k++) {
    vary(packet);
    reader.reset(variants[k]);
    if (!serialize(reader, decoded)) {
      gateFail(row, `variant ${k} decode`, 'ok', String(reader.error));
    }
    if (!check(packet, decoded)) {
      gateFail(row, `variant ${k} fields`, 'writer values', 'different values');
    }
  }

  return { variants, bytesPerPacket };
}

/* --------------------------------------------------------------------------
   stream

   The representative packet through all three streams: MB/s and M packets/s
   for write and read, M packets/s for measure.
   -------------------------------------------------------------------------- */

function gateStream() {
  const packet = makeBenchPacket();
  const decoded = makeBenchPacket();
  const shape = {
    row: 'stream',
    packet,
    decoded,
    init: initBenchPacket,
    vary: varyBenchPacket,
    serialize: serializeBenchPacket,
    check: checkBenchPacket,
    pin: PIN_STREAM,
  };
  const { variants, bytesPerPacket } = gateShape(shape);

  // measure gate: the measured bits equal the written bits for this packet
  const measure = new MeasureStream();
  serializeBenchPacket(measure, packet);
  if (!measure.ok || measure.bytesProcessed() !== bytesPerPacket) {
    gateFail('stream', 'measure bytes', String(bytesPerPacket), String(measure.bytesProcessed()));
  }

  return { packet, decoded, variants, bytesPerPacket, measure };
}

function benchStream({ packet, decoded, variants, bytesPerPacket, measure }) {
  const buffer = new Uint8Array(256);
  const writer = new WriteStream(buffer);
  const reader = new ReadStream(variants[0]);

  let bestWrite = Infinity;
  let bestRead = Infinity;
  let bestMeasure = Infinity;

  for (let trial = 0; trial < NUM_TRIALS; trial++) {
    initBenchPacket(packet);
    lcgSeed();

    let start = now();
    for (let i = 0; i < STREAM_NUM_PACKETS; i++) {
      varyBenchPacket(packet);
      writer.reset(buffer);
      if (!serializeBenchPacket(writer, packet)) {
        process.exit(1);
      }
      writer.flush();
      sink = (sink + writer.bytesProcessed()) | 0;
    }
    let elapsed = now() - start;
    if (elapsed < bestWrite) {
      bestWrite = elapsed;
    }

    start = now();
    for (let i = 0; i < STREAM_NUM_PACKETS; i++) {
      reader.reset(variants[i & (NUM_VARIANTS - 1)]);
      if (!serializeBenchPacket(reader, decoded)) {
        process.exit(1);
      }
      sink = (sink + decoded.b.value) | 0;
    }
    elapsed = now() - start;
    if (elapsed < bestRead) {
      bestRead = elapsed;
    }

    // measure prices the packet without touching memory; that it is nearly
    // free is the property worth tracking. The vary call stays so the loop
    // is the loop the other family benches time.
    start = now();
    for (let i = 0; i < STREAM_NUM_PACKETS; i++) {
      varyBenchPacket(packet);
      measure.reset();
      if (!serializeBenchPacket(measure, packet)) {
        process.exit(1);
      }
      sink = (sink + measure.bitsProcessed()) | 0;
    }
    elapsed = now() - start;
    if (elapsed < bestMeasure) {
      bestMeasure = elapsed;
    }
  }

  const totalMB = (bytesPerPacket * STREAM_NUM_PACKETS) / (1024 * 1024);
  const packets = STREAM_NUM_PACKETS / 1000000;

  report('stream', 'write', 'MB/s', totalMB / bestWrite);
  report('stream', 'write', 'Mpackets/s', packets / bestWrite);
  report('stream', 'read', 'MB/s', totalMB / bestRead);
  report('stream', 'read', 'Mpackets/s', packets / bestRead);
  report('stream', 'measure', 'Mpackets/s', packets / bestMeasure);
  print(`stream write:     ${(totalMB / bestWrite).toFixed(1).padStart(8)} MB/s  (${(packets / bestWrite).toFixed(1)} M packets/s)\n`);
  print(`stream read:      ${(totalMB / bestRead).toFixed(1).padStart(8)} MB/s  (${(packets / bestRead).toFixed(1)} M packets/s)\n`);
  print(`stream measure:   ${(packets / bestMeasure).toFixed(1).padStart(19)} M packets/s\n`);
}

/* --------------------------------------------------------------------------
   packet shapes: write and read, M packets/s
   -------------------------------------------------------------------------- */

function zeroInit() {}

function gatePacketShape(row, make, init, vary, serialize, check, pin) {
  const packet = make();
  const decoded = make();
  const { variants } = gateShape({ row, packet, decoded, init, vary, serialize, check, pin });
  return { packet, decoded, variants };
}

function benchShape(row, label, { packet, decoded, variants }, init, vary, serialize, sinkOf) {
  const buffer = new Uint8Array(256);
  const writer = new WriteStream(buffer);
  const reader = new ReadStream(variants[0]);

  let bestWrite = Infinity;
  let bestRead = Infinity;

  for (let trial = 0; trial < NUM_TRIALS; trial++) {
    init(packet);
    lcgSeed();

    let start = now();
    for (let i = 0; i < STREAM_NUM_PACKETS; i++) {
      vary(packet);
      writer.reset(buffer);
      if (!serialize(writer, packet)) {
        process.exit(1);
      }
      writer.flush();
      sink = (sink + writer.bytesProcessed()) | 0;
    }
    let elapsed = now() - start;
    if (elapsed < bestWrite) {
      bestWrite = elapsed;
    }

    start = now();
    for (let i = 0; i < STREAM_NUM_PACKETS; i++) {
      reader.reset(variants[i & (NUM_VARIANTS - 1)]);
      if (!serialize(reader, decoded)) {
        process.exit(1);
      }
      sink = (sink + sinkOf(decoded)) | 0;
    }
    elapsed = now() - start;
    if (elapsed < bestRead) {
      bestRead = elapsed;
    }
  }

  const packets = STREAM_NUM_PACKETS / 1000000;
  report(row, 'write', 'Mpackets/s', packets / bestWrite);
  report(row, 'read', 'Mpackets/s', packets / bestRead);
  print(`${label}  write: ${(packets / bestWrite).toFixed(1).padStart(6)} M packets/s   read: ${(packets / bestRead).toFixed(1).padStart(6)} M packets/s\n`);
}

/* ------------------------------------------------------------------------- */

// every row's golden gate runs before any row is timed: a bench that fails
// its goldens reports nothing at all
const gatedBitpacker = gateBitpacker();
const gatedStream = gateStream();
const gatedInt = gatePacketShape('int_packet', makeIntFields, zeroInit, varyIntFields, serializeIntFields, checkIntFields, PIN_INT);
const gatedBits = gatePacketShape('bits_packet', makeBitsFields, zeroInit, varyBitsFields, serializeBitsFields, checkBitsFields, PIN_BITS);
const gatedGen = gatePacketShape('mixed_packet', makeGenFields, zeroInit, varyGenFields, serializeGenFields, checkGenFields, PIN_GEN);

print('\n[serialize.js benchmark]\n\n');

benchBitpacker(gatedBitpacker);

benchStream(gatedStream);

print('\n');

benchShape('int_packet', 'int packet   (runtime):     ', gatedInt, zeroInit, varyIntFields, serializeIntFields, (d) => d.f0.value);
benchShape('bits_packet', 'bits packet  (runtime):     ', gatedBits, zeroInit, varyBitsFields, serializeBitsFields, (d) => d.b7.value);
benchShape('mixed_packet', 'mixed packet (runtime):     ', gatedGen, zeroInit, varyGenFields, serializeGenFields, (d) => d.sequence.value);

print('\n(the C++ bench also prints a compile time row per shape. that surface is\n');
print(' C++ template machinery with no counterpart here, the same omission the\n');
print(' C bench makes.)\n');
print('\n');

if (CSV) {
  let csv = 'row,op,units,value\n';
  for (const r of results) {
    csv += `${r.row},${r.op},${r.units},${r.value.toFixed(4)}\n`;
  }
  process.stdout.write(csv);
}

globalThis.__serializeBenchSink = sink; // the g_sink escape: the work is observed
