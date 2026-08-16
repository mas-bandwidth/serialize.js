// The bitpacker: the wire's foundation.
//
// BitWriter packs unsigned integer values into a buffer as a little-endian
// bit stream, least-significant-bit first, exactly as specified by STANDARD.md
// and byte-identical to the C++, C, Go, C# and Rust implementations.
//
// The scratch is the family's 64-bit accumulator, carried here as two 32-bit
// lanes (lo, hi) because JavaScript bitwise arithmetic is 32-bit. BigInt never
// touches this hot path. When the scratch fills to 64 bits it is stored to the
// buffer as two little-endian 32-bit words -- the same eight bytes the other
// implementations store as one qword -- and the bits that spilled past 64
// carry over into the next scratch.
//
// Checks run in every build (JavaScript has no compile-out): like the Go port,
// writes keep their checks and throw on caller error -- the write path is
// trusted, so a violated writer contract is a bug in the caller, not data to
// be tolerated. The read side is different: the wire is a trust boundary, and
// hostile input never throws. See BitReader.
//
// Bit counts are Numbers, exact to 2^53: buffers cannot get near that.

const BUFFER_TYPE_MESSAGE = 'buffer must be a Uint8Array';
const BUFFER_BYTES_MESSAGE = 'buffer size must be a multiple of 8 bytes';
const BITS_RANGE_MESSAGE = 'bits must be an integer in [1,32]';
const VALUE_TYPE_MESSAGE = 'value must be a number';
const WRITE_OVERFLOW_MESSAGE = 'write past the end of the buffer';

/**
 * Bitpacks unsigned integer values to a buffer.
 *
 * The buffer size must be a multiple of 8 bytes, because the writer stores
 * scratch words to memory 8 bytes at a time. Bytes past the end of the
 * written data are only ever written as zeros: the flushed scratch beyond
 * the bit index is zero, so trailing bits are zero by construction, as the
 * standard obliges writers to guarantee.
 *
 * IMPORTANT: When you have finished writing, call flushBits(), otherwise the
 * last word of data will not get flushed to memory.
 */
export class BitWriter {
  #data; // Uint8Array
  #view; // DataView over the same range
  #scratchLo; // low 32 bits of the 64-bit scratch (uint32)
  #scratchHi; // high 32 bits of the 64-bit scratch (uint32)
  #scratchBits; // number of valid bits in scratch, in [0,63]
  #numBits; // buffer capacity in bits
  #bitsWritten; // bits written so far
  #wordIndex; // next 8-byte word flushes to data[wordIndex*8]

  /**
   * Creates a bit writer that fills the given buffer with bitpacked data.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  constructor(buffer) {
    this.reset(buffer);
  }

  /**
   * Points the writer at a buffer and clears all write state, allowing a
   * single writer to be reused without allocation.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  reset(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError(BUFFER_TYPE_MESSAGE);
    }
    if (buffer.length % 8 !== 0) {
      throw new RangeError(BUFFER_BYTES_MESSAGE);
    }
    this.#data = buffer;
    this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.#scratchLo = 0;
    this.#scratchHi = 0;
    this.#scratchBits = 0;
    this.#numBits = buffer.length * 8;
    this.#bitsWritten = 0;
    this.#wordIndex = 0;
  }

  /**
   * Writes the low order bits of value to the buffer, without padding to the
   * nearest byte. A boolean writes just 1 bit, a value in [0,31] writes in 5
   * bits, and so on. bits must be in [1,32]. value is converted to uint32;
   * bits of value above the count are ignored, as in the Go and C# ports
   * (their uint32 parameter type performs the same conversion at the call
   * site). Throws if the write would go past the end of the buffer.
   */
  writeBits(value, bits) {
    if ((bits | 0) !== bits || bits < 1 || bits > 32) {
      throw new RangeError(BITS_RANGE_MESSAGE);
    }
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (this.#bitsWritten + bits > this.#numBits) {
      throw new RangeError(WRITE_OVERFLOW_MESSAGE);
    }

    // mask to the bit count: bits of value above the count are ignored
    value = bits === 32 ? value >>> 0 : (value & (((1 << bits) >>> 0) - 1)) >>> 0;

    // merge into the two-lane scratch at the current bit position. JavaScript
    // shifts are mod 32, so every shift below is kept in [0,31] by the guards.
    const s = this.#scratchBits;
    if (s < 32) {
      this.#scratchLo = (this.#scratchLo | (value << s)) >>> 0;
      if (s > 0) {
        // the part of value that crosses the 32-bit lane boundary
        this.#scratchHi = (this.#scratchHi | (value >>> (32 - s))) >>> 0;
      }
    } else {
      // the part that crosses the 64-bit boundary is discarded by the 32-bit
      // shift here and recovered from value after the flush below
      this.#scratchHi = (this.#scratchHi | (value << (s - 32))) >>> 0;
    }

    const newScratchBits = s + bits;

    if (newScratchBits >= 64) {
      // the scratch is full: store it as two little-endian 32-bit words, the
      // same eight bytes the other implementations store as one qword
      const base = this.#wordIndex * 8;
      this.#view.setUint32(base, this.#scratchLo, true);
      this.#view.setUint32(base + 4, this.#scratchHi, true);
      this.#wordIndex++;
      // recover the bits that spilled past 64. newScratchBits >= 64 with
      // bits <= 32 implies s >= 32, so the shift is in [1,32]; at exactly 32
      // nothing spilled (a JavaScript shift of 32 would be a shift of 0).
      const shift = 64 - s;
      this.#scratchLo = shift >= 32 ? 0 : value >>> shift;
      this.#scratchHi = 0;
      this.#scratchBits = newScratchBits - 64;
    } else {
      this.#scratchBits = newScratchBits;
    }

    this.#bitsWritten += bits;
  }

  /**
   * Pads the bit stream with zeros so the bit index becomes a multiple of 8.
   * If the current bit index is already a multiple of 8, nothing is written.
   */
  writeAlign() {
    const remainderBits = this.#bitsWritten % 8;
    if (remainderBits !== 0) {
      this.writeBits(0, 8 - remainderBits);
    }
  }

  /**
   * Flushes any remaining bits in the scratch to memory. Call this once after
   * you have finished writing bits. The flush stores a full 8-byte word: the
   * buffer size is a multiple of 8 so this stays in bounds, and bytes past
   * the written data are only ever written as zeros.
   *
   * flushBits ends the write: writing more bits after a mid-stream flush
   * corrupts the stream, because the flushed partial word cannot be resumed.
   */
  flushBits() {
    if (this.#scratchBits !== 0) {
      const base = this.#wordIndex * 8;
      this.#view.setUint32(base, this.#scratchLo, true);
      this.#view.setUint32(base + 4, this.#scratchHi, true);
      this.#scratchLo = 0;
      this.#scratchHi = 0;
      this.#scratchBits = 0;
      this.#wordIndex++;
    }
  }

  /**
   * The number of align bits that would be written, if an align was written
   * right now: in [0,7], where 0 means the stream is already byte aligned.
   */
  alignBits() {
    return (8 - (this.#bitsWritten % 8)) % 8;
  }

  /** The number of bits written so far. */
  bitsWritten() {
    return this.#bitsWritten;
  }

  /** The number of bits still available to write. */
  bitsAvailable() {
    return this.#numBits - this.#bitsWritten;
  }

  /**
   * The number of bytes flushed to memory: the bits written rounded up to the
   * next byte. This is the size of the packet to send after bitpacking.
   *
   * IMPORTANT: Call flushBits() first, otherwise you risk missing the last
   * word of data.
   */
  bytesWritten() {
    return Math.ceil(this.#bitsWritten / 8);
  }

  /**
   * The written portion of the buffer: a subarray view of the first
   * bytesWritten() bytes of the buffer passed to the writer (not a copy).
   *
   * IMPORTANT: Call flushBits() first, otherwise you risk missing the last
   * word of data.
   */
  data() {
    return this.#data.subarray(0, this.bytesWritten());
  }
}
