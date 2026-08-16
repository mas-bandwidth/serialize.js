// Bitpacker byte lane tests: writeBytes is the aligned bulk copy under
// serialize_bytes -- head bytes through the scratch to the word boundary,
// whole words copied directly, tail bytes through the scratch -- and
// readBytes is the aligned view read. The wire must be identical to writing
// every byte with writeBits(value, 8): that equivalence is proven at every
// byte-aligned starting offset within a word, which walks every head/word/
// tail split.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, BitReader } from '../src/index.js';

// A deterministic byte pattern with no repeats at small offsets, so a copy
// landing even one byte off the mark changes the wire.
function pattern(length) {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = (i * 37 + 11) & 0xff;
  }
  return data;
}

test('writeBytes matches per-byte writeBits at every aligned offset and length', () => {
  // offsets 0..7 bytes into the first word x lengths 0..24: covers head-only,
  // head+words, head+words+tail, words-only and tail-only splits
  for (let offsetBytes = 0; offsetBytes <= 7; offsetBytes++) {
    for (let length = 0; length <= 24; length++) {
      const data = pattern(length);

      const bulk = new BitWriter(new Uint8Array(64));
      for (let i = 0; i < offsetBytes; i++) {
        bulk.writeBits(0xa0 + i, 8);
      }
      bulk.writeBytes(data);
      bulk.flushBits();

      const perByte = new BitWriter(new Uint8Array(64));
      for (let i = 0; i < offsetBytes; i++) {
        perByte.writeBits(0xa0 + i, 8);
      }
      for (let i = 0; i < length; i++) {
        perByte.writeBits(data[i], 8);
      }
      perByte.flushBits();

      assert.equal(bulk.bitsWritten(), perByte.bitsWritten(), `bits at offset ${offsetBytes} length ${length}`);
      assert.deepEqual(
        Array.from(bulk.data()),
        Array.from(perByte.data()),
        `wire at offset ${offsetBytes} length ${length}`,
      );
    }
  }
});

test('writeBytes then writeBits continues the stream correctly', () => {
  // the scratch must be coherent after the bulk copy: bits written after the
  // bytes land exactly where a per-byte writer would put them
  const writer = new BitWriter(new Uint8Array(32));
  writer.writeBits(0x5a, 8);
  writer.writeBytes(pattern(11)); // from byte 1: head 7 to the word boundary, no whole word, tail 4
  writer.writeBits(0x3, 2);
  writer.writeBits(0x1f, 5);
  writer.flushBits();

  const reader = new BitReader(writer.data());
  assert.equal(reader.readBits(8), 0x5a);
  const bytes = reader.readBytes(11);
  assert.deepEqual(Array.from(bytes), Array.from(pattern(11)));
  assert.equal(reader.readBits(2), 0x3);
  assert.equal(reader.readBits(5), 0x1f);
});

test('writeBytes across many words exercises the bulk path', () => {
  const data = pattern(40); // 5 whole words from offset 0
  const writer = new BitWriter(new Uint8Array(48));
  writer.writeBytes(data);
  writer.flushBits();
  assert.equal(writer.bitsWritten(), 320);
  assert.deepEqual(Array.from(writer.data()), Array.from(data));

  const reader = new BitReader(writer.data());
  assert.deepEqual(Array.from(reader.readBytes(40)), Array.from(data));
  assert.equal(reader.bitsRemaining(), 0);
});

test('zero-length writeBytes writes nothing and readBytes(0) reads nothing', () => {
  const writer = new BitWriter(new Uint8Array(8));
  writer.writeBytes(new Uint8Array(0));
  assert.equal(writer.bitsWritten(), 0);
  writer.writeBits(0xcc, 8);
  writer.flushBits();

  const reader = new BitReader(writer.data());
  const empty = reader.readBytes(0);
  assert.equal(empty.length, 0);
  assert.equal(reader.bitsRead(), 0);
  assert.equal(reader.readBits(8), 0xcc);
});

test('readBytes returns a view positioned at the current byte', () => {
  const source = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const reader = new BitReader(source);
  assert.equal(reader.readBits(8), 0x11);
  const view = reader.readBytes(2);
  assert.deepEqual(Array.from(view), [0x22, 0x33]);
  assert.equal(reader.bitsRead(), 24);
  assert.equal(reader.readBits(8), 0x44);
});

test('writeBytes caller contracts throw: type, alignment, overflow', () => {
  const writer = new BitWriter(new Uint8Array(8));
  assert.throws(() => writer.writeBytes([1, 2, 3]), TypeError);
  assert.throws(() => writer.writeBytes(null), TypeError);

  writer.writeBits(1, 3); // unaligned
  assert.throws(() => writer.writeBytes(new Uint8Array(1)), RangeError);
  writer.writeAlign();
  writer.writeBytes(new Uint8Array(1)); // aligned again: fine

  // 2 bytes written of 8: 7 more bytes do not fit
  assert.throws(() => writer.writeBytes(new Uint8Array(7)), RangeError);
  writer.writeBytes(new Uint8Array(6)); // exactly full: fine
  assert.equal(writer.bitsAvailable(), 0);
});

test('readBytes caller contracts throw: count, alignment, overflow', () => {
  const reader = new BitReader(Uint8Array.from([0x01, 0x02, 0x03]));
  assert.throws(() => reader.readBytes(-1), RangeError);
  assert.throws(() => reader.readBytes(1.5), RangeError);

  reader.readBits(3); // unaligned
  assert.throws(() => reader.readBytes(1), RangeError);
  // bits 3..7 of 0x01 are zero, so the align accepts and byte reads resume
  assert.equal(reader.readAlign(), true);
  assert.deepEqual(Array.from(reader.readBytes(2)), [0x02, 0x03]);
});

test('readBytes past the end throws in the trusted-caller form', () => {
  const reader = new BitReader(Uint8Array.from([0x01, 0x02, 0x03]));
  assert.throws(() => reader.readBytes(4), RangeError);
  // nothing consumed by the refused read
  assert.equal(reader.bitsRead(), 0);
  assert.deepEqual(Array.from(reader.readBytes(3)), [0x01, 0x02, 0x03]);
});
