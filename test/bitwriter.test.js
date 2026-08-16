// BitWriter tests: known byte sequences derived by hand, unaligned flush
// shapes, trailing-bit zeroing by construction, and the caller-error checks
// the family keeps in every build.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter } from '../src/index.js';

test('known sequence A: 1+7+8 bits inside one byte pair', () => {
  // writeBits(1,1); writeBits(42,7); writeBits(0xFF,8)
  //
  // Derivation. Bits are packed LSB-first:
  //   bit 0            = 1
  //   bits 1..7        = 42 = 0101010b
  //     byte 0 = 1 | 42 << 1 = 1 + 84 = 85 = 0x55
  //   bits 8..15       = 0xFF
  //     byte 1 = 0xFF
  // 16 bits -> 2 bytes on the wire: 55 FF
  const buffer = new Uint8Array(8);
  const writer = new BitWriter(buffer);
  writer.writeBits(1, 1);
  writer.writeBits(42, 7);
  writer.writeBits(0xff, 8);
  writer.flushBits();
  assert.equal(writer.bitsWritten(), 16);
  assert.equal(writer.bytesWritten(), 2);
  assert.deepEqual(Array.from(writer.data()), [0x55, 0xff]);
  // the rest of the buffer holds only flushed zeros
  assert.deepEqual(Array.from(buffer.subarray(2)), [0, 0, 0, 0, 0, 0]);
});

test('known sequence B: two full words then one bit into the next word', () => {
  // writeBits(0xDEADBEEF,32); writeBits(0x12345678,32); writeBits(1,1)
  //
  // Derivation. The first 32-bit group occupies bits 0..31, stored little
  // endian: bytes 0..3 = EF BE AD DE. The second occupies bits 32..63:
  // bytes 4..7 = 78 56 34 12. That fills the 64-bit scratch exactly (the
  // qword flushes with zero spill). The final 1 bit lands at bit 64:
  // byte 8 = 01. 65 bits -> 9 bytes on the wire.
  const buffer = new Uint8Array(16);
  const writer = new BitWriter(buffer);
  writer.writeBits(0xdeadbeef, 32);
  writer.writeBits(0x12345678, 32);
  writer.writeBits(1, 1);
  writer.flushBits();
  assert.equal(writer.bitsWritten(), 65);
  assert.equal(writer.bytesWritten(), 9);
  assert.deepEqual(
    Array.from(writer.data()),
    [0xef, 0xbe, 0xad, 0xde, 0x78, 0x56, 0x34, 0x12, 0x01],
  );
});

test('known sequence C: a value straddling the 64-bit scratch boundary', () => {
  // writeBits(0,32); writeBits(0,30); writeBits(0b101,3)
  //
  // Derivation. 62 zero bits, then value 5 = 101b at bits 62..64 LSB-first:
  //   bit 62 = 1, bit 63 = 0, bit 64 = 1
  // Byte 7 holds bits 56..63: only bit 62 is set -> 0x40.
  // Byte 8 holds bit 64 in its bit 0 -> 0x01.
  // 65 bits -> 9 bytes: 00 00 00 00 00 00 00 40 01
  // This exercises the spill: the write crosses 64 bits mid-value, so the
  // low two bits of the value complete the first qword and the third bit
  // carries into the next scratch.
  const buffer = new Uint8Array(16);
  const writer = new BitWriter(buffer);
  writer.writeBits(0, 32);
  writer.writeBits(0, 30);
  writer.writeBits(0b101, 3);
  writer.flushBits();
  assert.equal(writer.bitsWritten(), 65);
  assert.equal(writer.bytesWritten(), 9);
  assert.deepEqual(Array.from(writer.data()), [0, 0, 0, 0, 0, 0, 0, 0x40, 0x01]);
});

test('known sequence E: mixed widths at odd offsets', () => {
  // writeBits(1,1); writeBits(27,5); writeBits(0x3FF,10); writeBits(0xABCDE,20)
  //
  // Derivation. LSB-first:
  //   bit 0       = 1
  //   bits 1..5   = 27 = 11011b -> bit1=1 bit2=1 bit3=0 bit4=1 bit5=1
  //   bits 6..15  = 0x3FF (ten ones) -> bits 6..15 all 1
  //   byte 0 = bits 0..7 = 1+2+4+0+16+32+64+128 = 0xF7
  //   byte 1 = bits 8..15 = 0xFF
  //   bits 16..35 = 0xABCDE, little endian from bit 16:
  //   byte 2 = 0xDE, byte 3 = 0xBC, byte 4 = low nibble 0xA -> 0x0A
  //   (bits 36..39 are trailing zeros)
  // 36 bits -> 5 bytes: F7 FF DE BC 0A
  const buffer = new Uint8Array(8);
  const writer = new BitWriter(buffer);
  writer.writeBits(1, 1);
  writer.writeBits(27, 5);
  writer.writeBits(0x3ff, 10);
  writer.writeBits(0xabcde, 20);
  writer.flushBits();
  assert.equal(writer.bitsWritten(), 36);
  assert.equal(writer.bytesWritten(), 5);
  assert.deepEqual(Array.from(writer.data()), [0xf7, 0xff, 0xde, 0xbc, 0x0a]);
});

test('unaligned flush shapes: trailing bits are zero by construction', () => {
  // Write all-one bits to every total in the interesting shapes, flush, and
  // check the final byte: its bits past the bit index must be zero, so the
  // last byte of an all-ones stream of n bits is 0xFF >> (8 - n%8) when n%8
  // is nonzero and 0xFF when the stream ends aligned.
  const shapes = [1, 3, 7, 8, 9, 31, 32, 33, 63, 64, 65, 127];
  for (const totalBits of shapes) {
    const buffer = new Uint8Array(16);
    const writer = new BitWriter(buffer);
    let remaining = totalBits;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 32);
      writer.writeBits(0xffffffff, chunk);
      remaining -= chunk;
    }
    writer.flushBits();
    const bytes = Math.ceil(totalBits / 8);
    assert.equal(writer.bitsWritten(), totalBits, `bits at ${totalBits}`);
    assert.equal(writer.bytesWritten(), bytes, `bytes at ${totalBits}`);
    const data = writer.data();
    assert.equal(data.length, bytes);
    for (let i = 0; i < bytes - 1; i++) {
      assert.equal(data[i], 0xff, `full byte ${i} at ${totalBits}`);
    }
    const tailBits = totalBits % 8;
    const lastByte = tailBits === 0 ? 0xff : 0xff >> (8 - tailBits);
    assert.equal(data[bytes - 1], lastByte, `last byte at ${totalBits}`);
    // everything past the written data holds only flushed zeros
    for (let i = bytes; i < buffer.length; i++) {
      assert.equal(buffer[i], 0, `zero past data at ${totalBits}`);
    }
  }
});

test('flush is a no-op at an exact word boundary and when empty', () => {
  const buffer = new Uint8Array(8);
  const writer = new BitWriter(buffer);
  writer.flushBits(); // nothing written, nothing to flush
  assert.equal(writer.bytesWritten(), 0);
  assert.equal(writer.data().length, 0);
  writer.writeBits(0x11223344, 32);
  writer.writeBits(0x55667788, 32); // fills the qword: flushed by the write
  writer.flushBits(); // scratch is empty: must not store another word
  assert.equal(writer.bytesWritten(), 8);
  assert.deepEqual(
    Array.from(writer.data()),
    [0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55],
  );
});

test('bits of value above the count are ignored', () => {
  // family convention: the Go and C# ports mask the value to the bit count
  const buffer = new Uint8Array(8);
  const writer = new BitWriter(buffer);
  writer.writeBits(0xffffff2a, 8); // low 8 bits are 0x2A
  writer.flushBits();
  assert.deepEqual(Array.from(writer.data()), [0x2a]);
});

test('accounting: bitsWritten, bitsAvailable, alignBits', () => {
  const writer = new BitWriter(new Uint8Array(8));
  assert.equal(writer.bitsWritten(), 0);
  assert.equal(writer.bitsAvailable(), 64);
  assert.equal(writer.alignBits(), 0);
  writer.writeBits(3, 3);
  assert.equal(writer.bitsWritten(), 3);
  assert.equal(writer.bitsAvailable(), 61);
  assert.equal(writer.alignBits(), 5);
  writer.writeBits(0x1f, 5);
  assert.equal(writer.alignBits(), 0);
});

test('reset clears state and allows reuse', () => {
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeBits(0xff, 8);
  writer.flushBits();
  const second = new Uint8Array(8);
  writer.reset(second);
  assert.equal(writer.bitsWritten(), 0);
  writer.writeBits(0x55, 8);
  writer.flushBits();
  assert.deepEqual(Array.from(writer.data()), [0x55]);
});

test('writer checks: buffer type and size', () => {
  assert.throws(() => new BitWriter([1, 2, 3, 4, 5, 6, 7, 8]), TypeError);
  assert.throws(() => new BitWriter(new Uint8Array(7)), RangeError);
  assert.throws(() => new BitWriter(new Uint8Array(12)), RangeError);
  new BitWriter(new Uint8Array(0)); // zero is a multiple of 8
});

test('writer checks: bits range', () => {
  const writer = new BitWriter(new Uint8Array(8));
  assert.throws(() => writer.writeBits(0, 0), RangeError);
  assert.throws(() => writer.writeBits(0, 33), RangeError);
  assert.throws(() => writer.writeBits(0, 1.5), RangeError);
  assert.throws(() => writer.writeBits(0, NaN), RangeError);
  assert.throws(() => writer.writeBits('1', 1), TypeError);
  assert.equal(writer.bitsWritten(), 0); // nothing landed
});

test('writer checks: overflow refused, boundary accepted', () => {
  // accept neighbor: exactly filling the buffer works
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeBits(0, 32);
  writer.writeBits(0, 32);
  assert.equal(writer.bitsAvailable(), 0);
  // refusal: one more bit is past the end
  assert.throws(() => writer.writeBits(0, 1), RangeError);
  assert.equal(writer.bitsWritten(), 64); // the failed write landed nothing
});
