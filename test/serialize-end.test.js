// serializeEnd tests (STANDARD.md, "end"): an object ends at the bit index
// after its last field, and the stream ends there too. A writer's end emits
// nothing and a measure's costs nothing; a reader's end refuses a whole
// byte or more after the object as trailing_data -- checked FIRST -- and a
// set bit among the final byte's unused bits as nonzero_padding, and never
// looks at the bits of the last field. Every refusal is proven both ways:
// the doctored stream refused, and its accept-boundary neighbour accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, ReadStream, MeasureStream, SerializeError } from '../src/index.js';

/** Reads `bits` bits (0 for none) then the end; returns the stream. */
function readThenEnd(bytes, bits) {
  const reader = new ReadStream(Uint8Array.from(bytes));
  if (bits > 0) {
    assert.equal(reader.serializeBits({}, bits), true, 'the field reads');
  }
  reader.serializeEnd();
  return reader;
}

test('an exact stream ends: the empty stream, an aligned and an unaligned object', () => {
  const empty = readThenEnd([], 0);
  assert.equal(empty.ok, true);
  assert.equal(empty.bitsProcessed(), 0);

  const aligned = readThenEnd([0xab], 8);
  assert.equal(aligned.ok, true);
  assert.equal(aligned.bitsProcessed(), 8);

  // three bits of field, five of zero padding: the end consumes them
  const unaligned = readThenEnd([0x05], 3);
  assert.equal(unaligned.ok, true);
  assert.equal(unaligned.bitsProcessed(), 8, 'an accepted end leaves consumed at 8 * bytes');

  // every field bit set: the end looks at the padding only
  assert.equal(readThenEnd([0x07], 3).ok, true);
});

test('a whole byte after the object is trailing_data, even a zero byte', () => {
  for (const [bytes, bits] of [[[0x00], 0], [[0xff], 0], [[0xab, 0x00], 8], [[0x05, 0x00], 3]]) {
    const reader = readThenEnd(bytes, bits);
    assert.equal(reader.ok, false, `${bytes} after ${bits} bits refused`);
    assert.equal(reader.error, SerializeError.TrailingData);
  }
});

test('trailing data is checked before padding: set padding AND a byte more is trailing_data', () => {
  const reader = readThenEnd([0x0d, 0x00], 3);
  assert.equal(reader.error, SerializeError.TrailingData);
  // the neighbour without the extra byte is refused for its padding
  assert.equal(readThenEnd([0x0d], 3).error, SerializeError.NonzeroPadding);
});

test('a set padding bit is nonzero_padding at every position of the final byte', () => {
  for (let bit = 3; bit < 8; bit++) {
    const reader = readThenEnd([0x05 | (1 << bit)], 3);
    assert.equal(reader.error, SerializeError.NonzeroPadding, `padding bit ${bit}`);
  }
  // one field bit: seven bits of padding, the seventh set
  assert.equal(readThenEnd([0x81], 1).error, SerializeError.NonzeroPadding);
  assert.equal(readThenEnd([0x01], 1).ok, true);
});

test('an end on a failed stream refuses with the first reason', () => {
  const reader = new ReadStream(Uint8Array.from([0x07]));
  assert.equal(reader.serializeInt({}, 0, 4), false, 'offset 7 past the span of [0,4]');
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  assert.equal(reader.serializeEnd(), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange, 'the end is an echo of the first refusal');
});

test('nothing can be read after an accepted end, and a zero-bit read still succeeds there', () => {
  const reader = readThenEnd([0x05], 3);
  assert.equal(reader.ok, true);
  const ref = { value: 'untouched' };
  assert.equal(reader.serializeInt(ref, 7, 7), true, 'a degenerate field consumes nothing');
  assert.equal(ref.value, 7);
  assert.equal(reader.serializeBits(ref, 1), false);
  assert.equal(reader.error, SerializeError.PastEnd);
});

test('a writer\'s end emits nothing and a measure\'s costs nothing', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  assert.equal(writer.serializeEnd(), true);
  assert.equal(writer.bitsProcessed(), 3);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [0x05]);

  const measure = new MeasureStream();
  assert.equal(measure.serializeBits({ value: 5 }, 3), true);
  assert.equal(measure.serializeEnd(), true);
  assert.equal(measure.bitsProcessed(), 3);
});

test('an end after a latched write error returns false', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 9 }, 0, 4), false);
  assert.equal(writer.serializeEnd(), false);
  assert.equal(writer.error, SerializeError.ValueOutOfRange);
});
