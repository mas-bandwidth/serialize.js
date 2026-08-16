// Align tests: writeAlign pads with zeros to the next byte boundary and
// readAlign verifies that padding, refusing nonzero bits -- the standard's
// refusal rule, proven both ways with a doctored vector and its accept
// neighbor at every padding width and every padding bit position.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, BitReader } from '../src/index.js';

test('writeAlign writes nothing when already aligned', () => {
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeAlign(); // at bit 0
  assert.equal(writer.bitsWritten(), 0);
  writer.writeBits(0xab, 8);
  writer.writeAlign(); // at bit 8
  assert.equal(writer.bitsWritten(), 8);
  writer.flushBits();
  assert.deepEqual(Array.from(writer.data()), [0xab]);
});

test('writeAlign pads to the byte boundary from every offset', () => {
  for (let offset = 1; offset <= 7; offset++) {
    const writer = new BitWriter(new Uint8Array(8));
    writer.writeBits(((1 << offset) >>> 0) - 1, offset); // all-ones lead-in
    assert.equal(writer.alignBits(), 8 - offset);
    writer.writeAlign();
    assert.equal(writer.bitsWritten(), 8, `aligned from offset ${offset}`);
    assert.equal(writer.alignBits(), 0);
    writer.writeBits(0xff, 8);
    writer.flushBits();
    // Derivation: offset one-bits at the bottom of byte 0, zero padding
    // above them -> byte 0 = (1 << offset) - 1; then 0xFF in byte 1.
    assert.deepEqual(
      Array.from(writer.data()),
      [((1 << offset) >>> 0) - 1, 0xff],
      `wire from offset ${offset}`,
    );
  }
});

test('known sequence D round-trips through align', () => {
  // writeBits(1,1); writeAlign(); writeBits(0xAB,8)
  //
  // Derivation: bit 0 = 1, bits 1..7 = zero padding -> byte 0 = 0x01;
  // 0xAB byte aligned in byte 1. Wire: 01 AB.
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeBits(1, 1);
  writer.writeAlign();
  writer.writeBits(0xab, 8);
  writer.flushBits();
  assert.deepEqual(Array.from(writer.data()), [0x01, 0xab]);

  const reader = new BitReader(writer.data());
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readAlign(), true);
  assert.equal(reader.bitsRead(), 8);
  assert.equal(reader.readBits(8), 0xab);
});

test('readAlign reads nothing when already aligned', () => {
  const reader = new BitReader(new Uint8Array([0x01, 0xab]));
  assert.equal(reader.readAlign(), true); // at bit 0
  assert.equal(reader.bitsRead(), 0);
  assert.equal(reader.readBits(8), 0x01);
  assert.equal(reader.readAlign(), true); // at bit 8
  assert.equal(reader.bitsRead(), 8);
  // aligned at the exact end of the data: still true, still reads nothing
  assert.equal(reader.readBits(8), 0xab);
  assert.equal(reader.readAlign(), true);
  assert.equal(reader.bitsRemaining(), 0);
});

test('doctored nonzero padding refused at every bit position, accept neighbor passes', () => {
  // The wire of known sequence D is 01 AB: after the 1 bit at bit 0, bits
  // 1..7 are padding and must be zero. Doctor each padding bit in turn:
  // byte 0 = 0x01 | 1 << p reads padding value 1 << (p-1) != 0 -> refused.
  for (let p = 1; p <= 7; p++) {
    const doctored = new Uint8Array([0x01 | (1 << p), 0xab]);
    const reader = new BitReader(doctored);
    assert.equal(reader.readBits(1), 1);
    assert.equal(reader.readAlign(), false, `padding bit ${p} must refuse`);
    // the refusal is a value, not a throw, and the position still advanced
    // to the byte boundary: the caller decides to abort
    assert.equal(reader.bitsRead(), 8);
  }
  // accept neighbor: the identical stream with clean padding reads through
  const reader = new BitReader(new Uint8Array([0x01, 0xab]));
  assert.equal(reader.readBits(1), 1);
  assert.equal(reader.readAlign(), true);
  assert.equal(reader.readBits(8), 0xab);
});

test('doctored padding refused at every padding width', () => {
  // For each offset 1..7, write offset one-bits, align, then a marker byte.
  // Clean wire byte 0 = (1 << offset) - 1. Setting the top bit of byte 0
  // (always a padding bit for offset <= 7) must refuse; the clean wire must
  // accept and read the marker.
  for (let offset = 1; offset <= 7; offset++) {
    const writer = new BitWriter(new Uint8Array(8));
    writer.writeBits(((1 << offset) >>> 0) - 1, offset);
    writer.writeAlign();
    writer.writeBits(0x5a, 8);
    writer.flushBits();
    const clean = writer.data();

    const doctored = Uint8Array.from(clean);
    doctored[0] |= 0x80; // the top padding bit
    const refusing = new BitReader(doctored);
    assert.equal(refusing.readBits(offset), ((1 << offset) >>> 0) - 1);
    assert.equal(refusing.readAlign(), false, `offset ${offset} must refuse`);

    const accepting = new BitReader(clean);
    assert.equal(accepting.readBits(offset), ((1 << offset) >>> 0) - 1);
    assert.equal(accepting.readAlign(), true, `offset ${offset} must accept`);
    assert.equal(accepting.readBits(8), 0x5a);
  }
});

test('align mid-stream at a word boundary crossing', () => {
  // align just before and after the 64-bit scratch boundary to prove the
  // padding interacts correctly with the qword flush
  const writer = new BitWriter(new Uint8Array(16));
  writer.writeBits(0x7fffffff, 31); // bits 0..30
  writer.writeAlign(); // 1 zero bit -> bit index 32
  writer.writeBits(0xffffffff, 32); // bits 32..63: fills the qword exactly
  writer.writeBits(0x7f, 7); // bits 64..70
  writer.writeAlign(); // 1 zero bit -> bit index 72
  writer.writeBits(0xc3, 8);
  writer.flushBits();
  // Derivation: bytes 0..3 = 31 ones then a zero pad bit = FF FF FF 7F;
  // bytes 4..7 = FF FF FF FF; byte 8 = 7 ones then a zero pad = 0x7F;
  // byte 9 = 0xC3. 80 bits, 10 bytes.
  assert.equal(writer.bitsWritten(), 80);
  assert.deepEqual(
    Array.from(writer.data()),
    [0xff, 0xff, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xc3],
  );

  const reader = new BitReader(writer.data());
  assert.equal(reader.readBits(31), 0x7fffffff);
  assert.equal(reader.readAlign(), true);
  assert.equal(reader.readBits(32), 0xffffffff);
  assert.equal(reader.readBits(7), 0x7f);
  assert.equal(reader.readAlign(), true);
  assert.equal(reader.readBits(8), 0xc3);
  assert.equal(reader.bitsRemaining(), 0);
});

test('alignBits agrees between writer and reader at every offset', () => {
  for (let offset = 0; offset <= 7; offset++) {
    const writer = new BitWriter(new Uint8Array(8));
    if (offset > 0) {
      writer.writeBits(0, offset);
    }
    assert.equal(writer.alignBits(), (8 - offset) % 8);
    writer.flushBits();
    const reader = new BitReader(
      writer.bytesWritten() > 0 ? writer.data() : new Uint8Array(1),
    );
    if (offset > 0) {
      reader.readBits(offset);
    }
    assert.equal(reader.alignBits(), (8 - offset) % 8);
  }
});
