// BitReader tests: hand-derived known sequences decoded back, every bit
// width 1..32 at every bit offset 0..7 round-tripped, past-end refusal
// proven both ways, and the in-buffer window pricing exercised on short
// buffers, odd lengths, and subarrays at nonzero byte offsets -- the reader
// requires no slack past the data.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, BitReader } from '../src/index.js';

test('known sequence A reads back: 55 FF', () => {
  // Derivation (see bitwriter.test.js): bit 0 = 1, bits 1..7 = 42,
  // bits 8..15 = 0xFF. A 2-byte buffer is entirely in the tail window.
  const reader = new BitReader(new Uint8Array([0x55, 0xff]));
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readBits(7), 42);
  assert.equal(reader.readBits(8), 0xff);
  assert.equal(reader.bitsRead(), 16);
  assert.equal(reader.bitsRemaining(), 0);
});

test('known sequence B reads back: EF BE AD DE 78 56 34 12 01', () => {
  // Derivation (see bitwriter.test.js): 0xDEADBEEF in bits 0..31,
  // 0x12345678 in bits 32..63, one 1 bit at bit 64. A 9-byte buffer has
  // tailBase = 1: the first read prices its window inside the buffer, the
  // second and third fall into the assembled tail window.
  const reader = new BitReader(
    new Uint8Array([0xef, 0xbe, 0xad, 0xde, 0x78, 0x56, 0x34, 0x12, 0x01]),
  );
  assert.equal(reader.readBits(32), 0xdeadbeef);
  assert.equal(reader.readBits(32), 0x12345678);
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.bitsRemaining(), 7);
});

test('known sequence C reads back: the 64-bit boundary straddle', () => {
  // Derivation (see bitwriter.test.js): 62 zero bits, then 0b101 in bits
  // 62..64. The 3-bit read starts at bit 62 with 2 bits in one window word
  // and 1 in the next.
  const reader = new BitReader(
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x40, 0x01]),
  );
  assert.equal(reader.readBits(32), 0);
  assert.equal(reader.readBits(30), 0);
  assert.equal(reader.readBits(3), 0b101);
});

test('known sequence E reads back: F7 FF DE BC 0A', () => {
  // Derivation (see bitwriter.test.js): 1, 27, 0x3FF, 0xABCDE at widths
  // 1, 5, 10, 20.
  const reader = new BitReader(new Uint8Array([0xf7, 0xff, 0xde, 0xbc, 0x0a]));
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readBits(5), 27);
  assert.equal(reader.readBits(10), 0x3ff);
  assert.equal(reader.readBits(20), 0xabcde);
});

test('every width 1..32 at every bit offset 0..7 round-trips', () => {
  for (let width = 1; width <= 32; width++) {
    const max = width === 32 ? 0xffffffff : ((1 << width) >>> 0) - 1;
    const values = [
      0,
      max,
      1 & max,
      0x55555555 & max,
      0xaaaaaaaa & max,
      max - 1 >= 0 ? max - 1 : 0,
    ].map((v) => v >>> 0);
    for (let offset = 0; offset <= 7; offset++) {
      const buffer = new Uint8Array(32);
      const writer = new BitWriter(buffer);
      if (offset > 0) {
        writer.writeBits(((1 << offset) >>> 0) - 1, offset); // all-ones lead-in
      }
      for (const v of values) {
        writer.writeBits(v, width);
      }
      writer.flushBits();
      assert.equal(writer.bitsWritten(), offset + values.length * width);

      const reader = new BitReader(writer.data());
      if (offset > 0) {
        assert.equal(
          reader.readBits(offset),
          ((1 << offset) >>> 0) - 1,
          `lead-in at width ${width} offset ${offset}`,
        );
      }
      for (const v of values) {
        assert.equal(
          reader.readBits(width),
          v,
          `value ${v} at width ${width} offset ${offset}`,
        );
      }
    }
  }
});

test('past-end refusal proven both ways at the exact boundary', () => {
  // accept neighbor: reading exactly to the end succeeds
  const data = new Uint8Array([0x55, 0xff]);
  const reader = new BitReader(data);
  assert.equal(reader.wouldReadPastEnd(16), false);
  assert.equal(reader.readBits(16), 0xff55);
  assert.equal(reader.bitsRemaining(), 0);
  // refusal: one more bit is past the end, refused as a value, no throw
  assert.equal(reader.wouldReadPastEnd(1), true);
  assert.equal(reader.tryReadBits(1), undefined);
  // the trusted-caller form is the backstop and throws
  assert.throws(() => reader.readBits(1), RangeError);
  assert.equal(reader.bitsRead(), 16); // the refused reads consumed nothing
});

test('past-end refusal on a truncated stream', () => {
  // write 33 bits, then hand the reader one byte short of the wire
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeBits(0xffffffff, 32);
  writer.writeBits(1, 1);
  writer.flushBits();
  assert.equal(writer.bytesWritten(), 5);
  const truncated = writer.data().subarray(0, 4);
  const reader = new BitReader(truncated);
  assert.equal(reader.readBits(32), 0xffffffff); // accept neighbor: what remains reads fine
  assert.equal(reader.tryReadBits(1), undefined); // the truncated bit is refused
  assert.equal(reader.wouldReadPastEnd(1), true);
});

test('tryReadBits returns values on the accept side', () => {
  const reader = new BitReader(new Uint8Array([0x55, 0xff]));
  assert.equal(reader.tryReadBits(1), 1);
  assert.equal(reader.tryReadBits(7), 42);
  assert.equal(reader.tryReadBits(8), 0xff);
  assert.equal(reader.tryReadBits(1), undefined);
});

test('short buffers: every length 0..7 lives entirely in the tail window', () => {
  for (let bytes = 0; bytes <= 7; bytes++) {
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      data[i] = 0xa0 + i; // distinct, high bit set to catch sign slips
    }
    const reader = new BitReader(data);
    for (let i = 0; i < bytes; i++) {
      assert.equal(reader.readBits(8), 0xa0 + i, `byte ${i} of ${bytes}`);
    }
    assert.equal(reader.bitsRemaining(), 0);
    assert.equal(reader.tryReadBits(1), undefined, `refusal at ${bytes}`);
  }
});

test('subarray at a nonzero byte offset reads identically', () => {
  // the reader must respect the view's byteOffset in both the direct window
  // and the tail window
  const wire = [0xef, 0xbe, 0xad, 0xde, 0x78, 0x56, 0x34, 0x12, 0x01];
  const backing = new Uint8Array(20);
  backing.set(wire, 5);
  backing.fill(0xff, 0, 5); // hostile bytes before the data
  backing.fill(0xff, 5 + wire.length); // and after it
  const reader = new BitReader(backing.subarray(5, 5 + wire.length));
  assert.equal(reader.readBits(32), 0xdeadbeef);
  assert.equal(reader.readBits(32), 0x12345678);
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readBits(7), 0); // the wire's trailing zeros, not the 0xFF beyond
  assert.equal(reader.tryReadBits(1), undefined);
});

test('unaligned reads across the direct-to-tail window seam', () => {
  // 24 one-bit reads per byte position across a 10-byte buffer of 0x55
  // alternate 1,0,1,0..., crossing from direct window loads into the tail
  const data = new Uint8Array(10).fill(0x55);
  const reader = new BitReader(data);
  for (let i = 0; i < 80; i++) {
    assert.equal(reader.readBits(1), i % 2 === 0 ? 1 : 0, `bit ${i}`);
  }
  assert.equal(reader.bitsRemaining(), 0);
});

test('reader checks: data type and bits range', () => {
  assert.throws(() => new BitReader([1, 2, 3]), TypeError);
  const reader = new BitReader(new Uint8Array([0xff]));
  assert.throws(() => reader.readBits(0), RangeError);
  assert.throws(() => reader.readBits(33), RangeError);
  assert.throws(() => reader.readBits(2.5), RangeError);
  assert.throws(() => reader.tryReadBits(0), RangeError);
  assert.equal(reader.bitsRead(), 0);
});

test('reset clears state and reassembles the tail window', () => {
  const reader = new BitReader(new Uint8Array([0xff, 0xff]));
  assert.equal(reader.readBits(16), 0xffff);
  reader.reset(new Uint8Array([0x55, 0xff]));
  assert.equal(reader.bitsRead(), 0);
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readBits(7), 42);
});

test('empty buffer refuses everything without throwing', () => {
  const reader = new BitReader(new Uint8Array(0));
  assert.equal(reader.bitsRemaining(), 0);
  assert.equal(reader.wouldReadPastEnd(1), true);
  assert.equal(reader.tryReadBits(1), undefined);
});
