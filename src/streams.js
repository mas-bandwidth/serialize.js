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

const BITS_RANGE_MESSAGE = 'bits must be an integer in [1,32]';

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
    if (this.#error !== SerializeError.None) {
      return false;
    }
    if (bits > this.#writer.bitsAvailable()) {
      return this.#fail(SerializeError.Overflow);
    }
    this.#writer.writeBits(ref.value, bits);
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
 * A measure refuses nothing at runtime: nothing it sees came off a network.
 * No operation in the current surface can latch an error on a measure
 * stream; the error surface exists so unified serialize functions can check
 * ok on any stream uniformly.
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
