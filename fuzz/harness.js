// The fuzz harness: the two passes of the reference's fuzz.cpp
// (mas-bandwidth/serialize), driven by Jazzer.js, a coverage-guided
// in-process libFuzzer for Node. read.fuzz.js and roundtrip.fuzz.js are the
// two targets; both share the input layout and the op table defined here.
//
// Input layout, exactly the reference's: the first 32 bytes are an op
// program -- each byte selects one of 16 cases (low nibble) and a parameter
// in [0,15] (high nibble) -- and the remaining 1..4096 bytes are the hostile
// bitstream for the read pass and the value pool for the round trip.
//
// 1. Hostile read (fuzzRead). ReadStream is the trust boundary: arbitrary
//    bytes go through every read primitive, and every read either returns
//    true with a value inside its declared contract, or returns false with
//    the stream's latched error drawn from the standard's closed list of
//    refusal reasons, the scalar destination left unmodified, and every
//    later operation an echo of that first refusal. Hostile input never
//    throws: any exception escapes to Jazzer and is a finding. The same
//    bytes then run again as a view over a larger buffer whose tail is
//    hostile, and every result must be identical -- the reader prices its
//    windows inside the view it was given (the serialize.c stance, this
//    port's read-side buffer contract), the JS form of the reference's
//    second pass through an exact allocation.
//
// 2. Differential round trip (fuzzRoundTrip). Values generated from the
//    pool are written with WriteStream, measured with MeasureStream, and
//    read back with ReadStream; any write/read asymmetry is a finding, and
//    so is a measure below the bits actually written. The read ends exactly
//    where the writer stopped, and one byte more is refused as
//    trailing_data.
//
// The library comes from ../src unless SERIALIZE_FUZZ_SABOTAGE names a
// planted defect: then a copy of src/ with that one defect patched in is
// made under fuzz/.sabotage/ and fuzzed instead -- the negative control,
// in the same needle-and-patch shape as test/conformance-controls.test.js.
// A needle that stops matching is a failure: update it, never delete the
// control.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Planted defects, by name. Each is an asymmetry a conforming port never
// has, and the round trip target must find it within the 60 second smoke.
const SABOTAGE = {
  // the int_relative writer emits the 9-bit tier (differences 24..280) one
  // too high; the reader is untouched, so the round trip reads back
  // current + 1 (or refuses the top of the tier as value_out_of_range)
  'int-relative-tier': {
    file: 'streams.js',
    needle: '((difference - 24) << 4), 13)',
    patch: '((difference - 23) << 4), 13)',
    count: 2, // the checked and the production write streams
  },
};

function plant(name) {
  const sabotage = SABOTAGE[name];
  if (sabotage === undefined) {
    throw new Error(`unknown SERIALIZE_FUZZ_SABOTAGE '${name}': one of ${Object.keys(SABOTAGE).join(', ')}`);
  }
  const root = join(HERE, '.sabotage', name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(HERE, '..', 'src'), root, { recursive: true });
  const path = join(root, sabotage.file);
  const source = readFileSync(path, 'utf8');
  const found = source.split(sabotage.needle).length - 1;
  if (found !== sabotage.count) {
    throw new Error(`sabotage '${name}': needle matched ${found} times, expected ${sabotage.count}`);
  }
  writeFileSync(path, source.replaceAll(sabotage.needle, sabotage.patch));
  return pathToFileURL(join(root, 'index.js')).href;
}

const SABOTAGE_NAME = process.env.SERIALIZE_FUZZ_SABOTAGE ?? '';
const library = SABOTAGE_NAME === ''
  ? await import('../src/index.js')
  : await import(plant(SABOTAGE_NAME));

const { WriteStream, ReadStream, MeasureStream } = library;

export const NUM_OPS = 32;
export const MAX_PAYLOAD = 4096;

/** The standard's closed list of refusal reasons, spelled exactly. */
const REASONS = new Set([
  'past_end', 'value_out_of_range', 'nonzero_padding', 'trailing_data',
  'non_finite_float', 'invalid_utf8', 'embedded_nul', 'non_canonical',
]);

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;
const UINT64_LIMIT = 2n ** 64n;
const UINT128_LIMIT = 2n ** 128n;
const RELATIVE_MAX = 2 ** 31 - 1;

// fixed point declarations, the reference's: Q16.16 over [-1000,+1000],
// Q48.16 over [-1e11,+1e11], and Q112.16 over [-2^60,+2^60] -- a raw range
// of 2^77, past 64 bits
const FIXED32_RAW = 1000 * 65536;
const FIXED64_BOUND = 100000000000n;
const FIXED64_RAW = FIXED64_BOUND * 65536n;
const WIDE_BOUND = 2n ** 60n;
const WIDE_RAW = WIDE_BOUND << 16n;

const UTF8 = new TextEncoder();
const SCRATCH = new DataView(new ArrayBuffer(8));
const SENTINEL = Symbol('unwritten');

/** A failed fuzz check: thrown, so Jazzer reports it as a finding. */
class FuzzCheckError extends Error {
  constructor(message) {
    super(`fuzz check failed: ${message}`);
    this.name = 'FuzzCheckError';
  }
}

function fuzzCheck(condition, message) {
  if (!condition) {
    throw new FuzzCheckError(message);
  }
}

function float32Bits(value) {
  SCRATCH.setFloat32(0, value, true);
  return SCRATCH.getUint32(0, true);
}

function float32FromBits(bits) {
  SCRATCH.setUint32(0, bits, true);
  return SCRATCH.getFloat32(0, true);
}

function float64Bits(value) {
  SCRATCH.setFloat64(0, value, true);
  return SCRATCH.getBigUint64(0, true);
}

function float64FromBits(bits) {
  SCRATCH.setBigUint64(0, bits, true);
  return SCRATCH.getFloat64(0, true);
}

/**
 * Hands out bytes from the fuzz input, wrapping around when exhausted, the
 * reference's ValuePool: every pass regenerates the identical sequence.
 */
class ValuePool {
  #data;
  #index;

  constructor(data) {
    this.#data = data;
    this.#index = 0;
  }

  nextByte() {
    if (this.#data.length === 0) {
      return 0;
    }
    if (this.#index >= this.#data.length) {
      this.#index = 0;
    }
    return this.#data[this.#index++];
  }

  nextUint32() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = ((value << 8) | this.nextByte()) >>> 0;
    }
    return value;
  }

  nextUint64() {
    return (BigInt(this.nextUint32()) << 32n) | BigInt(this.nextUint32());
  }

  nextUint128() {
    return (this.nextUint64() << 64n) | this.nextUint64();
  }
}

/**
 * Splits a fuzz input into the op program and the payload, or returns null
 * for an input outside the reference's size window.
 */
export function splitInput(data) {
  if (data.length <= NUM_OPS || data.length > NUM_OPS + MAX_PAYLOAD) {
    return null;
  }
  return {
    ops: Uint8Array.from(data.subarray(0, NUM_OPS)),
    payload: Uint8Array.from(data.subarray(NUM_OPS)),
  };
}

// ---------------------------------------------------------------------------
// pass 1: hostile read

/**
 * Tracks one read stream through a hostile program: every call's result
 * is checked against the error model, and the trace records what each call
 * returned so two runs over the same bytes can be compared exactly.
 */
class ReadCheck {
  constructor(stream) {
    this.stream = stream;
    this.failed = null; // the first latched reason, once a call fails
    this.trace = [];
  }

  /**
   * Checks one serialize call. ref holds SENTINEL before the call; contract
   * checks the value on success.
   */
  step(name, ok, ref, contract) {
    fuzzCheck(typeof ok === 'boolean', `${name} returned ${typeof ok}, not a boolean`);
    const error = this.stream.error;
    if (this.failed !== null) {
      // a failed stream: every later call is an echo of the first refusal
      fuzzCheck(!ok, `${name} succeeded on a stream that had already failed`);
      fuzzCheck(error === this.failed, `${name} changed the latched reason from ${this.failed} to ${error}`);
    } else if (ok) {
      fuzzCheck(error === null && this.stream.ok, `${name} succeeded with error ${error} latched`);
    } else {
      fuzzCheck(REASONS.has(error), `${name} refused with reason ${String(error)}, outside the closed list`);
      fuzzCheck(!this.stream.ok, `${name} refused but the stream reports ok`);
      this.failed = error;
    }
    if (ref !== null) {
      if (ok) {
        fuzzCheck(ref.value !== SENTINEL, `${name} succeeded without assigning its value`);
        contract(ref.value);
      } else {
        fuzzCheck(ref.value === SENTINEL, `${name} refused but modified its destination`);
      }
      this.trace.push(ok ? encodeValue(ref.value) : `!${error}`);
    } else {
      this.trace.push(ok ? 'ok' : `!${error}`);
    }
    return ok;
  }
}

function encodeValue(value) {
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 'n-0' : `n${value}`;
  }
  if (typeof value === 'bigint') {
    return `b${value}`;
  }
  if (value instanceof Uint8Array) {
    return `u${Array.prototype.join.call(value, ',')}`;
  }
  return `${typeof value}:${String(value)}`;
}

function ref() {
  return { value: SENTINEL };
}

function isIntIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isBigIn(value, min, max) {
  return typeof value === 'bigint' && value >= min && value <= max;
}

/**
 * Runs the op program as hostile reads over a stream. Returns the trace of
 * every call's outcome. A read never throws: any exception is a finding.
 */
export function fuzzRead(stream, ops) {
  const check = new ReadCheck(stream);
  for (let i = 0; i < ops.length; i++) {
    const select = ops[i] & 15;
    const param = ops[i] >> 4;

    switch (select) {
      case 0: {
        const bits = param + 1; // [1,16]
        const r = ref();
        check.step('bits', stream.serializeBits(r, bits), r, (v) => fuzzCheck(isIntIn(v, 0, 2 ** bits - 1), `bits(${bits}) read ${v}`));
        break;
      }

      case 1: {
        const bits = param + 17; // [17,32]
        const r = ref();
        check.step('bits', stream.serializeBits(r, bits), r, (v) => fuzzCheck(isIntIn(v, 0, 2 ** bits - 1), `bits(${bits}) read ${v}`));
        break;
      }

      case 2: {
        const r = ref();
        check.step('int', stream.serializeInt(r, -100, 100), r, (v) => fuzzCheck(isIntIn(v, -100, 100), `int read ${v}`));
        break;
      }

      case 3: {
        const r32 = ref();
        check.step('int32', stream.serializeInt(r32, INT32_MIN, INT32_MAX), r32, (v) => fuzzCheck(isIntIn(v, INT32_MIN, INT32_MAX), `int32 read ${v}`));

        const r64 = ref();
        check.step('int64', stream.serializeInt64(r64, INT64_MIN, INT64_MAX), r64, (v) => fuzzCheck(isBigIn(v, INT64_MIN, INT64_MAX), `int64 read ${v}`));

        // spans of varying width exercise bitsRequired64
        const bound = BigInt(param + 1) << 35n;
        const ranged = ref();
        check.step('int64 ranged', stream.serializeInt64(ranged, -bound, bound), ranged, (v) => fuzzCheck(isBigIn(v, -bound, bound), `int64 ranged read ${v}`));

        // fixed point: values read off hostile bytes decode inside the raw
        // bounds or fail the read
        const f32 = ref();
        check.step('fixed32', stream.serializeFixed(f32, 16, 16, -1000, 1000), f32, (v) => fuzzCheck(isIntIn(v, -FIXED32_RAW, FIXED32_RAW), `fixed32 read ${v}`));

        const f64 = ref();
        check.step('fixed64', stream.serializeFixed(f64, 48, 16, -FIXED64_BOUND, FIXED64_BOUND), f64, (v) => fuzzCheck(isBigIn(v, -FIXED64_RAW, FIXED64_RAW), `fixed64 read ${v}`));

        const wide = ref();
        check.step('fixed128', stream.serializeFixed(wide, 112, 16, -WIDE_BOUND, WIDE_BOUND), wide, (v) => fuzzCheck(isBigIn(v, -WIDE_RAW, WIDE_RAW), `fixed128 read ${v}`));

        // ranged 128 bit integers, the bound width varying by param so the
        // run walks every group structure: never clamp, never wrap
        const bound128 = 1n << BigInt(20 + param);
        const ranged128 = ref();
        check.step('int128 ranged', stream.serializeInt128(ranged128, -bound128, bound128), ranged128, (v) => fuzzCheck(isBigIn(v, -bound128, bound128), `int128 ranged read ${v}`));

        const full128 = ref();
        check.step('int128', stream.serializeInt128(full128, INT128_MIN, INT128_MAX), full128, (v) => fuzzCheck(isBigIn(v, INT128_MIN, INT128_MAX), `int128 read ${v}`));
        break;
      }

      case 4: {
        const r = ref();
        check.step('bool', stream.serializeBool(r), r, (v) => fuzzCheck(typeof v === 'boolean', `bool read ${typeof v}`));
        break;
      }

      case 5: {
        // finite values only: whatever the bytes, an accepted float is a
        // finite float32
        const r = ref();
        check.step('float', stream.serializeFloat(r), r, (v) => {
          fuzzCheck(typeof v === 'number' && Number.isFinite(v), `float read ${v}`);
          fuzzCheck(Object.is(Math.fround(v), v), `float read ${v}, not a float32`);
        });
        break;
      }

      case 6: {
        const r = ref();
        check.step('double', stream.serializeDouble(r), r, (v) => fuzzCheck(typeof v === 'number' && Number.isFinite(v), `double read ${v}`));
        break;
      }

      case 7: {
        const r = ref();
        check.step('compressed float', stream.serializeCompressedFloat(r, -10, 10, 0.01), r, (v) => {
          fuzzCheck(typeof v === 'number' && Number.isFinite(v), `compressed float read ${v}`);
          fuzzCheck(Object.is(Math.fround(v), v), `compressed float read ${v}, not a float32`);
          fuzzCheck(v >= -10.001 && v <= 10.001, `compressed float read ${v}, outside its declaration`);
        });
        break;
      }

      case 8: {
        const r64 = ref();
        check.step('uint64', stream.serializeUint64(r64), r64, (v) => fuzzCheck(isBigIn(v, 0n, UINT64_LIMIT - 1n), `uint64 read ${v}`));

        const r128 = ref();
        check.step('uint128', stream.serializeUint128(r128), r128, (v) => fuzzCheck(isBigIn(v, 0n, UINT128_LIMIT - 1n), `uint128 read ${v}`));

        const bits = param + 49; // [49,64]
        const wide = ref();
        check.step('bits64', stream.serializeBits64(wide, bits), wide, (v) => fuzzCheck(isBigIn(v, 0n, (1n << BigInt(bits)) - 1n), `bits64(${bits}) read ${v}`));
        break;
      }

      case 9: {
        // the caller-owned buffer's contents after a refusal are unspecified
        // (STANDARD.md, "Reader Obligations"), so only a success is traced
        const bytes = new Uint8Array(param * 16 + 1); // [1,241]
        const ok = stream.serializeBytes(bytes);
        check.step('bytes', ok, null, null);
        if (ok) {
          check.trace.push(encodeValue(bytes));
        }
        break;
      }

      case 10: {
        const r = ref();
        check.step('string', stream.serializeString(r, 256), r, (v) => {
          fuzzCheck(typeof v === 'string', `string read ${typeof v}`);
          fuzzCheck(!v.includes('\0'), 'string read holds a NUL');
          fuzzCheck(v.isWellFormed(), 'string read is not well-formed');
          fuzzCheck(UTF8.encode(v).length < 256, 'string read is longer than its buffer');
        });
        break;
      }

      case 11: {
        // the end of the object: an accepted end leaves nothing in the stream
        const ok = check.step('end', stream.serializeEnd(), null, null);
        if (ok) {
          fuzzCheck(stream.bitsProcessed() % 8 === 0, `end accepted at bit ${stream.bitsProcessed()}`);
          const after = ref();
          fuzzCheck(stream.serializeBits(after, 1) === false, 'a read after an accepted end succeeded');
          fuzzCheck(stream.error === 'past_end', `a read after an accepted end refused as ${stream.error}`);
          check.trace.push('end');
        }
        return check.trace;
      }

      case 12: {
        check.step('align', stream.serializeAlign(), null, null);
        break;
      }

      case 13: {
        // int_relative's domain starts at 0: a negative previous is caller error
        const previous = param * 1000;
        const r = ref();
        check.step('int relative', stream.serializeIntRelative(previous, r), r, (v) => fuzzCheck(isIntIn(v, previous + 1, RELATIVE_MAX), `int relative after ${previous} read ${v}`));
        break;
      }

      case 14: {
        // ranges of varying width exercise bitsRequired
        const max = (param + 1) * 1000;
        const r = ref();
        check.step('int', stream.serializeInt(r, 0, max), r, (v) => fuzzCheck(isIntIn(v, 0, max), `int [0,${max}] read ${v}`));
        break;
      }

      case 15: {
        const r8 = ref();
        check.step('uint8', stream.serializeUint8(r8), r8, (v) => fuzzCheck(isIntIn(v, 0, 0xff), `uint8 read ${v}`));
        const r16 = ref();
        check.step('uint16', stream.serializeUint16(r16), r16, (v) => fuzzCheck(isIntIn(v, 0, 0xffff), `uint16 read ${v}`));
        const r32 = ref();
        check.step('uint32', stream.serializeUint32(r32), r32, (v) => fuzzCheck(isIntIn(v, 0, 0xffffffff), `uint32 read ${v}`));
        break;
      }
    }
  }
  return check.trace;
}

/**
 * The read target's body: the hostile bytes through an exact-length array,
 * then the same bytes as a view over a larger buffer whose tail is hostile.
 * The two traces must be identical, element for element.
 */
export function hostileRead(ops, payload) {
  const exact = fuzzRead(new ReadStream(payload), ops);

  const backing = new Uint8Array(payload.length + 16).fill(0xff);
  backing.set(payload);
  const view = backing.subarray(0, payload.length);
  const viewed = fuzzRead(new ReadStream(view), ops);

  fuzzCheck(exact.length === viewed.length, `the view traced ${viewed.length} calls, the exact array ${exact.length}`);
  for (let i = 0; i < exact.length; i++) {
    fuzzCheck(exact[i] === viewed[i], `call ${i}: the view read ${viewed[i]}, the exact array ${exact[i]}`);
  }
}

// ---------------------------------------------------------------------------
// pass 2: differential round trip

/**
 * Runs the op program over a write, measure or read stream. Every case
 * consumes the same pool bytes on every stream, so the read pass
 * regenerates the exact values the write pass produced. Every serialize
 * call must succeed: the values are in range and the data is our own.
 */
function fuzzRoundTrip(stream, ops, pool) {
  const reading = stream.isReading;

  // one ranged value: written from expected, read back and compared
  const value = (name, expected, call, same = Object.is) => {
    const r = { value: reading ? SENTINEL : expected };
    fuzzCheck(call(r) === true, `${name}: serialize ${String(expected)} failed with ${stream.error}`);
    if (reading) {
      fuzzCheck(same(r.value, expected), `${name}: wrote ${String(expected)}, read back ${String(r.value)}`);
    }
  };

  for (let i = 0; i < ops.length; i++) {
    const select = ops[i] & 15;
    const param = ops[i] >> 4;

    switch (select) {
      case 0:
      case 1: {
        const bits = select === 0 ? param + 1 : param + 17; // [1,32]
        const expected = bits === 32 ? pool.nextUint32() : pool.nextUint32() % 2 ** bits;
        value(`bits(${bits})`, expected, (r) => stream.serializeBits(r, bits));
        break;
      }

      case 2: {
        const expected = -100 + (pool.nextUint32() % 201);
        value('int [-100,100]', expected, (r) => stream.serializeInt(r, -100, 100));
        break;
      }

      case 3: {
        value('int32', pool.nextUint32() | 0, (r) => stream.serializeInt(r, INT32_MIN, INT32_MAX));
        value('int64', BigInt.asIntN(64, pool.nextUint64()), (r) => stream.serializeInt64(r, INT64_MIN, INT64_MAX));

        const bound = BigInt(param + 1) << 35n;
        value('int64 ranged', -bound + (pool.nextUint64() % (2n * bound + 1n)), (r) => stream.serializeInt64(r, -bound, bound));

        // fixed point: raw values uniform inside the raw bounds round trip exactly
        value('fixed32', -FIXED32_RAW + (pool.nextUint32() % (2 * FIXED32_RAW + 1)), (r) => stream.serializeFixed(r, 16, 16, -1000, 1000));
        value('fixed64', -FIXED64_RAW + (pool.nextUint64() % (2n * FIXED64_RAW + 1n)), (r) => stream.serializeFixed(r, 48, 16, -FIXED64_BOUND, FIXED64_BOUND));
        value('fixed128', -WIDE_RAW + (pool.nextUint128() % (2n * WIDE_RAW + 1n)), (r) => stream.serializeFixed(r, 112, 16, -WIDE_BOUND, WIDE_BOUND));

        // ranged and full 128 bit integers, every group structure
        const bound128 = 1n << BigInt(20 + param);
        value('int128 ranged', -bound128 + (pool.nextUint128() % (2n * bound128 + 1n)), (r) => stream.serializeInt128(r, -bound128, bound128));
        value('int128', BigInt.asIntN(128, pool.nextUint128()), (r) => stream.serializeInt128(r, INT128_MIN, INT128_MAX));
        break;
      }

      case 4: {
        value('bool', (pool.nextByte() & 1) !== 0, (r) => stream.serializeBool(r));
        break;
      }

      case 5: {
        // arbitrary FINITE bit patterns, -0 and subnormals included, round
        // trip bit exact; a non-finite pattern has its exponent cleared,
        // keeping the sign and mantissa entropy as a subnormal
        const raw = pool.nextUint32();
        const bits = (raw & 0x7f800000) !== 0x7f800000 ? raw : (raw & 0x807fffff) >>> 0;
        value('float', float32FromBits(bits), (r) => stream.serializeFloat(r), (a, b) => typeof a === 'number' && float32Bits(a) === float32Bits(b));
        break;
      }

      case 6: {
        const raw = pool.nextUint64();
        const bits = (raw & 0x7ff0000000000000n) !== 0x7ff0000000000000n ? raw : raw & 0x800fffffffffffffn;
        value('double', float64FromBits(bits), (r) => stream.serializeDouble(r), (a, b) => typeof a === 'number' && float64Bits(a) === float64Bits(b));
        break;
      }

      case 7: {
        // finite input only (non-finite writes are non-conforming); out of
        // range values clamp on write, in range values come back within
        // the resolution
        const raw = pool.nextUint32();
        const bits = (raw & 0x7f800000) !== 0x7f800000 ? raw : (raw & 0x807fffff) >>> 0;
        const expected = float32FromBits(bits);
        value('compressed float', expected, (r) => stream.serializeCompressedFloat(r, -10, 10, 0.01), (read, written) => {
          if (typeof read !== 'number' || !(read >= -10.001 && read <= 10.001)) {
            return false;
          }
          return !(written >= -10 && written <= 10) || Math.abs(read - written) <= 0.011;
        });
        break;
      }

      case 8: {
        value('uint64', pool.nextUint64(), (r) => stream.serializeUint64(r));
        value('uint128', pool.nextUint128(), (r) => stream.serializeUint128(r));
        const bits = param + 49; // [49,64]
        value(`bits64(${bits})`, pool.nextUint64() & ((1n << BigInt(bits)) - 1n), (r) => stream.serializeBits64(r, bits));
        break;
      }

      case 9: {
        const length = param * 16 + 1; // [1,241]
        const expected = new Uint8Array(length);
        for (let j = 0; j < length; j++) {
          expected[j] = pool.nextByte();
        }
        const data = reading ? new Uint8Array(length) : expected;
        fuzzCheck(stream.serializeBytes(data) === true, `bytes(${length}) failed with ${stream.error}`);
        if (reading) {
          for (let j = 0; j < length; j++) {
            fuzzCheck(data[j] === expected[j], `bytes(${length}): byte ${j} wrote ${expected[j]}, read back ${data[j]}`);
          }
        }
        break;
      }

      case 10: {
        // ASCII without NUL: the writer is handed text a reader accepts;
        // arbitrary payload bytes reach the read path in the read target
        const length = pool.nextByte() % 31;
        let expected = '';
        for (let j = 0; j < length; j++) {
          const c = pool.nextByte() & 0x7f;
          expected += String.fromCharCode(c !== 0 ? c : 0x20);
        }
        value('string', expected, (r) => stream.serializeString(r, 32));
        break;
      }

      case 11: {
        // real text: random Unicode scalar values, every UTF-8 sequence
        // length and every plane, back code point for code point. NUL and
        // the surrogate block are not scalar text and are replaced
        const characters = pool.nextByte() % 8;
        let expected = '';
        for (let j = 0; j < characters; j++) {
          let code = pool.nextUint32() % 0x110000;
          if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
            code = 0x7881; // 碁
          }
          expected += String.fromCodePoint(code);
        }
        value('unicode string', expected, (r) => stream.serializeString(r, 40));
        break;
      }

      case 12: {
        fuzzCheck(stream.serializeAlign() === true, `align failed with ${stream.error}`);
        break;
      }

      case 13: {
        const previous = param * 1000;
        const expected = previous + 1 + (pool.nextUint32() % 1000000); // strictly greater than previous
        value(`int relative after ${previous}`, expected, (r) => stream.serializeIntRelative(previous, r));
        break;
      }

      case 14: {
        const max = (param + 1) * 1000;
        value(`int [0,${max}]`, pool.nextUint32() % (max + 1), (r) => stream.serializeInt(r, 0, max));
        break;
      }

      case 15: {
        value('uint8', pool.nextByte(), (r) => stream.serializeUint8(r));
        value('uint16', pool.nextUint32() & 0xffff, (r) => stream.serializeUint16(r));
        value('uint32', pool.nextUint32(), (r) => stream.serializeUint32(r));
        break;
      }
    }
  }
}

// worst case is ~260 bytes per op (a 241 byte serialize_bytes plus the
// align), so 32 ops fit comfortably; a multiple of 8, as the writer requires
const WRITE_BUFFER_SIZE = 16 * 1024;

/**
 * The round trip target's body: write, measure, read back, end exactly,
 * and refuse one byte more as trailing data.
 */
export function roundTrip(ops, payload) {
  const buffer = new Uint8Array(WRITE_BUFFER_SIZE);
  const write = new WriteStream(buffer);
  fuzzRoundTrip(write, ops, new ValuePool(payload));
  fuzzCheck(write.serializeEnd() === true, `write end failed with ${write.error}`);
  write.flush();
  const written = write.bytesProcessed();

  const measure = new MeasureStream();
  fuzzRoundTrip(measure, ops, new ValuePool(payload));
  fuzzCheck(measure.bitsProcessed() >= write.bitsProcessed(), `measure ${measure.bitsProcessed()} bits under the ${write.bitsProcessed()} written`);

  const read = new ReadStream(buffer.subarray(0, written));
  fuzzRoundTrip(read, ops, new ValuePool(payload));
  fuzzCheck(read.bitsProcessed() === write.bitsProcessed(), `read consumed ${read.bitsProcessed()} bits, the writer wrote ${write.bitsProcessed()}`);
  fuzzCheck(read.serializeEnd() === true, `read end refused with ${read.error}`);

  // one byte more than the writer reported is trailing data, refused at the end
  const longer = new ReadStream(buffer.subarray(0, written + 1));
  fuzzRoundTrip(longer, ops, new ValuePool(payload));
  fuzzCheck(longer.serializeEnd() === false, 'one byte past the writer was accepted at the end');
  fuzzCheck(longer.error === 'trailing_data', `one byte past the writer refused as ${longer.error}, not trailing_data`);
}
