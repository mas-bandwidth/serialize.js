// Byte span tests: serializeBytes(data, offset, length) on every stream, and
// the bitpacker's writeBytes(data, offset, length) and
// readBytesInto(dest, offset, length) under it, select a span of a caller's
// array without a subarray view. The span form is a calling convention, not
// a wire form: every span must put exactly the bytes its subarray would on
// the wire, at every starting bit offset and across the small-copy and bulk
// paths, and a span read must fill only its span. None of these assert
// dev-only caller validation, so this file runs on both legs; the
// write-side misuse throws live in serialize-bytes and bitpacker-bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BitWriter,
  BitReader,
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

// A deterministic byte pattern with no repeats at small offsets, so a copy
// landing even one byte off the mark changes the wire.
function pattern(length) {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = (i * 37 + 11) & 0xff;
  }
  return data;
}

// Writes { bits(lead), bytes, bits(0x5,3) } and returns the flushed wire.
function writeWire(lead, writeBytesField) {
  const writer = new WriteStream(new Uint8Array(256));
  if (lead > 0) {
    assert.equal(writer.serializeBits({ value: 0 }, lead), true);
  }
  assert.equal(writeBytesField(writer), true);
  assert.equal(writer.serializeBits({ value: 0x5 }, 3), true);
  writer.flush();
  return Array.from(writer.data());
}

test('a write span puts the same wire as its subarray at every bit offset, small and bulk', () => {
  const source = pattern(160);
  for (const [offset, length] of [[0, 0], [5, 0], [0, 1], [3, 7], [1, 64], [2, 67], [9, 140], [0, 160]]) {
    for (let lead = 0; lead <= 7; lead++) {
      const expected = writeWire(lead, (w) => w.serializeBytes(source.subarray(offset, offset + length)));
      const actual = writeWire(lead, (w) => w.serializeBytes(source, offset, length));
      assert.deepEqual(actual, expected, `span [${offset},${offset + length}) after ${lead} bits`);
    }
  }
});

test('a write span with only an offset runs to the end of the array', () => {
  const source = pattern(20);
  const expected = writeWire(3, (w) => w.serializeBytes(source.subarray(6)));
  const actual = writeWire(3, (w) => w.serializeBytes(source, 6));
  assert.deepEqual(actual, expected);
});

test('a read span fills exactly its span and leaves the rest of the array untouched', () => {
  const payload = pattern(150);
  for (const [offset, length] of [[0, 0], [4, 0], [0, 1], [3, 7], [1, 64], [2, 67], [7, 140]]) {
    for (let lead = 0; lead <= 7; lead++) {
      const wire = writeWire(lead, (w) => w.serializeBytes(payload, 0, length));
      const reader = new ReadStream(Uint8Array.from(wire));
      if (lead > 0) {
        assert.equal(reader.serializeBits({}, lead), true);
      }
      const dest = new Uint8Array(160).fill(0xcc);
      assert.equal(reader.serializeBytes(dest, offset, length), true);
      const tail = {};
      assert.equal(reader.serializeBits(tail, 3), true);
      assert.equal(tail.value, 0x5);
      for (let i = 0; i < dest.length; i++) {
        const inside = i >= offset && i < offset + length;
        assert.equal(dest[i], inside ? payload[i - offset] : 0xcc, `span [${offset},${offset + length}) after ${lead} bits, byte ${i}`);
      }
    }
  }
});

test('a read span past the end is refused as PastEnd, the exact-fit neighbor accepted', () => {
  const wire = Uint8Array.from([0x10, 0x20, 0x30]);
  const refused = new ReadStream(wire);
  assert.equal(refused.serializeBytes(new Uint8Array(8), 2, 4), false);
  assert.equal(refused.error, SerializeError.PastEnd);

  const accepted = new ReadStream(wire);
  const dest = new Uint8Array(8);
  assert.equal(accepted.serializeBytes(dest, 2, 3), true);
  assert.deepEqual(Array.from(dest), [0, 0, 0x10, 0x20, 0x30, 0, 0, 0]);
});

test('a read span refuses set align padding as NonzeroPadding, the clean neighbor accepted', () => {
  const refused = new ReadStream(Uint8Array.from([0x02, 0xab]));
  assert.equal(refused.serializeBits({}, 1), true);
  assert.equal(refused.serializeBytes(new Uint8Array(4), 1, 1), false);
  assert.equal(refused.error, SerializeError.NonzeroPadding);

  const accepted = new ReadStream(Uint8Array.from([0x01, 0xab]));
  const dest = new Uint8Array(4);
  assert.equal(accepted.serializeBits({}, 1), true);
  assert.equal(accepted.serializeBytes(dest, 1, 1), true);
  assert.deepEqual(Array.from(dest), [0, 0xab, 0, 0]);
});

test('a write span past the end of the buffer throws (U9) and writes nothing, the exact fit accepted', () => {
  const source = pattern(16);
  const refused = new WriteStream(new Uint8Array(8));
  assert.throws(() => refused.serializeBytes(source, 4, 9), RangeError);
  assert.equal(refused.error, SerializeError.None);

  const accepted = new WriteStream(new Uint8Array(8));
  assert.equal(accepted.serializeBytes(source, 4, 8), true);
  accepted.flush();
  assert.deepEqual(Array.from(accepted.data()), Array.from(source.subarray(4, 12)));
});

test('measure charges a span as its length: the worst case align plus the span bytes', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeBytes(new Uint8Array(100), 10, 7), true);
  assert.equal(measure.bitsProcessed(), 7 + 56);

  measure.reset();
  assert.equal(measure.serializeBytes(new Uint8Array(100), 90), true);
  assert.equal(measure.bitsProcessed(), 7 + 80);

  measure.reset();
  assert.equal(measure.serializeBytes(new Uint8Array(100), 0, 0), true);
  assert.equal(measure.bitsProcessed(), 7);
});

test('the read span contract refuses misuse as value_out_of_range in every mode (U7)', () => {
  const dest = new Uint8Array(4);
  for (const [offset, length] of [[-1, 1], [0, -1], [1.5, 1], [0, 1.5], [3, 2], [5, 0], [0, 5], ['0', 1], [null, 1]]) {
    const reader = new ReadStream(Uint8Array.from([0x00, 0x00]));
    let result;
    assert.doesNotThrow(() => {
      result = reader.serializeBytes(dest, offset, length);
    }, `offset ${offset}, length ${length}`);
    assert.equal(result, false, `offset ${offset}, length ${length}`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange, `offset ${offset}, length ${length}`);
    // misuse consumed nothing and wrote nothing
    assert.equal(reader.bitsProcessed(), 0);
  }
  // the reversed witness: a span inside dest reads
  const reader = new ReadStream(Uint8Array.from([0x00, 0x00]));
  assert.equal(reader.serializeBytes(dest, 2, 2), true);
});

test('bitpacker writeBytes span matches per-byte writeBits at every aligned offset', () => {
  const source = pattern(150);
  for (const [offset, length] of [[0, 0], [3, 1], [1, 7], [2, 64], [5, 70], [0, 150]]) {
    for (let lead = 0; lead < 4; lead++) {
      const expected = new BitWriter(new Uint8Array(160));
      const actual = new BitWriter(new Uint8Array(160));
      for (let i = 0; i < lead; i++) {
        expected.writeBits(0x5a, 8);
        actual.writeBits(0x5a, 8);
      }
      for (let i = 0; i < length; i++) {
        expected.writeBits(source[offset + i], 8);
      }
      actual.writeBytes(source, offset, length);
      expected.flushBits();
      actual.flushBits();
      assert.equal(actual.bitsWritten(), expected.bitsWritten());
      assert.deepEqual(Array.from(actual.data()), Array.from(expected.data()), `span [${offset},${offset + length}) after ${lead} bytes`);
    }
  }
});

test('bitpacker readBytesInto span fills exactly its span, small and bulk', () => {
  const data = pattern(120);
  for (const [offset, length] of [[0, 0], [2, 1], [3, 64], [1, 100]]) {
    const reader = new BitReader(data);
    reader.readBits(8);
    const dest = new Uint8Array(110).fill(0xcc);
    reader.readBytesInto(dest, offset, length);
    assert.equal(reader.bitsRead(), 8 + length * 8);
    for (let i = 0; i < dest.length; i++) {
      const inside = i >= offset && i < offset + length;
      assert.equal(dest[i], inside ? data[1 + i - offset] : 0xcc, `span [${offset},${offset + length}), byte ${i}`);
    }
  }
});

test('bitpacker readBytesInto span contract throws, consuming nothing', () => {
  const reader = new BitReader(Uint8Array.from([0x01, 0x02, 0x03]));
  const dest = new Uint8Array(4);
  assert.throws(() => reader.readBytesInto(dest, 3, 2), RangeError);
  assert.throws(() => reader.readBytesInto(dest, -1, 1), RangeError);
  assert.throws(() => reader.readBytesInto(dest, 0, 4), RangeError); // past the end of the data
  assert.equal(reader.bitsRead(), 0);
  reader.readBytesInto(dest, 1, 3);
  assert.deepEqual(Array.from(dest), [0, 0x01, 0x02, 0x03]);
});
