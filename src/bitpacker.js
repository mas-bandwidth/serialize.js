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
// The writer ships in two variants, selected once at module load on NODE_ENV
// (see mode.js): CheckedBitWriter -- the development default -- validates
// every caller contract and throws on caller error, and ProductionBitWriter
// carries the family's release shape: the caller is responsible for
// well-formed writes (STANDARD.md, "Writes assume trusted data"), so the
// per-operation caller validation is gone and only tryWriteBits's buffer-end
// check remains -- the one write-path check the writer-trusted model keeps,
// because its false is the stream layer's sticky Overflow. The read side is
// different in EVERY mode: the wire is a trust boundary, and hostile input
// never throws. See BitReader.
//
// Bit counts are Numbers, exact to 2^53: buffers cannot get near that.

import { PRODUCTION } from './mode.js';

const BUFFER_TYPE_MESSAGE = 'buffer must be a Uint8Array';
const BUFFER_BYTES_MESSAGE = 'buffer size must be a multiple of 8 bytes';
const BITS_RANGE_MESSAGE = 'bits must be an integer in [1,32]';
const VALUE_TYPE_MESSAGE = 'value must be a number';
const WRITE_OVERFLOW_MESSAGE = 'write past the end of the buffer';
const READ_OVERFLOW_MESSAGE = 'read past the end of the buffer';
const DATA_TYPE_MESSAGE = 'data must be a Uint8Array';
const BYTES_COUNT_MESSAGE = 'bytes must be a non-negative integer';
const WRITE_UNALIGNED_MESSAGE = 'writeBytes requires a byte-aligned bit index';
const READ_UNALIGNED_MESSAGE = 'readBytes requires a byte-aligned bit index';

// Data at or below this size is copied into the reader's persistent scratch
// at reset and windowed through the persistent scratch view, so reset
// allocates nothing: at packet sizes the per-reset DataView allocation is
// the dominant cost of a read, several times the bulk copy that replaces
// it. Above the threshold -- where resets amortize to nothing and a copy
// would scale with the data -- the buffer is wrapped directly, with the
// wrap skipped when reset gets the identical array back.
const SMALL_READ_BYTES = 64;

// Bulk byte copies at or below this size go through a manual byte loop
// instead of subarray-plus-set: at packet sizes the subarray view
// allocation dominates the copy it feeds. Above it, the bulk set's
// memcpy wins and the one-off view amortizes to nothing.
const SMALL_COPY_BYTES = 64;

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
 *
 * This is the CHECKED variant (the development default): every caller
 * contract is validated and misuse throws. ProductionBitWriter below is the
 * same wire without the validation; mode.js selects which one exports as
 * BitWriter.
 */
class CheckedBitWriter {
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
   * single writer to be reused without allocation. Resetting to the SAME
   * buffer -- the reuse pattern this method exists for -- reuses the
   * existing DataView instead of wrapping a new one: the view is a pure
   * function of the buffer identity (same memory, same offset, same
   * length), so skipping the re-wrap changes nothing but the allocation.
   * A resized buffer (a length-tracking view over a resizable ArrayBuffer)
   * changes byteLength under the same identity, so the guard checks both.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  reset(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError(BUFFER_TYPE_MESSAGE);
    }
    if (buffer.length % 8 !== 0) {
      throw new RangeError(BUFFER_BYTES_MESSAGE);
    }
    if (buffer !== this.#data || buffer.byteLength !== this.#view.byteLength) {
      this.#data = buffer;
      this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
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
   *
   * The core below the checks is duplicated in tryWriteBits and in both
   * ProductionBitWriter entries -- fused into each public entry because V8
   * was not inlining a shared private core across the call layer, and the
   * wrapper call cost was measurable on every hot row. KEEP THE FOUR
   * COPIES IDENTICAL.
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
   * Writes bits, refusing a past-end write as a value: returns true on
   * success, or false -- writing nothing -- if the write would go past the
   * end of the buffer. The write-side mirror of tryReadBits, and the single
   * bounds check on the stream layer's hot path: the stream refuses the
   * false as its Overflow without a second check anywhere. bits must be in
   * [1,32] and value a number -- caller contracts, and violating them
   * throws.
   *
   * The core below the checks is a fused copy of writeBits's core: KEEP THE
   * FOUR COPIES IDENTICAL (see writeBits).
   */
  tryWriteBits(value, bits) {
    if ((bits | 0) !== bits || bits < 1 || bits > 32) {
      throw new RangeError(BITS_RANGE_MESSAGE);
    }
    if (typeof value !== 'number') {
      throw new TypeError(VALUE_TYPE_MESSAGE);
    }
    if (this.#bitsWritten + bits > this.#numBits) {
      return false;
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
    return true;
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
   * Writes an array of bytes to the bit stream: the aligned bulk copy under
   * serialize_bytes. The bit index must be byte aligned (write an align
   * first) and the write must fit the buffer -- both are caller contracts
   * and violating them throws, like every writer contract in this class.
   *
   * Faster than writing each byte via writeBits(value, 8): single bytes go
   * through the scratch only until the write cursor reaches a 64-bit word
   * boundary -- where the scratch is empty by the writer's invariant -- then
   * whole words bulk copy directly into the buffer, and the final partial
   * word of bytes goes through the scratch again. The wire is identical to
   * writing every byte with writeBits(value, 8).
   * @param {Uint8Array} data the bytes to write, in order.
   */
  writeBytes(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(DATA_TYPE_MESSAGE);
    }
    if (this.#bitsWritten % 8 !== 0) {
      throw new RangeError(WRITE_UNALIGNED_MESSAGE);
    }
    const bytes = data.length;
    if (this.#bitsWritten + bytes * 8 > this.#numBits) {
      throw new RangeError(WRITE_OVERFLOW_MESSAGE);
    }

    // head: single bytes through the scratch until the cursor reaches a word
    // boundary, or the data runs out first
    let headBytes = (8 - ((this.#bitsWritten % 64) / 8)) % 8;
    if (headBytes > bytes) {
      headBytes = bytes;
    }
    for (let i = 0; i < headBytes; i++) {
      this.writeBits(data[i], 8);
    }
    if (headBytes === bytes) {
      return;
    }

    // at the word boundary the scratch is empty (scratchBits tracks
    // bitsWritten % 64, and the write that filled bit 64 flushed it with a
    // zero spill): whole words bulk copy straight into the buffer. At
    // packet-sized counts a manual byte loop beats subarray-plus-set --
    // the subarray view allocation dominates the copy -- while large
    // counts keep the bulk set, which scales.
    const numWords = Math.floor((bytes - headBytes) / 8);
    if (numWords > 0) {
      const wordBytes = numWords * 8;
      if (wordBytes <= SMALL_COPY_BYTES) {
        const dst = this.#data;
        const dstBase = this.#wordIndex * 8;
        for (let i = 0; i < wordBytes; i++) {
          dst[dstBase + i] = data[headBytes + i];
        }
      } else {
        this.#data.set(data.subarray(headBytes, headBytes + wordBytes), this.#wordIndex * 8);
      }
      this.#bitsWritten += numWords * 64;
      this.#wordIndex += numWords;
    }

    // tail: the remaining bytes, fewer than 8, through the scratch
    const tailStart = headBytes + numWords * 8;
    for (let i = tailStart; i < bytes; i++) {
      this.writeBits(data[i], 8);
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

/**
 * The PRODUCTION variant of the bit writer: the same wire as
 * CheckedBitWriter with the caller validation removed -- the family's
 * release shape (STANDARD.md, "Writes assume trusted data": the caller is
 * responsible for well-formed writes, and release builds carry zero caller
 * validation on the write path). mode.js selects this class as BitWriter
 * when NODE_ENV is 'production' at module load.
 *
 * What remains is exactly what the writer-trusted model keeps hard:
 *
 * - tryWriteBits keeps its buffer-end check. Its false is the stream
 *   layer's sticky Overflow refusal: a message that does not fit the buffer
 *   is a runtime condition, not a caller bug, so the overflow contract
 *   latches identically in both modes.
 * - The value mask stays in both entries: bits of the value above the count
 *   are IGNORED by documented semantics (the Go/C# uint32 conversion), so
 *   the mask is wire arithmetic, not validation.
 *
 * Everything else -- bits an integer in [1,32], a Number value, capacity
 * for the trusted writeBits, a byte-aligned cursor and in-bounds span for
 * writeBytes, a Uint8Array buffer whose length is a multiple of 8 -- is the
 * caller's contract, validated only by the CHECKED variant. Violating it
 * here produces garbage on the wire, never memory unsafety: a past-end
 * write lands in DataView word stores that throw RangeError at the buffer
 * boundary (or typed-array byte stores that drop), so the buffer's
 * neighbors cannot be corrupted. That native backstop is JavaScript's
 * memory safety, not an API contract -- what misuse produces is
 * unspecified beyond being memory safe, exactly as the C release build
 * owes a misbehaving writer nothing.
 */
class ProductionBitWriter {
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
   * Points the writer at a buffer and clears all write state: the checked
   * reset without the buffer validation (the type and length-multiple
   * contracts are the caller's). The DataView identity cache is unchanged.
   * @param {Uint8Array} buffer destination; length must be a multiple of 8.
   */
  reset(buffer) {
    if (buffer !== this.#data || buffer.byteLength !== this.#view.byteLength) {
      this.#data = buffer;
      this.#view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    this.#scratchLo = 0;
    this.#scratchHi = 0;
    this.#scratchBits = 0;
    this.#numBits = buffer.length * 8;
    this.#bitsWritten = 0;
    this.#wordIndex = 0;
  }

  /**
   * Writes the low order bits of value: the trusted entry, all contracts
   * the caller's -- bits in [1,32], value a Number, the write within
   * capacity (size with a measure stream, or use the stream layer, which
   * bounds checks through tryWriteBits and never calls this past the end).
   *
   * The body is the fused core of CheckedBitWriter.writeBits with the
   * checks removed: KEEP THE FOUR COPIES IDENTICAL (see writeBits there).
   */
  writeBits(value, bits) {
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
   * Writes bits, refusing a past-end write as a value: returns true on
   * success, or false -- writing nothing -- if the write would go past the
   * end of the buffer. THE RETAINED HARD CHECK of the production write
   * path: the stream layer's sticky Overflow latches off this false, in
   * both modes identically. bits in [1,32] and a Number value remain the
   * caller's contract, unvalidated here.
   *
   * The body below the bounds check is the fused core: KEEP THE FOUR
   * COPIES IDENTICAL (see CheckedBitWriter.writeBits).
   */
  tryWriteBits(value, bits) {
    if (this.#bitsWritten + bits > this.#numBits) {
      return false;
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
    return true;
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
   * Writes an array of bytes: CheckedBitWriter.writeBytes without the
   * caller validation -- a Uint8Array, a byte-aligned bit index and a span
   * that fits the buffer are the caller's contract (the stream layer aligns
   * and bounds checks before calling). The copy structure is identical:
   * head bytes through the scratch to the word boundary, whole words bulk
   * copied, tail bytes through the scratch.
   * @param {Uint8Array} data the bytes to write, in order.
   */
  writeBytes(data) {
    const bytes = data.length;

    // head: single bytes through the scratch until the cursor reaches a word
    // boundary, or the data runs out first
    let headBytes = (8 - ((this.#bitsWritten % 64) / 8)) % 8;
    if (headBytes > bytes) {
      headBytes = bytes;
    }
    for (let i = 0; i < headBytes; i++) {
      this.writeBits(data[i], 8);
    }
    if (headBytes === bytes) {
      return;
    }

    // at the word boundary the scratch is empty (scratchBits tracks
    // bitsWritten % 64, and the write that filled bit 64 flushed it with a
    // zero spill): whole words bulk copy straight into the buffer. At
    // packet-sized counts a manual byte loop beats subarray-plus-set --
    // the subarray view allocation dominates the copy -- while large
    // counts keep the bulk set, which scales.
    const numWords = Math.floor((bytes - headBytes) / 8);
    if (numWords > 0) {
      const wordBytes = numWords * 8;
      if (wordBytes <= SMALL_COPY_BYTES) {
        const dst = this.#data;
        const dstBase = this.#wordIndex * 8;
        for (let i = 0; i < wordBytes; i++) {
          dst[dstBase + i] = data[headBytes + i];
        }
      } else {
        this.#data.set(data.subarray(headBytes, headBytes + wordBytes), this.#wordIndex * 8);
      }
      this.#bitsWritten += numWords * 64;
      this.#wordIndex += numWords;
    }

    // tail: the remaining bytes, fewer than 8, through the scratch
    const tailStart = headBytes + numWords * 8;
    for (let i = tailStart; i < bytes; i++) {
      this.writeBits(data[i], 8);
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

/**
 * The bit writer, selected once at module load (see mode.js): the CHECKED
 * variant by default, the PRODUCTION variant when NODE_ENV is 'production'.
 * The wire is identical in both; the difference is caller validation.
 */
export const BitWriter = PRODUCTION ? ProductionBitWriter : CheckedBitWriter;

/**
 * Reads bitpacked integer values from a buffer.
 *
 * The reader relies on the user reconstructing the exact same set of bit
 * reads as bit writes when the buffer was written: this is an unattributed
 * bitpacked binary stream.
 *
 * Any buffer size is supported, and the reader prices its 64-bit windows
 * INSIDE the buffer, like the C implementation: within the first bytes-8 of
 * the buffer a window is a direct two-word load at the current byte; past
 * that it would run off the end, so reset() assembles the final window up
 * front from the bytes that are there, and every read in the last 8 bytes
 * shifts that instead. THE CALLER'S ALLOCATION CONTRACT IS THEREFORE EMPTY:
 * no slack past the data is required, unlike the C++ reader, which loads
 * unconditionally and demands 8 bytes beyond the data. STANDARD.md declares
 * both stances conforming, because loaded-but-uninterpreted bytes can never
 * influence a decoded value or an accept/reject decision -- here nothing past
 * the data is even loaded.
 *
 * The wire is a trust boundary. The refusal surface -- wouldReadPastEnd(),
 * tryReadBits(), readAlign() -- never throws on hostile data: past-end reads
 * and nonzero align padding are refused as values. readBits() itself throws
 * on a past-end read, exactly like the Go port's checked ReadBits: it is the
 * trusted-caller form, for callers that have already bounds checked (the
 * stream layer checks first and never triggers it).
 */
export class BitReader {
  #data; // Uint8Array
  #view; // DataView windows load through: #largeView or #scratchView
  #largeView; // DataView over #viewData's range (data above the threshold)
  #viewData; // the Uint8Array #largeView wraps, for the identity cache
  #scratch; // persistent copy destination for data at or below the threshold
  #scratchView; // persistent DataView over #scratch, allocated once
  #numBits; // data length in bits
  #bitsRead; // bits read so far
  #tailBase; // byte index the tail window starts at
  #tailLo; // low 32 bits of the final window, assembled at reset (uint32)
  #tailHi; // high 32 bits of the final window (uint32)

  /**
   * Creates a bit reader over the bitpacked data in the given array. Any
   * length is supported, and no slack past the data is required.
   * @param {Uint8Array} data the bitpacked data to read.
   */
  constructor(data) {
    this.#scratch = new Uint8Array(SMALL_READ_BYTES);
    this.#scratchView = new DataView(this.#scratch.buffer);
    this.reset(data);
  }

  /**
   * Points the reader at a data array and clears all read state, allowing a
   * single reader to be reused without allocation. Assembles the final
   * window: see the class comment. The data must not change while the
   * reader is reading it.
   * @param {Uint8Array} data the bitpacked data to read.
   */
  reset(data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(BUFFER_TYPE_MESSAGE);
    }
    const bytes = data.length;
    this.#data = data;
    this.#numBits = bytes * 8;
    this.#bitsRead = 0;
    if (bytes >= 8) {
      this.#tailBase = bytes - 8;
      if (bytes <= SMALL_READ_BYTES) {
        // small data: copy it into the persistent scratch and window
        // through the persistent scratch view -- no allocation, and the
        // copy IS the reset-time snapshot of the data's content (the data
        // must not change while the reader is reading it, per the class
        // contract, so the snapshot is invisible)
        this.#scratch.set(data);
        this.#view = this.#scratchView;
      } else {
        // large data: wrap it directly, reusing the existing view when
        // reset gets the identical array back -- the view is a pure
        // function of the array identity, so only the identity (or a
        // resized length under the same identity) forces a re-wrap
        if (data !== this.#viewData || data.byteLength !== this.#largeView.byteLength) {
          this.#viewData = data;
          this.#largeView = new DataView(data.buffer, data.byteOffset, data.byteLength);
        }
        this.#view = this.#largeView;
      }
      // the tail window is re-assembled on EVERY reset: it depends on the
      // data's CONTENT, which may have changed under the same identity
      this.#tailLo = this.#view.getUint32(bytes - 8, true);
      this.#tailHi = this.#view.getUint32(bytes - 4, true);
    } else {
      // a buffer shorter than 8 bytes is entirely in the tail window,
      // zero padded. Shifting from the low byte up IS the wire order.
      this.#tailBase = 0;
      let lo = 0;
      let hi = 0;
      if (bytes > 0) lo |= data[0];
      if (bytes > 1) lo |= data[1] << 8;
      if (bytes > 2) lo |= data[2] << 16;
      if (bytes > 3) lo |= data[3] << 24;
      if (bytes > 4) hi |= data[4];
      if (bytes > 5) hi |= data[5] << 8;
      if (bytes > 6) hi |= data[6] << 16;
      this.#tailLo = lo >>> 0;
      this.#tailHi = hi >>> 0;
    }
  }

  /**
   * The unchecked hot path shared by readBits, tryReadBits and readAlign,
   * which perform their own validation first. bits must be in [1,32] and
   * must not read past the end of the data.
   *
   * One branch selects the window source, then shift and mask. In the tail,
   * the bounds check already performed by the caller guarantees the whole
   * read fits the assembled window: shift + bits <= 64.
   */
  #read(bits) {
    const bitsRead = this.#bitsRead;
    const byteIndex = Math.floor(bitsRead / 8);

    let out;
    if (byteIndex < this.#tailBase) {
      // inside the buffer: a direct two-word little-endian window load
      // (through the scratch snapshot for small data -- same bytes, same
      // indices). byteIndex + 8 <= numBytes - 1 here, so the load never
      // runs off the end, and the shift is the bit remainder, in [0,7].
      const lo = this.#view.getUint32(byteIndex, true);
      const hi = this.#view.getUint32(byteIndex + 4, true);
      const s = bitsRead & 7;
      out = s === 0 ? lo : (lo >>> s) | (hi << (32 - s));
    } else {
      // the last 8 bytes: the window assembled at reset, shifted to where
      // this read starts. The shift is in [0,63].
      const s = bitsRead - this.#tailBase * 8;
      if (s === 0) {
        out = this.#tailLo;
      } else if (s < 32) {
        out = (this.#tailLo >>> s) | (this.#tailHi << (32 - s));
      } else {
        out = this.#tailHi >>> (s - 32);
      }
    }

    this.#bitsRead = bitsRead + bits;

    return bits === 32 ? out >>> 0 : (out & (((1 << bits) >>> 0) - 1)) >>> 0;
  }

  /**
   * Would reading the given number of bits read past the end of the data?
   */
  wouldReadPastEnd(bits) {
    return this.#bitsRead + bits > this.#numBits;
  }

  /**
   * Reads bits from the buffer and returns the integer value read, in range
   * [0,(1<<bits)-1]. bits must be in [1,32]. Throws if the read would go
   * past the end of the data: this is the trusted-caller form -- check
   * wouldReadPastEnd() first, or use tryReadBits(), when the data is
   * untrusted.
   */
  readBits(bits) {
    if ((bits | 0) !== bits || bits < 1 || bits > 32) {
      throw new RangeError(BITS_RANGE_MESSAGE);
    }
    if (this.#bitsRead + bits > this.#numBits) {
      throw new RangeError(READ_OVERFLOW_MESSAGE);
    }
    return this.#read(bits);
  }

  /**
   * Reads bits from the buffer, refusing a past-end read as a value: returns
   * the integer read, or undefined if the read would go past the end of the
   * data. Never throws on hostile data. bits must be in [1,32] -- that is
   * still the caller's contract, and violating it throws.
   */
  tryReadBits(bits) {
    if ((bits | 0) !== bits || bits < 1 || bits > 32) {
      throw new RangeError(BITS_RANGE_MESSAGE);
    }
    if (this.#bitsRead + bits > this.#numBits) {
      return undefined;
    }
    return this.#read(bits);
  }

  /**
   * Reads an align, corresponding to a writeAlign call when the buffer was
   * written, and skips ahead to the next byte boundary. Verifies that the
   * padding bits are zero, as the standard requires, and returns false if
   * they are not -- which typically aborts the read. Never throws: nonzero
   * padding is hostile data, not caller error. If the bit index is already
   * a multiple of 8, nothing is read.
   */
  readAlign() {
    const remainderBits = this.#bitsRead % 8;
    if (remainderBits !== 0) {
      // this cannot read past the end: numBits is a multiple of 8, so an
      // unaligned bit index is always strictly inside the final byte
      const value = this.#read(8 - remainderBits);
      if (value !== 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Reads bytes from the bitpacked data: the aligned bulk read under
   * serialize_bytes, corresponding to a writeBytes call when the buffer was
   * written. Returns a subarray VIEW of the reader's data (not a copy),
   * valid as long as the underlying data is: copy it if you need it past
   * the next reset. The bit index must be byte aligned (read an align
   * first), bytes must be a non-negative integer, and the read must not
   * pass the end of the data -- caller contracts, and violating them throws:
   * this is the trusted-caller form, like readBits. The stream layer bounds
   * checks first and refuses as a value.
   * @param {number} bytes the number of bytes to read.
   * @returns {Uint8Array} a view of the bytes read.
   */
  readBytes(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(BYTES_COUNT_MESSAGE);
    }
    if (this.#bitsRead % 8 !== 0) {
      throw new RangeError(READ_UNALIGNED_MESSAGE);
    }
    if (this.#bitsRead + bytes * 8 > this.#numBits) {
      throw new RangeError(READ_OVERFLOW_MESSAGE);
    }
    // the bit index is byte aligned, so this is a straight view of the data
    const byteIndex = this.#bitsRead / 8;
    this.#bitsRead += bytes * 8;
    return this.#data.subarray(byteIndex, byteIndex + bytes);
  }

  /**
   * Reads dest.length bytes from the bitpacked data INTO dest: the copy-in
   * twin of readBytes, for callers that already own the destination array
   * -- at packet-sized counts a manual byte loop into dest beats the
   * subarray view readBytes would allocate, and large counts bulk copy
   * with set, which scales. Same contracts as readBytes: the bit index
   * must be byte aligned, dest must be a Uint8Array, and the read must not
   * pass the end of the data -- caller contracts, and violating them
   * throws (the trusted-caller form; the stream layer bounds checks first
   * and refuses as a value, with dest untouched on refusal).
   * @param {Uint8Array} dest destination; its length is the byte count.
   */
  readBytesInto(dest) {
    if (!(dest instanceof Uint8Array)) {
      throw new TypeError(DATA_TYPE_MESSAGE);
    }
    if (this.#bitsRead % 8 !== 0) {
      throw new RangeError(READ_UNALIGNED_MESSAGE);
    }
    const bytes = dest.length;
    if (this.#bitsRead + bytes * 8 > this.#numBits) {
      throw new RangeError(READ_OVERFLOW_MESSAGE);
    }
    // the bit index is byte aligned, so this is a straight copy of the data
    const byteIndex = this.#bitsRead / 8;
    const data = this.#data;
    if (bytes <= SMALL_COPY_BYTES) {
      for (let i = 0; i < bytes; i++) {
        dest[i] = data[byteIndex + i];
      }
    } else {
      dest.set(data.subarray(byteIndex, byteIndex + bytes));
    }
    this.#bitsRead += bytes * 8;
  }

  /**
   * The number of align bits that would be read, if an align was read right
   * now: in [0,7], where 0 means the stream is already byte aligned.
   */
  alignBits() {
    return (8 - (this.#bitsRead % 8)) % 8;
  }

  /** The number of bits read from the buffer so far. */
  bitsRead() {
    return this.#bitsRead;
  }

  /** The number of bits still available to read. */
  bitsRemaining() {
    return this.#numBits - this.#bitsRead;
  }
}
