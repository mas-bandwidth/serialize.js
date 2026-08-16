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

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;
const MASK32 = 0xffffffffn;

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
   * Measures a bool: 1 bit. ref is ignored.
   * @param {{value: boolean}} ref ignored.
   * @returns {boolean} true on success.
   */
  serializeBool(ref) {
    return this.#measure(1);
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
