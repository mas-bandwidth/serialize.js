// Streams: the serialize-method surface over the bitpacker.
//
// WriteStream, ReadStream and MeasureStream share one bool-returning
// serialize-method surface, so a message type writes ONE serialize function
// and it works for write, read and measure -- the family's unified serialize
// pattern (serialize.cs is the shape reference). The isWriting / isReading
// flags let that one function branch where direction matters.
//
// Refs: JavaScript has no ref or pointer parameters, so serialize methods
// take a holder object with a .value property -- the direct translation of
// the C# port's `ref` parameters. On write, .value is consumed; on read,
// .value is assigned on success and LEFT UNMODIFIED on failure; on measure
// it is ignored. Holders can be preallocated and reused: the streams never
// retain them.
//
// The error model (the family's checked-runtime shape): errors are VALUES.
// Every serialize method returns true on success. The first failure latches
// on the stream -- see SerializeError -- and every later serialize call
// returns false without touching the stream or the ref. Check every call, or
// serialize a whole object and check stream.ok once at the end. Like the Go
// port, checks run in every build on BOTH sides: JavaScript has no
// compile-out, so writes keep their checks (a write past the end of the
// buffer latches Overflow instead of throwing), and reads validate
// everything -- the wire is a trust boundary, and hostile input NEVER
// throws. Throws are reserved for caller misuse: an invalid bits count is a
// bug in the calling code, not data, and throws RangeError on every stream
// in every state.

import { BitWriter, BitReader } from './bitpacker.js';
import { bitsRequired, bitsRequired64, bitsRequired128 } from './bits.js';

const BITS_RANGE_MESSAGE = 'bits must be an integer in [1,32]';
const BITS64_RANGE_MESSAGE = 'bits must be an integer in [1,64]';
const INT32_RANGE_MESSAGE = 'min and max must be integers in [-2^31,2^31-1]';
const INT64_RANGE_MESSAGE = 'min and max must be BigInts in [-2^63,2^63-1]';
const INT128_RANGE_MESSAGE = 'min and max must be BigInts in [-2^127,2^127-1]';
const MIN_MAX_MESSAGE = 'min must not exceed max';
const VALUE_TYPE_MESSAGE = 'value must be a number';
const BIGINT_VALUE_MESSAGE = 'value must be a BigInt';
const BYTES_TYPE_MESSAGE = 'data must be a Uint8Array';
const STRING_VALUE_MESSAGE = 'value must be a string';
const BUFFER_SIZE_MESSAGE = 'bufferSize must be an integer in [2,2^31-1]';

const FLOAT_PARAMS_MESSAGE = 'min must be less than max and resolution must be positive, as float32 values';
const FLOAT_DECLARATION_MESSAGE = 'compressed float declaration is not finite in float32: delta and delta / resolution must not overflow';

const PREVIOUS_RANGE_MESSAGE = 'previous must be an integer in [0,2^32-1]';
const FIXED_FORMAT_MESSAGE = 'integerBits must be an integer of at least 1, fractionBits an integer of at least 0, and their sum must be a storage width of 8, 16, 32, 64 or 128';
const FIXED_NARROW_BOUNDS_MESSAGE = 'min and max must be integer Numbers in whole units for storage of 32 bits or fewer';
const FIXED_CAPACITY_MESSAGE = 'min and max in whole units must fit the Q format';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;
const MASK32 = 0xffffffffn;

// Scratch for float <-> bits reinterpretation: 8 bytes, reused by every
// stream in this module. JavaScript is single threaded per realm and the
// scratch is always consumed in the same call that fills it, so sharing is
// safe; each worker thread gets its own module instance. Endianness is
// explicit (little endian) on every access, so the scratch behaves the same
// on any host.
const FLOAT_SCRATCH = new DataView(new ArrayBuffer(8));

// The string wire codecs, shared module-wide (stateless between calls).
//
// The encoder is WHATWG UTF-8: a lone surrogate in the input -- ill-formed
// UTF-16, the writer's contract violated -- encodes as U+FFFD, the writer
// contract surfacing JavaScript's way, exactly as Go's range-over-string
// yields U+FFFD for invalid bytes. What reaches the wire is always
// well-formed UTF-8.
//
// The decoder is the read-side refusal's platform crystal: fatal true makes
// every malformed payload throw (caught and latched as InvalidString, never
// escaping to the caller), and ignoreBOM true keeps a leading U+FEFF as the
// code point the writer serialized -- the wire is not a file, and silently
// dropping a code point would break round-trip fidelity. NUL is well-formed
// UTF-8, so the interior-NUL refusal is an explicit scan, its own rule.
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The first error latched on a stream. A healthy stream's error is
 * SerializeError.None (null, so `if (stream.error)` works too); after the
 * first failure the stream holds the code of that failure and every later
 * serialize call returns false without changing it. reset() clears it.
 */
export const SerializeError = Object.freeze({
  /** No error: the stream is healthy. */
  None: null,

  /**
   * On read, a read would go past the end of the data: the packet is
   * truncated or maliciously crafted. On write, a write would go past the
   * end of the buffer: the message does not fit.
   */
  Overflow: 'overflow',

  /**
   * A value outside the range it is serialized with. On read, the decoded
   * value lies outside [min,max]: a value smuggled into the bit headroom of
   * the range encoding, which conforming readers must refuse (STANDARD.md).
   * On write and measure, the value passed in is outside [min,max]: the
   * checked runtime refuses instead of writing a value the range cannot
   * carry.
   */
  ValueOutOfRange: 'value_out_of_range',

  /**
   * The zero pad bits read by an align are not zero. This typically means
   * the read and write serialize functions don't match.
   */
  Align: 'align',

  /**
   * A string payload is malformed. On read: bytes that are not valid UTF-8,
   * or an interior NUL among the transmitted bytes -- the wire length and
   * the C-string length a downstream consumer perceives would disagree, the
   * two-lengths smuggling primitive -- and, on the wide-string path, an
   * unpaired, misordered or dangling surrogate or an interior NUL group.
   * Readers refuse malformed string content in every build mode
   * (STANDARD.md, adopted 2026-08-15). On write and measure: a wide string
   * holding a lone surrogate -- ill-formed UTF-16, the writer's contract
   * violated -- which the wide path cannot launder the way the narrow
   * encoder's U+FFFD replacement does, so the checked runtime latches it,
   * its always-on form of the family's debug assert.
   */
  InvalidString: 'invalid_string',
});

/**
 * Validates the shared caller contract of serializeBits: bits must be an
 * integer in [1,32]. Violating it is caller misuse and throws on every
 * stream in every state, even after an error has latched.
 */
function validateBits(bits) {
  if ((bits | 0) !== bits || bits < 1 || bits > 32) {
    throw new RangeError(BITS_RANGE_MESSAGE);
  }
}

/**
 * Validates the shared caller contract of serializeInt: min and max must be
 * integers representable in int32, with min <= max. The range is part of the
 * message format, never data, so violating it is caller misuse and throws on
 * every stream in every state.
 */
function validateIntRange(min, max) {
  if ((min | 0) !== min || (max | 0) !== max) {
    throw new RangeError(INT32_RANGE_MESSAGE);
  }
  if (min > max) {
    throw new RangeError(MIN_MAX_MESSAGE);
  }
}

/**
 * Validates the shared caller contract of serializeString: bufferSize is
 * part of the message format -- it prices the length field, so both sides
 * must agree on it -- and must be an integer in [2,2^31-1]: at least one
 * payload byte's worth of range plus the empty string, within the int32
 * domain the length is serialized in. Violating it is caller misuse and
 * throws on every stream in every state.
 */
function validateBufferSize(bufferSize) {
  if (!Number.isInteger(bufferSize) || bufferSize < 2 || bufferSize > 0x7fffffff) {
    throw new RangeError(BUFFER_SIZE_MESSAGE);
  }
}

/**
 * Validates the shared caller contract of serializeIntRelative: previous
 * lives in the unsigned 32-bit domain, the operation's pinned semantics
 * (STANDARD.md "int_relative": positive only, up to the uint32 maximum
 * only). It is the caller's own sequence state, never wire data, so
 * violating it is caller misuse and throws on every stream in every state.
 */
function validatePrevious(previous) {
  if (!Number.isInteger(previous) || previous < 0 || previous > 0xffffffff) {
    throw new RangeError(PREVIOUS_RANGE_MESSAGE);
  }
}

// The int_relative flag ladder (STANDARD.md "int_relative"), tiers 2..6:
// after tier's index worth of zero flags and a one flag, the difference is
// serialized as serialize_int(d, base, base + range) -- an offset below base
// in the tier's payload width. Tier 1 (a difference of exactly 1) carries no
// payload and tier 7 (six zero flags) carries current itself in 32 raw bits,
// so neither appears in the tables. Indexed by the number of zero flags.
const RELATIVE_TIER_BITS = [0, 3, 5, 9, 13, 17];
const RELATIVE_TIER_BASE = [1, 2, 7, 24, 281, 4378];
const RELATIVE_TIER_RANGE = [0, 4, 16, 256, 4096, 65536];

/**
 * Validates the shared caller contract of serializeBits64: bits must be an
 * integer in [1,64]. Violating it is caller misuse and throws on every
 * stream in every state, even after an error has latched.
 */
function validateBits64(bits) {
  if ((bits | 0) !== bits || bits < 1 || bits > 64) {
    throw new RangeError(BITS64_RANGE_MESSAGE);
  }
}

/**
 * Validates the shared caller contract of serializeInt64: min and max must
 * be BigInts representable in int64, with min <= max. Caller misuse throws
 * on every stream in every state.
 */
function validateInt64Range(min, max) {
  if (
    typeof min !== 'bigint' || min < INT64_MIN || min > INT64_MAX ||
    typeof max !== 'bigint' || max < INT64_MIN || max > INT64_MAX
  ) {
    throw new RangeError(INT64_RANGE_MESSAGE);
  }
  if (min > max) {
    throw new RangeError(MIN_MAX_MESSAGE);
  }
}

/**
 * Validates the shared caller contract of serializeInt128: min and max must
 * be BigInts representable in int128, with min <= max. Caller misuse throws
 * on every stream in every state.
 */
function validateInt128Range(min, max) {
  if (
    typeof min !== 'bigint' || min < INT128_MIN || min > INT128_MAX ||
    typeof max !== 'bigint' || max < INT128_MIN || max > INT128_MAX
  ) {
    throw new RangeError(INT128_RANGE_MESSAGE);
  }
  if (min > max) {
    throw new RangeError(MIN_MAX_MESSAGE);
  }
}

/**
 * Returns the 32 bits of the IEEE-754 single-precision representation of a
 * number, as a uint32: the write half of serializeFloat's bit transparency.
 *
 * Non-NaN values go through the hardware conversion (DataView.setFloat32,
 * exactly Math.fround's rounding -- the JS translation of the float
 * parameter type of the other ports, which converts at the call site).
 * NaN takes a SOFTWARE path: the hardware double->float32 conversion sets
 * the quiet bit, so a signaling NaN read off the wire would re-encode with
 * different bytes. Narrowing the payload by hand -- sign kept, the top 23
 * mantissa bits kept, the quiet bit NOT forced -- keeps the round trip
 * byte-exact for every NaN pattern serializeFloat's read half can produce
 * (STANDARD.md, "Bit transparency -- both directions"). A NaN whose payload
 * lives entirely in the low 29 mantissa bits would narrow to all-zero
 * mantissa -- the bit pattern of infinity -- so the quiet bit is forced for
 * exactly that case, matching what the hardware conversion produces there.
 */
function float32BitsFromNumber(value) {
  if (!Number.isNaN(value)) {
    FLOAT_SCRATCH.setFloat32(0, value, true);
    return FLOAT_SCRATCH.getUint32(0, true);
  }
  FLOAT_SCRATCH.setFloat64(0, value, true);
  const bits64 = FLOAT_SCRATCH.getBigUint64(0, true);
  const sign = Number(bits64 >> 63n) << 31;
  let mantissa = Number((bits64 >> 29n) & 0x7fffffn);
  if (mantissa === 0) {
    mantissa = 0x400000; // payload entirely in the low 29 bits: never infinity
  }
  return (sign | 0x7f800000 | mantissa) >>> 0;
}

/**
 * Returns the number whose IEEE-754 single-precision representation is the
 * given 32 bits: the read half of serializeFloat's bit transparency.
 *
 * Non-NaN patterns go through the hardware conversion (DataView.getFloat32,
 * exact for every value: float32 is a subset of float64). NaN patterns are
 * widened in SOFTWARE -- sign kept, the 23 mantissa bits shifted into the
 * top of the float64 mantissa, the quiet bit NOT forced -- because the
 * hardware float32->float64 conversion quiets a signaling NaN, and the
 * reader must reproduce the transmitted pattern exactly (STANDARD.md). The
 * payload rides the float64 bits of the returned number, which V8 carries
 * verbatim; an engine that canonicalizes NaN cannot preserve it, which is an
 * engine limitation, not reader latitude taken by this library.
 */
function numberFromFloat32Bits(bits) {
  if ((bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0) {
    const sign = BigInt(bits >>> 31) << 63n;
    const mantissa = BigInt(bits & 0x007fffff) << 29n;
    FLOAT_SCRATCH.setBigUint64(0, sign | 0x7ff0000000000000n | mantissa, true);
    return FLOAT_SCRATCH.getFloat64(0, true);
  }
  FLOAT_SCRATCH.setUint32(0, bits, true);
  return FLOAT_SCRATCH.getFloat32(0, true);
}

// The quantization parameters shared by the write, read and measure
// implementations of serializeCompressedFloat, computed into a reused
// module-level holder (filled and consumed within a single call, no user
// code in between, so sharing is safe and allocation-free).
const floatParams = { min: 0, delta: 0, maxIntegerValue: 0, bits: 0 };

/**
 * Validates a compressed float declaration and computes its quantization
 * parameters: delta = max - min, values = delta / res clamped to
 * [1, 4294967040] (the largest float32 below 2^32),
 * maxIntegerValue = ceil(values), bits = bitsRequired(0, maxIntegerValue).
 * Every step is float32 (Math.fround), including the parameters themselves:
 * min, max and resolution are float parameters in the other ports, so they
 * round to float32 at this boundary.
 *
 * The declaration is part of the message format, never data, so violating
 * it is caller misuse and throws on every stream in every state: min must be
 * less than max and resolution positive (the !(<) forms also reject NaN),
 * and a declaration whose delta or values overflows float32 to infinity is
 * non-conforming (STANDARD.md, adopted 2026-08-15) -- the checked runtime
 * throws where the debug-build family asserts.
 */
function compressedFloatParams(min, max, resolution) {
  if (typeof min !== 'number' || typeof max !== 'number' || typeof resolution !== 'number') {
    throw new TypeError(FLOAT_PARAMS_MESSAGE);
  }
  min = Math.fround(min);
  max = Math.fround(max);
  resolution = Math.fround(resolution);
  if (!(min < max) || !(resolution > 0)) {
    throw new RangeError(FLOAT_PARAMS_MESSAGE);
  }
  const delta = Math.fround(max - min);
  let values = Math.fround(delta / resolution);
  // finite min < max cannot produce NaN, only an infinite overflow
  if (!Number.isFinite(delta) || !Number.isFinite(values)) {
    throw new RangeError(FLOAT_DECLARATION_MESSAGE);
  }
  if (!(values >= 1.0)) {
    values = 1.0;
  } else if (values > 4294967040.0) { // largest float32 below 2^32
    values = 4294967040.0;
  }
  const maxIntegerValue = Math.ceil(values);
  floatParams.min = min;
  floatParams.delta = delta;
  floatParams.maxIntegerValue = maxIntegerValue;
  floatParams.bits = bitsRequired(0, maxIntegerValue);
  return floatParams;
}

// The wire parameters shared by the write, read and measure implementations
// of serializeFixed, computed into a reused module-level holder (filled and
// consumed within a single call, no user code in between, so sharing is safe
// and allocation-free on the narrow lane). wide selects the value domain:
// Number lanes for storage of 32 bits or fewer, BigInt for 64 and 128 -- the
// house BigInt-at-the-edges rule.
const fixedParams = { wide: false, bits: 0, rawMin: 0, rawRange: 0, rawMinBig: 0n, rawRangeBig: 0n };

/**
 * Validates a fixed point declaration and computes its wire parameters --
 * the JS translation of serialize.h's serialize_fixed_internal static
 * asserts and compile-time constants. The declaration is part of the
 * message format, never data, so violating it is caller misuse and throws
 * on every stream in every state:
 *
 * - integerBits >= 1 (the sign bit counts), fractionBits >= 0, and their
 *   sum -- the storage width -- must be 8, 16, 32, 64 or 128, exactly the
 *   integer storage widths of the family.
 * - min and max are bounds in WHOLE units: integer Numbers for storage of
 *   32 bits or fewer, BigInts in the int64 domain for 64 and 128 bit
 *   storage (the int64_t template parameter domain of the C++ reference),
 *   with min <= max.
 * - The bounds must fit the Q format's whole-unit capacity. The format is
 *   read as signed exactly when min < 0 -- [-2^(integerBits-1),
 *   2^(integerBits-1)-1] whole units -- and as unsigned otherwise --
 *   [0, 2^integerBits - 1] -- the JS translation of the C++ storage type's
 *   signedness, which never reaches the wire: for the same bounds signed
 *   and unsigned storage produce identical bytes.
 *
 * The wire parameters are the raw (scaled) bounds and the bit cost:
 * rawMin = min << fractionBits, rawRange = (max - min) << fractionBits,
 * bits = bit length of rawRange (zero for the degenerate min === max range,
 * on EVERY storage width -- STANDARD.md, adopted 2026-08-15).
 */
function fixedPointParams(integerBits, fractionBits, min, max) {
  if (
    (integerBits | 0) !== integerBits || integerBits < 1 ||
    (fractionBits | 0) !== fractionBits || fractionBits < 0
  ) {
    throw new RangeError(FIXED_FORMAT_MESSAGE);
  }
  const width = integerBits + fractionBits;
  if (width !== 8 && width !== 16 && width !== 32 && width !== 64 && width !== 128) {
    throw new RangeError(FIXED_FORMAT_MESSAGE);
  }
  if (width <= 32) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(FIXED_NARROW_BOUNDS_MESSAGE);
    }
    if (min > max) {
      throw new RangeError(MIN_MAX_MESSAGE);
    }
    if (min < 0) {
      // signed reading: the sign bit is one of the integer bits
      const half = 2 ** (integerBits - 1);
      if (min < -half || max > half - 1) {
        throw new RangeError(FIXED_CAPACITY_MESSAGE);
      }
    } else if (max > 2 ** integerBits - 1) {
      // unsigned reading: the full integer bits carry magnitude
      throw new RangeError(FIXED_CAPACITY_MESSAGE);
    }
    // exact in the Number domain: |raw| < 2^32 for storage of 32 bits or
    // fewer, so the scaling multiply never rounds
    const scale = 2 ** fractionBits;
    fixedParams.wide = false;
    fixedParams.rawMin = min * scale;
    fixedParams.rawRange = (max - min) * scale;
    fixedParams.bits = bitsRequired(0, fixedParams.rawRange);
    return fixedParams;
  }
  validateInt64Range(min, max);
  if (min < 0n) {
    // signed reading, int64-clamped exactly as the C++ compile-time domain:
    // 65 or more integer bits cover any int64 lower bound, 64 or more any
    // upper bound, and validateInt64Range has already bounded both
    if (integerBits < 65 && min < -(1n << BigInt(integerBits - 1))) {
      throw new RangeError(FIXED_CAPACITY_MESSAGE);
    }
    if (integerBits < 64 && max > (1n << BigInt(integerBits - 1)) - 1n) {
      throw new RangeError(FIXED_CAPACITY_MESSAGE);
    }
  } else if (integerBits < 64 && max > (1n << BigInt(integerBits)) - 1n) {
    throw new RangeError(FIXED_CAPACITY_MESSAGE);
  }
  const shift = BigInt(fractionBits);
  fixedParams.wide = true;
  fixedParams.rawMinBig = min << shift;
  fixedParams.rawRangeBig = (max - min) << shift;
  // the bit length of the raw range, exact at any width: the range never
  // wraps -- raw values fit the storage type -- so bitsRequired128 over
  // [0, rawRange] is the C++ BitsRequired64/128 result on both wide lanes
  fixedParams.bits = fixedParams.rawRangeBig === 0n
    ? 0
    : bitsRequired128(0n, fixedParams.rawRangeBig);
  return fixedParams;
}

/**
 * Writes bitpacked data to a buffer, wrapping BitWriter with the serialize
 * surface so unified serialize functions can write with it. A write that
 * would pass the end of the buffer latches SerializeError.Overflow and
 * returns false -- checks run in every build, the Go port's stance -- so a
 * message that does not fit surfaces as a value, not a throw.
 */
export class WriteStream {
  #writer;
  #error;

  /**
   * Creates a write stream that writes to the given buffer. The buffer size
   * must be a multiple of 8 bytes, because the bit writer stores 8-byte
   * words to memory.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  constructor(buffer) {
    this.#writer = new BitWriter(buffer);
    this.#error = SerializeError.None;
  }

  /**
   * Points the stream at a buffer and clears all write state including any
   * latched error, allowing a single stream to be reused without allocation.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  reset(buffer) {
    this.#writer.reset(buffer);
    this.#error = SerializeError.None;
  }

  /** True: this stream consumes ref values. */
  get isWriting() {
    return true;
  }

  /** False. */
  get isReading() {
    return false;
  }

  #fail(error) {
    if (this.#error === SerializeError.None) {
      this.#error = error;
    }
    return false;
  }

  /**
   * Writes bits that have already been validated to [1,32]: the shared tail
   * of every fixed-width write. A latched error and a write past the end of
   * the buffer are refused as values; the bit writer masks the value to the
   * bit count.
   */
  #writeBits(value, bits) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writer.writeBits(value, bits);
    return true;
  }

  /**
   * Writes an unsigned BigInt already reduced below 2^bits in the family's
   * wide group structure: a single group for 32 bits or fewer, otherwise
   * the low 32-bit dword first, then the remaining bits - 32 high bits
   * (STANDARD.md's serialize_bits splitting rule). bits must be in [1,64]
   * and the availability check must have already passed: the caller checks
   * the TOTAL bits up front, so a refused wide write puts NOTHING on the
   * wire -- never a dangling low dword.
   */
  #writeWide64(value, bits) {
    if (bits <= 32) {
      this.#writer.writeBits(Number(value), bits);
    } else {
      this.#writer.writeBits(Number(value & MASK32), 32);
      this.#writer.writeBits(Number(value >> 32n), bits - 32);
    }
  }

  /**
   * Writes the low order bits of ref.value, a BigInt, without padding to
   * the nearest byte: the 64-bit counterpart of serializeBits. bits must be
   * an integer in [1,64] and ref.value must be a BigInt (misuse throws);
   * bits of the value above the count are ignored, and a negative BigInt
   * wraps two's complement, as the uint64 parameter type of the other ports
   * converts at the call site. Values wider than 32 bits are written as the
   * low 32-bit dword first, then the high remainder. Returns false and
   * latches Overflow if the write would pass the end of the buffer --
   * checked against the TOTAL width up front, so nothing is written on
   * refusal.
   * @param {{value: bigint}} ref holder of the value to write.
   * @param {number} bits width in [1,64].
   * @returns {boolean} true on success.
   */
  serializeBits64(ref, bits) {
    validateBits64(bits);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writeWide64(BigInt.asUintN(bits, value), bits);
    return true;
  }

  /**
   * Writes the low order bits of ref.value, without padding to the nearest
   * byte. bits must be an integer in [1,32] (misuse throws); bits of the
   * value above the count are ignored. Returns false and latches Overflow
   * if the write would pass the end of the buffer.
   * @param {{value: number}} ref holder of the value to write.
   * @param {number} bits width in [1,32].
   * @returns {boolean} true on success.
   */
  serializeBits(ref, bits) {
    validateBits(bits);
    return this.#writeBits(ref.value, bits);
  }

  /**
   * Writes a ranged integer -- the format's defining operation: ref.value,
   * an integer in [min,max], costs exactly bitsRequired(min,max) bits as
   * the offset from min, computed in the unsigned domain so ranges wider
   * than 2^31 are exact. min and max must be integers representable in
   * int32 with min <= max: the range is part of the message format, so
   * violating that is caller misuse and throws. A value outside [min,max]
   * -- including NaN and non-integers, which the int32 domain cannot carry
   * -- latches SerializeError.ValueOutOfRange and writes nothing: checks
   * run in every build, so the refusal is a value, not a throw. A
   * degenerate range where min === max costs ZERO bits: the value IS the
   * range and nothing is written.
   * @param {{value: number}} ref holder of the integer to write.
   * @param {number} min the minimum value, an int32.
   * @param {number} max the maximum value, an int32, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt(ref, min, max) {
    validateIntRange(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (!Number.isInteger(value) || value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    const bits = bitsRequired(min >>> 0, max >>> 0);
    if (bits === 0) {
      return true; // degenerate range: the value IS the range, nothing to send
    }
    // subtract in the unsigned domain: the range may be wider than 2^31
    return this.#writeBits(((value >>> 0) - (min >>> 0)) >>> 0, bits);
  }

  /**
   * Writes a ranged 64-bit integer: ref.value, a BigInt in [min,max], costs
   * exactly bitsRequired64 bits as the offset from min, computed in the
   * unsigned 64-bit domain so ranges wider than 2^63 are exact. min and max
   * must be BigInts representable in int64 with min <= max: the range is
   * part of the message format, so violating that is caller misuse and
   * throws, as is a non-BigInt value. A value outside [min,max] latches
   * SerializeError.ValueOutOfRange and writes nothing. Where the offset
   * needs more than 32 bits it is written low 32-bit dword first, then the
   * high remainder -- serializeBits64's convention -- checked against the
   * TOTAL width up front, so a refused write puts nothing on the wire. A
   * degenerate range where min === max costs ZERO bits.
   * @param {{value: bigint}} ref holder of the integer to write.
   * @param {bigint} min the minimum value, an int64 BigInt.
   * @param {bigint} max the maximum value, an int64 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt64(ref, min, max) {
    validateInt64Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    const bits = bitsRequired64(BigInt.asUintN(64, min), BigInt.asUintN(64, max));
    if (bits === 0) {
      return true; // degenerate range: the value IS the range, nothing to send
    }
    if (bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    // subtract in the unsigned domain: the range may be wider than 2^63
    this.#writeWide64(BigInt.asUintN(64, value - min), bits);
    return true;
  }

  /**
   * Writes an unsigned BigInt already reduced below 2^bits in 32-bit groups,
   * least significant group first: full 32-bit groups from the bottom with
   * the final group carrying the remainder -- the shared group structure of
   * the 128-bit paths (STANDARD.md's splitting rule, extended to four
   * groups). bits must be in [1,128] and the availability check must have
   * already passed: the caller checks the TOTAL bits up front, so a refused
   * wide write puts NOTHING on the wire.
   */
  #writeGroups128(value, bits) {
    if (bits <= 64) {
      this.#writeWide64(value, bits);
    } else if (bits <= 96) {
      this.#writer.writeBits(Number(value & MASK32), 32);
      this.#writer.writeBits(Number((value >> 32n) & MASK32), 32);
      this.#writer.writeBits(Number(value >> 64n), bits - 64);
    } else {
      this.#writer.writeBits(Number(value & MASK32), 32);
      this.#writer.writeBits(Number((value >> 32n) & MASK32), 32);
      this.#writer.writeBits(Number((value >> 64n) & MASK32), 32);
      this.#writer.writeBits(Number(value >> 96n), bits - 96);
    }
  }

  /**
   * Writes a ranged 128-bit integer: ref.value, a BigInt in [min,max],
   * costs exactly bitsRequired128 bits as the offset from min, computed in
   * the unsigned 128-bit domain so ranges wider than 2^127 are exact. min
   * and max must be BigInts representable in int128 with min <= max:
   * violating that is caller misuse and throws, as is a non-BigInt value. A
   * value outside [min,max] latches SerializeError.ValueOutOfRange and
   * writes nothing. The offset goes out in 32-bit groups, least significant
   * first, up to four groups, checked against the TOTAL width up front.
   * Where the range fits 64 bits or fewer the wire is identical to
   * serializeInt64 over the same bounds (STANDARD.md): a field can be
   * widened from 64 to 128 bits without changing the wire. A degenerate
   * range where min === max costs ZERO bits.
   * @param {{value: bigint}} ref holder of the integer to write.
   * @param {bigint} min the minimum value, an int128 BigInt.
   * @param {bigint} max the maximum value, an int128 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt128(ref, min, max) {
    validateInt128Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    const bits = bitsRequired128(BigInt.asUintN(128, min), BigInt.asUintN(128, max));
    if (bits === 0) {
      return true; // degenerate range: the value IS the range, nothing to send
    }
    if (bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    // subtract in the unsigned domain: the range may be wider than 2^127
    this.#writeGroups128(BigInt.asUintN(128, value - min), bits);
    return true;
  }

  /**
   * Writes ref.value relative to previous with the int_relative flag ladder
   * (STANDARD.md "int_relative"): a difference of 1 -- the common case for
   * sequence numbers -- costs a single bit, small differences cost a few
   * flag bits plus a small ranged payload, and past the last tier six zero
   * flags are followed by current itself as 32 raw bits (the absolute form,
   * not the difference). The semantics are pinned: strictly increasing in
   * the unsigned 32-bit domain, NO wrapping (STANDARD.md, adopted
   * 2026-08-15) -- both values are integers in [0,2^32-1] and ref.value
   * must exceed previous. previous is the caller's own sequence state, part
   * of the contract on both sides, so an invalid previous is caller misuse
   * and throws; a ref.value that is not an integer in the uint32 domain
   * above previous latches SerializeError.ValueOutOfRange and writes
   * nothing -- the checked runtime's always-on form of the reference's
   * ordering assert. The tier is checked against the buffer as one total
   * width up front, so a refused write puts NOTHING on the wire.
   * @param {number} previous the previous value, an integer in [0,2^32-1].
   * @param {{value: number}} ref holder of the current value to write.
   * @returns {boolean} true on success.
   */
  serializeIntRelative(previous, ref) {
    validatePrevious(previous);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const current = ref.value;
    if (typeof current !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (!Number.isInteger(current) || current <= previous || current > 0xffffffff) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    // each tier is emitted as ONE fused group -- the zero flags in the low
    // bits, the one flag above them, the payload offset above that -- which
    // is bit-identical to the reference's flag-by-flag serialize_bool /
    // serialize_int sequence, because sequential writes pack from the least
    // significant bit upward
    const difference = current - previous;
    if (difference === 1) {
      return this.#writeBits(1, 1);
    }
    if (difference <= 6) {
      return this.#writeBits(0b10 | ((difference - 2) << 2), 5);
    }
    if (difference <= 23) {
      return this.#writeBits(0b100 | ((difference - 7) << 3), 8);
    }
    if (difference <= 280) {
      return this.#writeBits(0b1000 | ((difference - 24) << 4), 13);
    }
    if (difference <= 4377) {
      return this.#writeBits(0b10000 | ((difference - 281) << 5), 18);
    }
    if (difference <= 69914) {
      return this.#writeBits(0b100000 | ((difference - 4378) << 6), 23);
    }
    // the final tier: six zero flags, then current itself -- the ABSOLUTE
    // value, not the difference -- as 32 raw bits, 38 bits total, checked
    // up front so a refused write puts nothing on the wire
    if (this.#writer.bitsAvailable() < 38) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writer.writeBits(0, 6);
    this.#writer.writeBits(current, 32);
    return true;
  }

  /**
   * Writes a fixed point value (STANDARD.md "fixed"): ref.value is the RAW
   * scaled integer of a Q format -- the real value times 2^fractionBits --
   * held in storage of exactly integerBits + fractionBits bits (8, 16, 32,
   * 64 or 128, the sign bit counting toward integerBits), serialized as
   * the offset from min << fractionBits in exactly the bit length of the
   * raw range. For storage of 32 bits or fewer ref.value and the bounds
   * are Numbers; for 64 and 128 bit storage ref.value is a BigInt, min and
   * max are int64 BigInts, and the offset goes out in 32-bit groups, least
   * significant first, up to four groups -- byte identical to
   * serializeInt64 of the raw value over the raw bounds wherever the
   * storage is 64 bits or fewer (STANDARD.md): fixed point adds no wire
   * structure, only the compile-time scaling convention, and the round
   * trip is EXACT -- no quantization, unlike serializeCompressedFloat. The
   * declaration (integerBits, fractionBits, min, max in WHOLE units) is
   * part of the message format: violating it is caller misuse and throws,
   * as is a value of the wrong type for the storage width. A raw value
   * outside the raw bounds latches SerializeError.ValueOutOfRange and
   * writes nothing. A degenerate range where min === max is legal and
   * costs ZERO bits on every storage width (STANDARD.md, adopted
   * 2026-08-15): the value must be exactly min << fractionBits, and
   * nothing is written. Wide writes are checked against the TOTAL width up
   * front, so a refused write puts nothing on the wire.
   * @param {{value: number|bigint}} ref holder of the raw fixed point value.
   * @param {number} integerBits integer bits of the Q format, at least 1.
   * @param {number} fractionBits fractional bits of the Q format.
   * @param {number|bigint} min the minimum value in WHOLE units.
   * @param {number|bigint} max the maximum value in WHOLE units, at least min.
   * @returns {boolean} true on success.
   */
  serializeFixed(ref, integerBits, fractionBits, min, max) {
    const params = fixedPointParams(integerBits, fractionBits, min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (!params.wide) {
      if (typeof value !== 'number') {
        throw new TypeError(VALUE_TYPE_MESSAGE);
      }
      const offset = value - params.rawMin;
      if (!Number.isInteger(value) || offset < 0 || offset > params.rawRange) {
        return this.#fail(SerializeError.ValueOutOfRange);
      }
      if (params.bits === 0) {
        return true; // degenerate range: the value IS the range, nothing to send
      }
      return this.#writeBits(offset, params.bits);
    }
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    const offset = value - params.rawMinBig;
    if (offset < 0n || offset > params.rawRangeBig) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (params.bits === 0) {
      return true; // degenerate range: the value IS the range, nothing to send
    }
    if (params.bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writeGroups128(offset, params.bits);
    return true;
  }

  /**
   * Writes the low 8 bits of ref.value: the fixed-width uint8 helper, an
   * alias for serializeBits(ref, 8) carrying no range information of its
   * own (STANDARD.md). Higher bits are ignored, as the uint8 parameter type
   * of the other ports converts at the call site.
   * @param {{value: number}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeUint8(ref) {
    return this.#writeBits(ref.value, 8);
  }

  /**
   * Writes the low 16 bits of ref.value: the fixed-width uint16 helper, an
   * alias for serializeBits(ref, 16). Higher bits are ignored.
   * @param {{value: number}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeUint16(ref) {
    return this.#writeBits(ref.value, 16);
  }

  /**
   * Writes the low 32 bits of ref.value: the fixed-width uint32 helper, an
   * alias for serializeBits(ref, 32). Higher bits are ignored.
   * @param {{value: number}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeUint32(ref) {
    return this.#writeBits(ref.value, 32);
  }

  /**
   * Writes the low 64 bits of ref.value, a BigInt: the fixed-width uint64
   * helper, an alias for serializeBits64(ref, 64) carrying no range
   * information of its own (STANDARD.md) -- the low 32-bit dword first,
   * then the high dword. Higher bits are ignored and a negative BigInt
   * wraps two's complement. NOT ranged: always costs a full 64 bits --
   * do not confuse it with serializeInt64.
   * @param {{value: bigint}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeUint64(ref) {
    return this.serializeBits64(ref, 64);
  }

  /**
   * Writes the low 128 bits of ref.value, a BigInt: the fixed-width uint128
   * helper, NOT ranged -- always a full 128 bits on the wire, the low
   * 64-bit half first, then the high half, each half low dword first
   * (STANDARD.md "uint128"). When the stream is byte aligned the result is
   * the 16 bytes of the value in little-endian order. Higher bits are
   * ignored and a negative BigInt wraps two's complement. Returns false and
   * latches Overflow if the write would pass the end of the buffer --
   * checked against the full 128 bits up front, so nothing is written on
   * refusal. Do not confuse it with serializeInt128, which is ranged.
   * @param {{value: bigint}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeUint128(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (this.#writer.bitsAvailable() < 128) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writeGroups128(BigInt.asUintN(128, value), 128);
    return true;
  }

  /**
   * Writes one bit: 1 if ref.value is truthy, 0 otherwise (STANDARD.md's
   * bool). Truthiness is JavaScript's boolean conversion, standing in for
   * the bool parameter type of the other ports.
   * @param {{value: boolean}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeBool(ref) {
    return this.#writeBits(ref.value ? 1 : 0, 1);
  }

  /**
   * Writes ref.value as the 32 bits of its IEEE-754 single-precision
   * representation, one 32-bit group: no conversion beyond the float32
   * rounding of the number itself (the float parameter type of the other
   * ports, converting at the call site), no compression (STANDARD.md,
   * "float"). Bit transparent: every pattern is legal on the wire -- NaNs
   * with any payload, signaling NaNs, infinities, negative zero, denormals
   * -- and NaN payloads ride byte-for-byte via a software narrowing that
   * never sets the quiet bit. ref.value must be a number (misuse throws).
   * Returns false and latches Overflow if the write would pass the end of
   * the buffer.
   * @param {{value: number}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeFloat(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    return this.#writeBits(float32BitsFromNumber(value), 32);
  }

  /**
   * Writes ref.value as the 64 bits of its IEEE-754 double-precision
   * representation -- exactly the bits of the JavaScript number, which IS a
   * float64 -- as one 64-bit group: the low 32-bit dword first, then the
   * high dword (STANDARD.md, "double"). Bit transparent: every pattern is
   * legal on the wire and NaN payloads ride byte-for-byte -- no conversion
   * is involved at all. ref.value must be a number (misuse throws). Returns
   * false and latches Overflow if the write would pass the end of the
   * buffer, checked against the full 64 bits up front so nothing is written
   * on refusal.
   * @param {{value: number}} ref holder of the value to write.
   * @returns {boolean} true on success.
   */
  serializeDouble(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (this.#writer.bitsAvailable() < 64) {
      return this.#fail(SerializeError.Overflow);
    }
    FLOAT_SCRATCH.setFloat64(0, value, true);
    // low dword first, then the high dword: the 64-bit group rule
    this.#writer.writeBits(FLOAT_SCRATCH.getUint32(0, true), 32);
    this.#writer.writeBits(FLOAT_SCRATCH.getUint32(4, true), 32);
    return true;
  }

  /**
   * Writes ref.value quantized to a resolution: the compressed float
   * (STANDARD.md, "compressed_float"). The declaration min, max, resolution
   * -- float32 values with min < max and resolution > 0, part of the message
   * format, misuse throws -- prices the wire at
   * bitsRequired(0, ceil((max - min) / resolution)) bits. The value is
   * clamped into [min,max] before quantization; the quantization arithmetic
   * is float32 with TWO roundings -- the product rounds via Math.fround
   * BEFORE 0.5 is added, which is part of the format and changes the bytes
   * (STANDARD.md pins vectors that discriminate). Writing a non-finite
   * value (NaN, +/-Infinity in float32) is non-conforming and latches
   * SerializeError.ValueOutOfRange -- the checked runtime's always-on form
   * of the family's debug assert (ruled 2026-08-15). Lossy by construction:
   * the reader recovers the nearest quantum, not the original value.
   * @param {{value: number}} ref holder of the value to write.
   * @param {number} min the minimum value, a float32.
   * @param {number} max the maximum value, a float32, greater than min.
   * @param {number} resolution the quantum size, a positive float32.
   * @returns {boolean} true on success.
   */
  serializeCompressedFloat(ref, min, max, resolution) {
    const params = compressedFloatParams(min, max, resolution);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    const value32 = Math.fround(value); // the float parameter type of the other ports
    if (!Number.isFinite(value32)) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (params.bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    let normalized = Math.fround(Math.fround(value32 - params.min) / params.delta);
    if (!(normalized >= 0.0)) {
      normalized = 0.0;
    } else if (!(normalized <= 1.0)) {
      normalized = 1.0;
    }
    // STANDARD.md pins this to float32 with TWO roundings: the product
    // rounds BEFORE 0.5 is added. The Math.fround around the product is
    // load bearing -- fused or widened arithmetic changes the wire (0.005
    // over [0,10] at resolution 0.01 must quantize to 1; an FMA writes 0,
    // double arithmetic writes 0).
    const scaled = Math.fround(normalized * Math.fround(params.maxIntegerValue));
    this.#writer.writeBits(Math.floor(Math.fround(scaled + 0.5)), params.bits);
    return true;
  }

  /**
   * Writes an array of bytes: an align to the byte boundary first -- the
   * alignment is part of the format (STANDARD.md, "bytes") -- then
   * data.length raw bytes as a bulk copy. The count is NOT written; both
   * sides must already agree on it, which in this API means the reader
   * passes an array of the same length. A zero-length array still aligns
   * and writes nothing else (ratified 2026-08-15). data must be a
   * Uint8Array (misuse throws). Returns false and latches Overflow if the
   * bytes would pass the end of the buffer; the align padding, written
   * before the check, is part of the latched stream's dead wire.
   * @param {Uint8Array} data the bytes to write, in order.
   * @returns {boolean} true on success.
   */
  serializeBytes(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(BYTES_TYPE_MESSAGE);
    }
    if (this.#error !== SerializeError.None) {
      return false;
    }
    this.#writer.writeAlign();
    if (data.length * 8 > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writer.writeBytes(data);
    return true;
  }

  /**
   * Writes a string: UTF-8 on the wire (STANDARD.md, "string"). The length
   * in UTF-8 BYTES rides first as serializeInt(length, 0, bufferSize - 1)
   * -- bufferSize is part of the message format, both sides must agree on
   * it, and the same string against different buffer sizes produces
   * different bytes -- then the payload as serializeBytes, WHICH ALIGNS. No
   * terminator is transmitted. ref.value must be a string and bufferSize an
   * integer in [2,2^31-1] (misuse throws). A string of bufferSize or more
   * UTF-8 bytes latches SerializeError.ValueOutOfRange and writes nothing:
   * the checked runtime's always-on form of the family's debug assert. A
   * lone surrogate in the string -- ill-formed UTF-16, the writer's
   * contract violated -- encodes as U+FFFD, the contract surfacing
   * JavaScript's way; the wire always carries well-formed UTF-8. Returns
   * false and latches Overflow if the string does not fit the buffer.
   * @param {{value: string}} ref holder of the string to write.
   * @param {number} bufferSize the agreed buffer size; the payload must fit
   *   in bufferSize - 1 bytes.
   * @returns {boolean} true on success.
   */
  serializeString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'string') {
      throw new TypeError(STRING_VALUE_MESSAGE);
    }
    const utf8 = UTF8_ENCODER.encode(value);
    if (utf8.length >= bufferSize) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (!this.serializeInt({ value: utf8.length }, 0, bufferSize - 1)) {
      return false;
    }
    return this.serializeBytes(utf8);
  }

  /**
   * Writes a wide string: each 32-bit group is ONE UTF-16 CODE UNIT, never
   * a code point (STANDARD.md, "wstring", adopted 2026-08-15). A JavaScript
   * string IS a sequence of UTF-16 code units, so the split a 4-byte
   * wchar_t port performs at this boundary -- astral code point to
   * surrogate pair -- has already happened in the string itself: charCodeAt
   * units transmit as they are, and the length field counts units
   * (value.length exactly). The length rides first as
   * serializeInt(length, 0, bufferSize - 1), where bufferSize counts WIDE
   * CHARACTERS, not bytes; then the groups follow with NO ALIGNMENT
   * anywhere -- deliberately unlike the narrow path, which aligns via
   * serializeBytes (STANDARD.md: an implementation that mirrors the narrow
   * path here produces the wrong bytes). ref.value must be a string and
   * bufferSize an integer in [2,2^31-1] (misuse throws). A lone surrogate
   * -- ill-formed UTF-16, the writer's contract violated, which the wide
   * wire cannot carry because conforming readers refuse it -- latches
   * SerializeError.InvalidString and writes nothing: the checked runtime's
   * always-on form of the family's debug assert. A string of bufferSize or
   * more units latches SerializeError.ValueOutOfRange and writes nothing.
   * Returns false and latches Overflow if the groups would pass the end of
   * the buffer, checked against the total width up front so a refused
   * payload writes nothing after the length.
   * @param {{value: string}} ref holder of the string to write.
   * @param {number} bufferSize the agreed buffer size in wide characters;
   *   the string must fit in bufferSize - 1 UTF-16 code units.
   * @returns {boolean} true on success.
   */
  serializeWideString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'string') {
      throw new TypeError(STRING_VALUE_MESSAGE);
    }
    if (!value.isWellFormed()) {
      return this.#fail(SerializeError.InvalidString);
    }
    const length = value.length;
    if (length >= bufferSize) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (!this.serializeInt({ value: length }, 0, bufferSize - 1)) {
      return false;
    }
    // NO align here -- deliberately unlike the narrow path (STANDARD.md)
    if (length * 32 > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    for (let i = 0; i < length; i++) {
      this.#writer.writeBits(value.charCodeAt(i), 32);
    }
    return true;
  }

  /**
   * Pads the stream with zero bits to the next byte boundary; if it is
   * already byte aligned, writes nothing. This can never pass the end of the
   * buffer: the buffer size is a multiple of 8 bytes, so an unaligned bit
   * index is always strictly inside a byte the buffer contains.
   * @returns {boolean} true on success (false only after a latched error).
   */
  serializeAlign() {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    this.#writer.writeAlign();
    return true;
  }

  /**
   * Flushes the last word of bits to memory. Always call this after you
   * finish writing and before you use data(), or you risk truncating the
   * last word. The flush ends the write: do not serialize more values
   * after it.
   */
  flush() {
    this.#writer.flushBits();
  }

  /**
   * The written portion of the buffer (a subarray view, not a copy): the
   * packet you should send.
   *
   * IMPORTANT: Call flush() first.
   */
  data() {
    return this.#writer.data();
  }

  /**
   * The number of bits required to align the stream to the next byte
   * boundary, in [0,7].
   */
  alignBits() {
    return this.#writer.alignBits();
  }

  /** The number of bits written so far. */
  bitsProcessed() {
    return this.#writer.bitsWritten();
  }

  /**
   * The number of bits written so far, rounded up to the next byte. This is
   * effectively the packet size.
   */
  bytesProcessed() {
    return this.#writer.bytesWritten();
  }

  /**
   * The number of bits still available to write, so callers can preflight
   * whether a value fits without dropping to the BitWriter layer.
   */
  bitsAvailable() {
    return this.#writer.bitsAvailable();
  }

  /** The first error latched on the stream, or SerializeError.None (null). */
  get error() {
    return this.#error;
  }

  /** True while no error is latched. */
  get ok() {
    return this.#error === SerializeError.None;
  }
}

/**
 * Reads bitpacked data from a buffer, wrapping BitReader with bounds and
 * range checking on every read, so maliciously crafted packets fail with
 * latched errors instead of throwing or smuggling out-of-range values.
 *
 * The reader prices its windows INSIDE the buffer (see BitReader): any data
 * length is supported and no slack past the data is required -- the caller's
 * allocation contract is empty. STANDARD.md treats this as an implementation
 * contract; both stances conform.
 */
export class ReadStream {
  #reader;
  #error;

  /**
   * Creates a read stream over the bitpacked data in the given array. Any
   * length is supported, and no slack past the data is required.
   * @param {Uint8Array} data the bitpacked data to read.
   */
  constructor(data) {
    this.#reader = new BitReader(data);
    this.#error = SerializeError.None;
  }

  /**
   * Points the stream at a data array and clears all read state including
   * any latched error, allowing a single stream to be reused without
   * allocation.
   * @param {Uint8Array} data the bitpacked data to read.
   */
  reset(data) {
    this.#reader.reset(data);
    this.#error = SerializeError.None;
  }

  /** False. */
  get isWriting() {
    return false;
  }

  /** True: this stream fills ref values in. */
  get isReading() {
    return true;
  }

  #fail(error) {
    if (this.#error === SerializeError.None) {
      this.#error = error;
    }
    return false;
  }

  /**
   * Reads bits that have already been validated to [1,32] into ref.value:
   * the shared tail of every fixed-width read. A latched error and a read
   * past the end of the data are refused as values; on failure ref.value is
   * left unmodified.
   */
  #readBits(ref, bits) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    ref.value = this.#reader.readBits(bits);
    return true;
  }

  /**
   * Reads bits from the stream into ref.value. bits must be an integer in
   * [1,32] (misuse throws). On success ref.value is in [0,(1<<bits)-1]; on
   * failure -- a read past the end of the data latches Overflow -- ref.value
   * is left unmodified. Hostile data never throws.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @param {number} bits width in [1,32].
   * @returns {boolean} true on success.
   */
  serializeBits(ref, bits) {
    validateBits(bits);
    return this.#readBits(ref, bits);
  }

  /**
   * Reads an unsigned wide value in the family's group structure and
   * returns it as a BigInt: a single group for 32 bits or fewer, otherwise
   * the low 32-bit dword first, then the remaining bits - 32 high bits.
   * bits must be in [1,64] and the bounds check must have already passed:
   * the caller checks the TOTAL bits up front, so a refused wide read
   * consumes nothing.
   */
  #readWide64(bits) {
    if (bits <= 32) {
      return BigInt(this.#reader.readBits(bits));
    }
    const lo = this.#reader.readBits(32);
    const hi = this.#reader.readBits(bits - 32);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  /**
   * Reads bits from the stream into ref.value as a BigInt: the 64-bit
   * counterpart of serializeBits. bits must be an integer in [1,64] (misuse
   * throws). Values wider than 32 bits are read as the low 32-bit dword
   * first, then the high remainder. On success ref.value is a BigInt in
   * [0,2^bits-1]; on failure -- a read past the end of the data latches
   * Overflow, checked against the TOTAL width up front -- ref.value is left
   * unmodified. Hostile data never throws.
   * @param {{value: bigint}} ref holder the value read is assigned to.
   * @param {number} bits width in [1,64].
   * @returns {boolean} true on success.
   */
  serializeBits64(ref, bits) {
    validateBits64(bits);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    ref.value = this.#readWide64(bits);
    return true;
  }

  /**
   * Reads a ranged integer -- the format's defining operation: exactly
   * bitsRequired(min,max) bits, decoded as the offset from min in the
   * unsigned domain. min and max must be integers representable in int32
   * with min <= max, identical to the range the writer used: the range is
   * part of the message format, so violating that is caller misuse and
   * throws. On success ref.value is GUARANTEED to be an integer in
   * [min,max]; a decoded offset above max - min -- a value smuggled into
   * the bit headroom of the encoding -- latches
   * SerializeError.ValueOutOfRange, and a read past the end of the data
   * latches Overflow. On failure ref.value is left unmodified, and hostile
   * data never throws. A degenerate range where min === max reads ZERO
   * bits: the value is known from the range alone and ref.value = min.
   * @param {{value: number}} ref holder the integer read is assigned to.
   * @param {number} min the minimum value, an int32.
   * @param {number} max the maximum value, an int32, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt(ref, min, max) {
    validateIntRange(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const bits = bitsRequired(min >>> 0, max >>> 0);
    if (bits === 0) {
      ref.value = min; // degenerate range: the value IS the range
      return true;
    }
    if (this.#reader.wouldReadPastEnd(bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    const unsigned = this.#reader.readBits(bits);
    // compare and add in the unsigned domain: the range may be wider than
    // 2^31, and | 0 wraps the sum back into the signed int32 domain
    if (unsigned > ((max >>> 0) - (min >>> 0)) >>> 0) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    ref.value = (unsigned + (min >>> 0)) | 0;
    return true;
  }

  /**
   * Reads a ranged 64-bit integer: exactly bitsRequired64 bits, decoded as
   * the offset from min in the unsigned 64-bit domain -- low 32-bit dword
   * first, then the high remainder, where the offset needs more than 32
   * bits. min and max must be BigInts representable in int64 with
   * min <= max, identical to the range the writer used: violating that is
   * caller misuse and throws. On success ref.value is a BigInt GUARANTEED
   * to be in [min,max]; a decoded offset above max - min -- a value
   * smuggled into the bit headroom of the encoding -- latches
   * SerializeError.ValueOutOfRange, and a read past the end of the data
   * latches Overflow, checked against the TOTAL width up front so a refused
   * read consumes nothing. On failure ref.value is left unmodified, and
   * hostile data never throws. A degenerate range where min === max reads
   * ZERO bits: ref.value = min from the range alone.
   * @param {{value: bigint}} ref holder the integer read is assigned to.
   * @param {bigint} min the minimum value, an int64 BigInt.
   * @param {bigint} max the maximum value, an int64 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt64(ref, min, max) {
    validateInt64Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const bits = bitsRequired64(BigInt.asUintN(64, min), BigInt.asUintN(64, max));
    if (bits === 0) {
      ref.value = min; // degenerate range: the value IS the range
      return true;
    }
    if (this.#reader.wouldReadPastEnd(bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    const unsigned = this.#readWide64(bits);
    // compare and add in the unsigned domain: the range may be wider than 2^63
    if (unsigned > BigInt.asUintN(64, max - min)) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    ref.value = BigInt.asIntN(64, unsigned + BigInt.asUintN(64, min));
    return true;
  }

  /**
   * Reads an unsigned wide value written in 32-bit groups, least
   * significant group first, and returns it as a BigInt: full 32-bit groups
   * from the bottom with the final group carrying the remainder -- the
   * shared group structure of the 128-bit paths. bits must be in [1,128]
   * and the bounds check must have already passed: the caller checks the
   * TOTAL bits up front, so a refused wide read consumes nothing.
   */
  #readGroups128(bits) {
    if (bits <= 64) {
      return this.#readWide64(bits);
    }
    if (bits <= 96) {
      const g0 = this.#reader.readBits(32);
      const g1 = this.#reader.readBits(32);
      const g2 = this.#reader.readBits(bits - 64);
      return (BigInt(g2) << 64n) | (BigInt(g1) << 32n) | BigInt(g0);
    }
    const g0 = this.#reader.readBits(32);
    const g1 = this.#reader.readBits(32);
    const g2 = this.#reader.readBits(32);
    const g3 = this.#reader.readBits(bits - 96);
    return (BigInt(g3) << 96n) | (BigInt(g2) << 64n) | (BigInt(g1) << 32n) | BigInt(g0);
  }

  /**
   * Reads a ranged 128-bit integer: exactly bitsRequired128 bits, decoded
   * as the offset from min in the unsigned 128-bit domain -- 32-bit groups,
   * least significant first, up to four groups. min and max must be BigInts
   * representable in int128 with min <= max, identical to the range the
   * writer used: violating that is caller misuse and throws. On success
   * ref.value is a BigInt GUARANTEED to be in [min,max]; a decoded offset
   * above max - min in the unsigned domain -- a value smuggled into the bit
   * headroom of the encoding -- latches SerializeError.ValueOutOfRange
   * (reject, never clamp), and a read past the end of the data latches
   * Overflow, checked against the TOTAL width up front so a refused read
   * consumes nothing. On failure ref.value is left unmodified, and hostile
   * data never throws. A degenerate range where min === max reads ZERO
   * bits: ref.value = min from the range alone.
   * @param {{value: bigint}} ref holder the integer read is assigned to.
   * @param {bigint} min the minimum value, an int128 BigInt.
   * @param {bigint} max the maximum value, an int128 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt128(ref, min, max) {
    validateInt128Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const bits = bitsRequired128(BigInt.asUintN(128, min), BigInt.asUintN(128, max));
    if (bits === 0) {
      ref.value = min; // degenerate range: the value IS the range
      return true;
    }
    if (this.#reader.wouldReadPastEnd(bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    const unsigned = this.#readGroups128(bits);
    // compare and add in the unsigned domain: the range may be wider than 2^127
    if (unsigned > BigInt.asUintN(128, max - min)) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    ref.value = BigInt.asIntN(128, unsigned + BigInt.asUintN(128, min));
    return true;
  }

  /**
   * Reads a value written relative to previous with the int_relative flag
   * ladder (STANDARD.md "int_relative"), mirroring serialize.h's reader
   * step for step: flag bits are read one at a time until a tier claims the
   * value; a payload tier reconstructs current = previous + difference in
   * the unsigned 32-bit domain, wrapping mod 2^32 exactly as the reference
   * does; the final tier -- six zero flags -- carries current itself as 32
   * raw bits, the absolute form with no ordering guarantee of its own, so
   * the reader checks current > previous and latches
   * SerializeError.ValueOutOfRange otherwise (STANDARD.md: strictly
   * increasing, no wrapping -- adopted 2026-08-15). A payload offset above
   * its tier's range -- a difference smuggled into the bit headroom --
   * latches ValueOutOfRange, and a read past the end of the data latches
   * Overflow. previous must be an integer in [0,2^32-1], identical to the
   * writer's: it is the caller's own sequence state, so violating that is
   * caller misuse and throws. On success ref.value is an integer in
   * [0,2^32-1]; on failure it is left unmodified, and hostile data never
   * throws.
   * @param {number} previous the previous value, an integer in [0,2^32-1].
   * @param {{value: number}} ref holder the current value is assigned to.
   * @returns {boolean} true on success.
   */
  serializeIntRelative(previous, ref) {
    validatePrevious(previous);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    for (let tier = 0; tier < 6; tier++) {
      if (this.#reader.wouldReadPastEnd(1)) {
        return this.#fail(SerializeError.Overflow);
      }
      if (this.#reader.readBits(1) === 1) {
        if (tier === 0) {
          // a difference of exactly 1: no payload
          ref.value = (previous + 1) >>> 0;
          return true;
        }
        const bits = RELATIVE_TIER_BITS[tier];
        if (this.#reader.wouldReadPastEnd(bits)) {
          return this.#fail(SerializeError.Overflow);
        }
        const offset = this.#reader.readBits(bits);
        if (offset > RELATIVE_TIER_RANGE[tier]) {
          return this.#fail(SerializeError.ValueOutOfRange);
        }
        // reconstruct in the unsigned domain: previous + difference wraps
        // mod 2^32, exactly the reference's uint32 arithmetic
        ref.value = (previous + RELATIVE_TIER_BASE[tier] + offset) >>> 0;
        return true;
      }
    }
    if (this.#reader.wouldReadPastEnd(32)) {
      return this.#fail(SerializeError.Overflow);
    }
    const current = this.#reader.readBits(32);
    if (current <= previous) {
      // the absolute form carries no ordering guarantee of its own: the
      // reader enforces strictly increasing here (STANDARD.md)
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    ref.value = current;
    return true;
  }

  /**
   * Reads a fixed point value (STANDARD.md "fixed"): exactly the bit
   * length of the raw range, decoded as the offset from
   * min << fractionBits -- a Number for storage of 32 bits or fewer, a
   * BigInt read in 32-bit groups, least significant first, for 64 and 128
   * bit storage. The declaration (integerBits, fractionBits, min, max in
   * WHOLE units) must be identical to the writer's -- it is part of the
   * message format, so violating it is caller misuse and throws. On
   * success ref.value is the raw scaled integer, GUARANTEED to be within
   * the raw bounds, and the round trip is EXACT; a decoded offset above
   * the raw range -- a raw value smuggled into the bit headroom of the
   * encoding -- latches SerializeError.ValueOutOfRange (reject, never
   * clamp), and a read past the end of the data latches Overflow, checked
   * against the TOTAL width up front so a refused read consumes nothing.
   * On failure ref.value is left unmodified, and hostile data never
   * throws. A degenerate range where min === max reads ZERO bits on every
   * storage width: ref.value = min << fractionBits from the range alone.
   * @param {{value: number|bigint}} ref holder the raw value is assigned to.
   * @param {number} integerBits integer bits of the Q format, at least 1.
   * @param {number} fractionBits fractional bits of the Q format.
   * @param {number|bigint} min the minimum value in WHOLE units.
   * @param {number|bigint} max the maximum value in WHOLE units, at least min.
   * @returns {boolean} true on success.
   */
  serializeFixed(ref, integerBits, fractionBits, min, max) {
    const params = fixedPointParams(integerBits, fractionBits, min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (!params.wide) {
      if (params.bits === 0) {
        ref.value = params.rawMin; // degenerate range: the value IS the range
        return true;
      }
      if (this.#reader.wouldReadPastEnd(params.bits)) {
        return this.#fail(SerializeError.Overflow);
      }
      const offset = this.#reader.readBits(params.bits);
      if (offset > params.rawRange) {
        return this.#fail(SerializeError.ValueOutOfRange);
      }
      ref.value = params.rawMin + offset;
      return true;
    }
    if (params.bits === 0) {
      ref.value = params.rawMinBig; // degenerate range: the value IS the range
      return true;
    }
    if (this.#reader.wouldReadPastEnd(params.bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    const offset = this.#readGroups128(params.bits);
    if (offset > params.rawRangeBig) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    ref.value = params.rawMinBig + offset;
    return true;
  }

  /**
   * Reads 8 bits into ref.value: the fixed-width uint8 helper, an alias for
   * serializeBits(ref, 8) carrying no range information of its own
   * (STANDARD.md). On success ref.value is in [0,255]; on failure it is
   * left unmodified.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeUint8(ref) {
    return this.#readBits(ref, 8);
  }

  /**
   * Reads 16 bits into ref.value: the fixed-width uint16 helper, an alias
   * for serializeBits(ref, 16). On success ref.value is in [0,65535]; on
   * failure it is left unmodified.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeUint16(ref) {
    return this.#readBits(ref, 16);
  }

  /**
   * Reads 32 bits into ref.value: the fixed-width uint32 helper, an alias
   * for serializeBits(ref, 32). On success ref.value is in [0,2^32-1]; on
   * failure it is left unmodified.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeUint32(ref) {
    return this.#readBits(ref, 32);
  }

  /**
   * Reads 64 bits into ref.value as a BigInt: the fixed-width uint64
   * helper, an alias for serializeBits64(ref, 64) carrying no range
   * information of its own (STANDARD.md) -- the low 32-bit dword first,
   * then the high dword. On success ref.value is a BigInt in [0,2^64-1];
   * on failure it is left unmodified. NOT ranged: always costs a full 64
   * bits -- do not confuse it with serializeInt64.
   * @param {{value: bigint}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeUint64(ref) {
    return this.serializeBits64(ref, 64);
  }

  /**
   * Reads 128 bits into ref.value as a BigInt: the fixed-width uint128
   * helper, NOT ranged -- always a full 128 bits, the low 64-bit half
   * first, then the high half, each half low dword first (STANDARD.md
   * "uint128"). On success ref.value is a BigInt in [0,2^128-1]; on failure
   * -- a read past the end of the data latches Overflow, checked against
   * the full 128 bits up front so nothing is consumed -- ref.value is left
   * unmodified. Hostile data never throws. Do not confuse it with
   * serializeInt128, which is ranged.
   * @param {{value: bigint}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeUint128(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(128)) {
      return this.#fail(SerializeError.Overflow);
    }
    ref.value = this.#readGroups128(128);
    return true;
  }

  /**
   * Reads one bit into ref.value as a real boolean: true for 1, false for
   * 0 (STANDARD.md's bool). A single bit cannot be out of range, so the
   * only refusal is a read past the end of the data; on failure ref.value
   * is left unmodified.
   * @param {{value: boolean}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeBool(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(1)) {
      return this.#fail(SerializeError.Overflow);
    }
    ref.value = this.#reader.readBits(1) !== 0;
    return true;
  }

  /**
   * Reads 32 bits into ref.value as the number whose IEEE-754
   * single-precision representation they are (STANDARD.md, "float"). Bit
   * transparent: every pattern on the wire is legal -- NaNs with any
   * payload, signaling NaNs, infinities, negative zero, denormals -- and
   * the transmitted pattern is reproduced exactly, never canonicalized,
   * quieted, flushed or refused; NaN patterns are widened in software so
   * the signaling bit survives, and writing the value back produces the
   * identical bytes. The only refusal is a read past the end of the data,
   * which latches Overflow; on failure ref.value is left unmodified.
   * Hostile data never throws.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeFloat(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(32)) {
      return this.#fail(SerializeError.Overflow);
    }
    ref.value = numberFromFloat32Bits(this.#reader.readBits(32));
    return true;
  }

  /**
   * Reads 64 bits into ref.value as the number whose IEEE-754
   * double-precision representation they are -- exactly the bits of the
   * JavaScript number, which IS a float64 -- the low 32-bit dword first,
   * then the high dword (STANDARD.md, "double"). Bit transparent: every
   * pattern is legal and reproduced exactly, NaN payloads included -- no
   * conversion is involved at all. The only refusal is a read past the end
   * of the data, which latches Overflow, checked against the full 64 bits
   * up front so nothing is consumed; on failure ref.value is left
   * unmodified. Hostile data never throws.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @returns {boolean} true on success.
   */
  serializeDouble(ref) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(64)) {
      return this.#fail(SerializeError.Overflow);
    }
    // low dword first, then the high dword: the 64-bit group rule
    FLOAT_SCRATCH.setUint32(0, this.#reader.readBits(32), true);
    FLOAT_SCRATCH.setUint32(4, this.#reader.readBits(32), true);
    ref.value = FLOAT_SCRATCH.getFloat64(0, true);
    return true;
  }

  /**
   * Reads a compressed float: exactly the declaration's bit count, decoded
   * as quantum index * quantum size + min (STANDARD.md,
   * "compressed_float"). The declaration min, max, resolution -- float32
   * values with min < max and resolution > 0, identical to what the writer
   * used, part of the message format, misuse throws -- prices the wire; the
   * decode arithmetic is float32 with every step rounding via Math.fround:
   * the quotient rounds, the product rounds BEFORE min is added -- fused or
   * widened arithmetic decodes a value one ulp away wherever min is
   * non-zero, and the conformance vectors pin the decoded bit patterns
   * exactly. A decoded integer above ceil((max - min) / resolution) -- a
   * value smuggled into the bit headroom of the encoding -- latches
   * SerializeError.ValueOutOfRange, and a read past the end of the data
   * latches Overflow. On failure ref.value is left unmodified, and hostile
   * data never throws.
   * @param {{value: number}} ref holder the value read is assigned to.
   * @param {number} min the minimum value, a float32.
   * @param {number} max the maximum value, a float32, greater than min.
   * @param {number} resolution the quantum size, a positive float32.
   * @returns {boolean} true on success.
   */
  serializeCompressedFloat(ref, min, max, resolution) {
    const params = compressedFloatParams(min, max, resolution);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (this.#reader.wouldReadPastEnd(params.bits)) {
      return this.#fail(SerializeError.Overflow);
    }
    const integerValue = this.#reader.readBits(params.bits);
    if (integerValue > params.maxIntegerValue) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    // STANDARD.md pins the decode to float32 with every step rounding: the
    // Math.fround around the product, BEFORE min is added, is load bearing
    // -- a fused decode is one ulp off whenever min is non-zero, and a
    // re-encode of that value produces different wire.
    const normalized = Math.fround(Math.fround(integerValue) / Math.fround(params.maxIntegerValue));
    const scaled = Math.fround(normalized * params.delta);
    ref.value = Math.fround(scaled + params.min);
    return true;
  }

  /**
   * Reads an array of bytes: an align to the byte boundary first -- the
   * alignment is part of the format (STANDARD.md, "bytes"), and its padding
   * is verified zero -- then data.length raw bytes copied into data. The
   * count is not on the wire; passing an array of the agreed length IS the
   * agreement. A zero-length array still performs and verifies the align.
   * data must be a Uint8Array (misuse throws). Nonzero align padding latches
   * SerializeError.Align; bytes past the end of the data latch Overflow. On
   * refusal data is untouched. Hostile data never throws.
   * @param {Uint8Array} data destination; its length is the byte count.
   * @returns {boolean} true on success.
   */
  serializeBytes(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(BYTES_TYPE_MESSAGE);
    }
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (!this.#reader.readAlign()) {
      return this.#fail(SerializeError.Align);
    }
    // compare in bytes rather than bits, consistent with the family's
    // 64-bit bookkeeping
    if (data.length > this.#reader.bitsRemaining() / 8) {
      return this.#fail(SerializeError.Overflow);
    }
    data.set(this.#reader.readBytes(data.length));
    return true;
  }

  /**
   * Reads a string: the UTF-8 byte length as serializeInt in
   * [0,bufferSize-1] -- bufferSize is part of the message format, both
   * sides must agree on it -- then an align whose padding is verified zero,
   * then the payload bytes. The payload is validated in every build mode
   * (STANDARD.md, "Readers must refuse malformed string payloads", adopted
   * 2026-08-15): an interior NUL among the transmitted bytes -- the
   * two-lengths smuggling primitive, impossible from a conforming writer,
   * and well-formed UTF-8, which is why the scan is explicit -- latches
   * SerializeError.InvalidString, and malformed UTF-8 (overlong encodings,
   * surrogate code points, values above U+10FFFF, truncated sequences,
   * stray continuation bytes) latches InvalidString via the fatal decoder.
   * A length that overruns the data latches Overflow; nonzero align padding
   * latches Align. On success ref.value is the decoded string; on any
   * refusal ref.value is left unmodified, and hostile data never throws.
   * bufferSize must be an integer in [2,2^31-1] (misuse throws).
   * @param {{value: string}} ref holder the string read is assigned to.
   * @param {number} bufferSize the agreed buffer size; the payload is at
   *   most bufferSize - 1 bytes.
   * @returns {boolean} true on success.
   */
  serializeString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const lengthRef = { value: 0 };
    if (!this.serializeInt(lengthRef, 0, bufferSize - 1)) {
      return false;
    }
    if (!this.#reader.readAlign()) {
      return this.#fail(SerializeError.Align);
    }
    const length = lengthRef.value;
    // compare in bytes rather than bits, consistent with the family's
    // 64-bit bookkeeping
    if (length > this.#reader.bitsRemaining() / 8) {
      return this.#fail(SerializeError.Overflow);
    }
    const payload = this.#reader.readBytes(length);
    // interior NUL first: valid UTF-8, so the decoder below cannot catch
    // it, and the terminator is never transmitted, so ANY NUL among the
    // transmitted bytes is interior
    for (let i = 0; i < length; i++) {
      if (payload[i] === 0) {
        return this.#fail(SerializeError.InvalidString);
      }
    }
    let decoded;
    try {
      decoded = UTF8_DECODER.decode(payload);
    } catch {
      return this.#fail(SerializeError.InvalidString);
    }
    ref.value = decoded;
    return true;
  }

  /**
   * Reads a wide string: the length in UTF-16 CODE UNITS as serializeInt in
   * [0,bufferSize-1] -- bufferSize counts wide characters and is part of
   * the message format -- then length 32-bit groups with NO ALIGNMENT
   * anywhere in the operation, each group one code unit (STANDARD.md,
   * "wstring", adopted 2026-08-15). A JavaScript string holds exactly these
   * units, so a well-formed surrogate pair "recombines" by adjacency:
   * storing the two units next to each other IS the astral character -- no
   * recombination arithmetic. Malformed payloads are refused in every build
   * mode (STANDARD.md, "Readers must refuse malformed wstring payloads"): a
   * group above 0xFFFF is not a UTF-16 code unit and latches
   * SerializeError.ValueOutOfRange -- fail rather than truncate, the family
   * rule for a value the local wide character cannot hold; an interior NUL
   * group -- the two-lengths smuggling primitive, wire length versus the
   * shorter wcslen a downstream consumer perceives -- latches
   * SerializeError.InvalidString, and so does every unpaired surrogate: a
   * high not immediately followed by a low, a low with no high before it,
   * and a dangling high as the final group. A length that overruns the data
   * latches Overflow, checked against the total width up front. On success
   * ref.value is the decoded string; on any refusal ref.value is left
   * unmodified, and hostile data never throws. bufferSize must be an
   * integer in [2,2^31-1] (misuse throws).
   * @param {{value: string}} ref holder the string read is assigned to.
   * @param {number} bufferSize the agreed buffer size in wide characters;
   *   the payload is at most bufferSize - 1 UTF-16 code units.
   * @returns {boolean} true on success.
   */
  serializeWideString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const lengthRef = { value: 0 };
    if (!this.serializeInt(lengthRef, 0, bufferSize - 1)) {
      return false;
    }
    // NO align here -- deliberately unlike the narrow path (STANDARD.md)
    const length = lengthRef.value;
    if (length * 32 > this.#reader.bitsRemaining()) {
      return this.#fail(SerializeError.Overflow);
    }
    const units = new Array(length);
    let pendingHigh = false; // a high surrogate awaiting its low half
    for (let i = 0; i < length; i++) {
      const unit = this.#reader.readBits(32);
      if (unit > 0xffff) {
        // not a UTF-16 code unit: no conforming writer emits one, and a
        // string cannot hold it -- fail rather than truncate
        return this.#fail(SerializeError.ValueOutOfRange);
      }
      if (unit === 0) {
        return this.#fail(SerializeError.InvalidString); // interior NUL
      }
      if (pendingHigh) {
        if (unit < 0xdc00 || unit > 0xdfff) {
          return this.#fail(SerializeError.InvalidString); // high surrogate without its low half
        }
        pendingHigh = false;
      } else if (unit >= 0xd800 && unit <= 0xdbff) {
        pendingHigh = true;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return this.#fail(SerializeError.InvalidString); // low surrogate with no high before it
      }
      units[i] = unit;
    }
    if (pendingHigh) {
      return this.#fail(SerializeError.InvalidString); // the payload ends inside a surrogate pair
    }
    // build in bounded chunks: fromCharCode takes the units as arguments,
    // and argument lists have engine limits a length field must not reach
    let decoded = '';
    for (let i = 0; i < length; i += 1024) {
      decoded += String.fromCharCode(...units.slice(i, Math.min(i + 1024, length)));
    }
    ref.value = decoded;
    return true;
  }

  /**
   * Skips ahead to the next byte boundary, verifying that the padding bits
   * are zero. Nonzero padding latches SerializeError.Align, which typically
   * means the read and write serialize functions don't match. This can never
   * read past the end of the data: the data length in bits is a multiple of
   * 8, so an unaligned bit index is always strictly inside the final byte.
   * @returns {boolean} true on success.
   */
  serializeAlign() {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (!this.#reader.readAlign()) {
      return this.#fail(SerializeError.Align);
    }
    return true;
  }

  /**
   * The number of bits required to align the stream to the next byte
   * boundary, in [0,7].
   */
  alignBits() {
    return this.#reader.alignBits();
  }

  /** The number of bits read so far. */
  bitsProcessed() {
    return this.#reader.bitsRead();
  }

  /** The number of bits read so far, rounded up to the next byte. */
  bytesProcessed() {
    return Math.ceil(this.#reader.bitsRead() / 8);
  }

  /** The first error latched on the stream, or SerializeError.None (null). */
  get error() {
    return this.#error;
  }

  /** True while no error is latched. */
  get ok() {
    return this.#error === SerializeError.None;
  }
}

/**
 * Counts how many bits it would take to serialize something, without writing
 * any data. It acts like a write stream (isWriting is true), so a unified
 * serialize function measures the exact same fields it would write.
 *
 * The measurement is a conservative BOUND, never exact (STANDARD.md, "The
 * Measure Stream"): alignment cost depends on the bit position the message
 * is later written at, which a measure does not know, so every
 * alignment-performing operation is charged the worst case 7 bits. The bound
 * is sufficient to serialize the message at ANY starting bit position --
 * that is the one thing a measure is for. Comparing a measure to a write's
 * bitsProcessed and expecting equality is a misuse.
 *
 * A measure validates like a write (the Go port's stance): nothing it sees
 * came off a network, but a ranged value outside its range latches
 * SerializeError.ValueOutOfRange exactly as the write would, so a message
 * that cannot be written cannot be measured either. Wire-level refusals
 * (Overflow, Align) cannot occur here: no operation on a measure stream
 * touches a buffer.
 */
export class MeasureStream {
  #bitsWritten;
  #error;

  /** Creates a measure stream. */
  constructor() {
    this.#bitsWritten = 0;
    this.#error = SerializeError.None;
  }

  /** Clears the measured bit count and any latched error. */
  reset() {
    this.#bitsWritten = 0;
    this.#error = SerializeError.None;
  }

  /**
   * True: a measure stream behaves like a write stream so that unified
   * serialize functions measure exactly what they would write.
   */
  get isWriting() {
    return true;
  }

  /** False. */
  get isReading() {
    return false;
  }

  #fail(error) {
    if (this.#error === SerializeError.None) {
      this.#error = error;
    }
    return false;
  }

  #measure(bits) {
    if (this.#error !== SerializeError.None) {
      return false;
    }
    this.#bitsWritten += bits;
    return true;
  }

  /**
   * Measures bits, which must be an integer in [1,32] (misuse throws).
   * ref is ignored: a measure never touches values.
   * @param {{value: number}} ref ignored.
   * @param {number} bits width in [1,32].
   * @returns {boolean} true on success.
   */
  serializeBits(ref, bits) {
    validateBits(bits);
    return this.#measure(bits);
  }

  /**
   * Measures bits, which must be an integer in [1,64] (misuse throws).
   * ref is ignored: a measure never touches values.
   * @param {{value: bigint}} ref ignored.
   * @param {number} bits width in [1,64].
   * @returns {boolean} true on success.
   */
  serializeBits64(ref, bits) {
    validateBits64(bits);
    return this.#measure(bits);
  }

  /**
   * Measures a ranged integer: exactly bitsRequired(min,max) bits, zero for
   * a degenerate range where min === max. min and max must be integers
   * representable in int32 with min <= max (misuse throws). Like a write,
   * ref.value must be an integer in [min,max] or the measure latches
   * SerializeError.ValueOutOfRange: a message that cannot be written cannot
   * be measured either.
   * @param {{value: number}} ref holder of the integer that would be written.
   * @param {number} min the minimum value, an int32.
   * @param {number} max the maximum value, an int32, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt(ref, min, max) {
    validateIntRange(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (!Number.isInteger(value) || value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    return this.#measure(bitsRequired(min >>> 0, max >>> 0));
  }

  /**
   * Measures a ranged 64-bit integer: exactly bitsRequired64 bits, zero for
   * a degenerate range where min === max. min and max must be BigInts
   * representable in int64 with min <= max (misuse throws, as is a
   * non-BigInt value). Like a write, ref.value must be in [min,max] or the
   * measure latches SerializeError.ValueOutOfRange: a message that cannot
   * be written cannot be measured either.
   * @param {{value: bigint}} ref holder of the integer that would be written.
   * @param {bigint} min the minimum value, an int64 BigInt.
   * @param {bigint} max the maximum value, an int64 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt64(ref, min, max) {
    validateInt64Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    return this.#measure(bitsRequired64(BigInt.asUintN(64, min), BigInt.asUintN(64, max)));
  }

  /**
   * Measures a ranged 128-bit integer: exactly bitsRequired128 bits, zero
   * for a degenerate range where min === max. min and max must be BigInts
   * representable in int128 with min <= max (misuse throws, as is a
   * non-BigInt value). Like a write, ref.value must be in [min,max] or the
   * measure latches SerializeError.ValueOutOfRange: a message that cannot
   * be written cannot be measured either.
   * @param {{value: bigint}} ref holder of the integer that would be written.
   * @param {bigint} min the minimum value, an int128 BigInt.
   * @param {bigint} max the maximum value, an int128 BigInt, at least min.
   * @returns {boolean} true on success.
   */
  serializeInt128(ref, min, max) {
    validateInt128Range(min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    if (value < min || value > max) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    return this.#measure(bitsRequired128(BigInt.asUintN(128, min), BigInt.asUintN(128, max)));
  }

  /**
   * Measures a value written relative to previous with the int_relative
   * flag ladder: exactly the tier the write would emit -- 1, 5, 8, 13, 18
   * or 23 bits for the difference tiers, 38 bits for the absolute final
   * tier (int_relative never aligns, so the measure is exact, not a
   * bound). Like a write, previous must be an integer in [0,2^32-1]
   * (misuse throws, as is a non-number ref.value) and ref.value must be an
   * integer in the uint32 domain above previous, or the measure latches
   * SerializeError.ValueOutOfRange: a message that cannot be written
   * cannot be measured either.
   * @param {number} previous the previous value, an integer in [0,2^32-1].
   * @param {{value: number}} ref holder of the current value that would be
   * written.
   * @returns {boolean} true on success.
   */
  serializeIntRelative(previous, ref) {
    validatePrevious(previous);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const current = ref.value;
    if (typeof current !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (!Number.isInteger(current) || current <= previous || current > 0xffffffff) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    const difference = current - previous;
    if (difference === 1) {
      return this.#measure(1);
    }
    if (difference <= 6) {
      return this.#measure(5);
    }
    if (difference <= 23) {
      return this.#measure(8);
    }
    if (difference <= 280) {
      return this.#measure(13);
    }
    if (difference <= 4377) {
      return this.#measure(18);
    }
    if (difference <= 69914) {
      return this.#measure(23);
    }
    return this.#measure(38);
  }

  /**
   * Measures a fixed point value: exactly the bit length of the raw range,
   * a constant of the declaration -- zero for a degenerate min === max
   * range, on every storage width (fixed never aligns, so the measure is
   * exact, not a bound). The declaration must be valid or the measure
   * throws, exactly as the write would (misuse), and like a write the raw
   * ref.value must be an integer of the storage width's type within the
   * raw bounds, or the measure latches SerializeError.ValueOutOfRange: a
   * message that cannot be written cannot be measured either.
   * @param {{value: number|bigint}} ref holder of the raw fixed point value
   * that would be written.
   * @param {number} integerBits integer bits of the Q format, at least 1.
   * @param {number} fractionBits fractional bits of the Q format.
   * @param {number|bigint} min the minimum value in WHOLE units.
   * @param {number|bigint} max the maximum value in WHOLE units, at least min.
   * @returns {boolean} true on success.
   */
  serializeFixed(ref, integerBits, fractionBits, min, max) {
    const params = fixedPointParams(integerBits, fractionBits, min, max);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (!params.wide) {
      if (typeof value !== 'number') {
        throw new TypeError(VALUE_TYPE_MESSAGE);
      }
      const offset = value - params.rawMin;
      if (!Number.isInteger(value) || offset < 0 || offset > params.rawRange) {
        return this.#fail(SerializeError.ValueOutOfRange);
      }
      return this.#measure(params.bits);
    }
    if (typeof value !== 'bigint') {
      throw new TypeError(BIGINT_VALUE_MESSAGE);
    }
    const offset = value - params.rawMinBig;
    if (offset < 0n || offset > params.rawRangeBig) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    return this.#measure(params.bits);
  }

  /**
   * Measures the fixed-width uint8 helper: 8 bits. ref is ignored.
   * @param {{value: number}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeUint8(ref) {
    return this.#measure(8);
  }

  /**
   * Measures the fixed-width uint16 helper: 16 bits. ref is ignored.
   * @param {{value: number}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeUint16(ref) {
    return this.#measure(16);
  }

  /**
   * Measures the fixed-width uint32 helper: 32 bits. ref is ignored.
   * @param {{value: number}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeUint32(ref) {
    return this.#measure(32);
  }

  /**
   * Measures the fixed-width uint64 helper: 64 bits. ref is ignored.
   * @param {{value: bigint}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeUint64(ref) {
    return this.#measure(64);
  }

  /**
   * Measures the fixed-width uint128 helper: 128 bits. ref is ignored.
   * @param {{value: bigint}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeUint128(ref) {
    return this.#measure(128);
  }

  /**
   * Measures a bool: 1 bit. ref is ignored.
   * @param {{value: boolean}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeBool(ref) {
    return this.#measure(1);
  }

  /**
   * Measures a float: 32 bits. ref is ignored.
   * @param {{value: number}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeFloat(ref) {
    return this.#measure(32);
  }

  /**
   * Measures a double: 64 bits. ref is ignored.
   * @param {{value: number}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeDouble(ref) {
    return this.#measure(64);
  }

  /**
   * Measures a compressed float: exactly the declaration's bit count,
   * bitsRequired(0, ceil((max - min) / resolution)) in float32 arithmetic.
   * The declaration must be valid -- float32 min < max, resolution > 0,
   * delta and delta / resolution finite -- or the measure throws, exactly
   * as the write would (misuse). Like a write, a non-finite ref.value
   * latches SerializeError.ValueOutOfRange: a message that cannot be
   * written cannot be measured either.
   * @param {{value: number}} ref holder of the value that would be written.
   * @param {number} min the minimum value, a float32.
   * @param {number} max the maximum value, a float32, greater than min.
   * @param {number} resolution the quantum size, a positive float32.
   * @returns {boolean} true on success.
   */
  serializeCompressedFloat(ref, min, max, resolution) {
    const params = compressedFloatParams(min, max, resolution);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (!Number.isFinite(Math.fround(value))) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    return this.#measure(params.bits);
  }

  /**
   * Measures an array of bytes: a worst case 7-bit align plus the data
   * bytes -- the bytes operation aligns, and a measure charges every
   * alignment its conservative worst case. data must be a Uint8Array
   * (misuse throws); its contents are ignored.
   * @param {Uint8Array} data the bytes that would be written.
   * @returns {boolean} true on success.
   */
  serializeBytes(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(BYTES_TYPE_MESSAGE);
    }
    if (this.#error !== SerializeError.None) {
      return false;
    }
    this.serializeAlign();
    return this.#measure(data.length * 8);
  }

  /**
   * Measures a string: the length prefix (bitsRequired(0, bufferSize - 1)
   * bits), a worst case 7-bit align, and the UTF-8 payload bytes. ref.value
   * must be a string and bufferSize an integer in [2,2^31-1] (misuse
   * throws). Like a write, a string of bufferSize or more UTF-8 bytes
   * latches SerializeError.ValueOutOfRange: a message that cannot be
   * written cannot be measured either.
   * @param {{value: string}} ref holder of the string that would be written.
   * @param {number} bufferSize the agreed buffer size; the payload must fit
   *   in bufferSize - 1 bytes.
   * @returns {boolean} true on success.
   */
  serializeString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'string') {
      throw new TypeError(STRING_VALUE_MESSAGE);
    }
    const byteLength = UTF8_ENCODER.encode(value).length;
    if (byteLength >= bufferSize) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (!this.serializeInt({ value: byteLength }, 0, bufferSize - 1)) {
      return false;
    }
    this.serializeAlign();
    return this.#measure(byteLength * 8);
  }

  /**
   * Measures a wide string: the length prefix
   * (bitsRequired(0, bufferSize - 1) bits) plus 32 bits per UTF-16 code
   * unit -- value.length exactly, the group count the write transmits
   * (STANDARD.md, "wstring", adopted 2026-08-15) -- and NO alignment
   * anywhere in the operation, so unlike the narrow path this measure
   * carries no 7-bit align bound: measure and write agree bit for bit.
   * ref.value must be a string and bufferSize an integer in [2,2^31-1]
   * (misuse throws). Like a write, a lone surrogate latches
   * SerializeError.InvalidString and a string of bufferSize or more units
   * latches SerializeError.ValueOutOfRange: a message that cannot be
   * written cannot be measured either.
   * @param {{value: string}} ref holder of the string that would be written.
   * @param {number} bufferSize the agreed buffer size in wide characters;
   *   the string must fit in bufferSize - 1 UTF-16 code units.
   * @returns {boolean} true on success.
   */
  serializeWideString(ref, bufferSize) {
    validateBufferSize(bufferSize);
    if (this.#error !== SerializeError.None) {
      return false;
    }
    const value = ref.value;
    if (typeof value !== 'string') {
      throw new TypeError(STRING_VALUE_MESSAGE);
    }
    if (!value.isWellFormed()) {
      return this.#fail(SerializeError.InvalidString);
    }
    const length = value.length;
    if (length >= bufferSize) {
      return this.#fail(SerializeError.ValueOutOfRange);
    }
    if (!this.serializeInt({ value: length }, 0, bufferSize - 1)) {
      return false;
    }
    return this.#measure(length * 32);
  }

  /**
   * Measures an align as the conservative worst case: 7 bits, always. The
   * true pad depends on where the message lands in the final bit stream,
   * which a measure does not know.
   * @returns {boolean} true on success.
   */
  serializeAlign() {
    return this.#measure(this.alignBits());
  }

  /**
   * The worst case align of 7 bits. The number of bits required for
   * alignment depends on where the message lands in the final bit stream,
   * so the measurement is conservative.
   */
  alignBits() {
    return 7;
  }

  /** The number of bits measured so far. */
  bitsProcessed() {
    return this.#bitsWritten;
  }

  /** The number of bits measured so far, rounded up to the next byte. */
  bytesProcessed() {
    return Math.ceil(this.#bitsWritten / 8);
  }

  /** The first error latched on the stream, or SerializeError.None (null). */
  get error() {
    return this.#error;
  }

  /** True while no error is latched. */
  get ok() {
    return this.#error === SerializeError.None;
  }
}
