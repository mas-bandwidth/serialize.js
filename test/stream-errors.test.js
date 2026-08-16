// Error model tests: errors are values. The first failure latches on the
// stream, every later serialize call returns false without touching the
// stream or the ref, and hostile input never throws. Every refusal is
// proven both ways: the doctored or truncated packet refused, and its
// accept-boundary neighbor passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

test('write overflow latches as a value, boundary fill accepted', () => {
  // accept neighbor first: fill an 8-byte buffer to exactly 64 bits
  const exact = new WriteStream(new Uint8Array(8));
  assert.equal(exact.serializeBits({ value: 0xffffffff }, 32), true);
  assert.equal(exact.serializeBits({ value: 0xffffffff }, 32), true);
  assert.equal(exact.ok, true);
  assert.equal(exact.bitsAvailable(), 0);

  // one more bit does not fit: false and Overflow, not a throw
  assert.equal(exact.serializeBits({ value: 1 }, 1), false);
  assert.equal(exact.error, SerializeError.Overflow);
  assert.equal(exact.ok, false);
  assert.equal(exact.bitsProcessed(), 64);
});

test('a latched write error is sticky: later calls no-op', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 32);
  assert.equal(writer.serializeBits({ value: 1 }, 1), false); // latches

  // plenty of conceptual room for these -- but the stream has failed, so
  // every later call returns false and writes nothing
  assert.equal(writer.serializeBits({ value: 0x42 }, 8), false);
  assert.equal(writer.serializeAlign(), false);
  assert.equal(writer.bitsProcessed(), 64);
  assert.equal(writer.error, SerializeError.Overflow);
});

test('read past the end latches Overflow and leaves the ref unmodified', () => {
  // accept neighbor: a 1-byte packet read to exactly its end
  const reader = new ReadStream(new Uint8Array([0xab]));
  const ref = { value: 12345 };
  assert.equal(reader.serializeBits(ref, 8), true);
  assert.equal(ref.value, 0xab);
  assert.equal(reader.ok, true);

  // the very next bit is past the end: refused as a value, and the
  // sentinel proves the ref was not touched
  ref.value = 12345;
  assert.equal(reader.serializeBits(ref, 1), false);
  assert.equal(ref.value, 12345);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(reader.bitsProcessed(), 8);

  // sticky: an in-range-looking call after the latch also refuses
  assert.equal(reader.serializeBits(ref, 8), false);
  assert.equal(ref.value, 12345);
  assert.equal(reader.serializeAlign(), false);
});

test('a truncated packet refuses mid-message, its full neighbor accepts', () => {
  // the triangle sequence's wire, truncated after 3 of 7 bytes: the 32-bit
  // field runs past the end
  const full = new Uint8Array([0x15, 0xef, 0xbe, 0xad, 0xde, 0x05, 0xc3]);
  const truncated = full.subarray(0, 3);

  function readSequence(stream, refs) {
    return (
      stream.serializeBits(refs.a, 5) &&
      stream.serializeAlign() &&
      stream.serializeBits(refs.b, 32) &&
      stream.serializeBits(refs.c, 3) &&
      stream.serializeAlign() &&
      stream.serializeBits(refs.d, 8)
    );
  }

  const refs = { a: {}, b: {}, c: {}, d: {} };
  const reader = new ReadStream(truncated);
  let result;
  assert.doesNotThrow(() => {
    result = readSequence(reader, refs);
  });
  assert.equal(result, false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(refs.a.value, 21); // read before the truncation point
  assert.equal(refs.b.value, undefined); // never assigned
  assert.equal(refs.d.value, undefined); // short-circuited after the latch

  const acceptRefs = { a: {}, b: {}, c: {}, d: {} };
  assert.equal(readSequence(new ReadStream(full), acceptRefs), true);
  assert.equal(acceptRefs.b.value, 0xdeadbeef);
});

test('nonzero align padding latches Align, and the first error wins', () => {
  // known sequence D doctored: 01 AB with a padding bit set -> 81 AB
  const doctored = new Uint8Array([0x81, 0xab]);
  const reader = new ReadStream(doctored);
  const ref = {};
  assert.equal(reader.serializeBits(ref, 1), true);
  assert.equal(reader.serializeAlign(), false);
  assert.equal(reader.error, SerializeError.Align);

  // the stream has failed: a read that would ALSO overflow does not
  // overwrite the first error
  assert.equal(reader.serializeBits(ref, 32), false);
  assert.equal(reader.error, SerializeError.Align);

  // accept neighbor: clean padding reads through
  const clean = new ReadStream(new Uint8Array([0x01, 0xab]));
  assert.equal(clean.serializeBits(ref, 1), true);
  assert.equal(clean.serializeAlign(), true);
  assert.equal(clean.serializeBits(ref, 8), true);
  assert.equal(ref.value, 0xab);
  assert.equal(clean.ok, true);
});

test('hostile input never throws: every 1-byte doctoring of a valid packet', () => {
  // flip each bit of each byte of the triangle wire -- 56 hostile packets
  // plus 7 truncations, none may throw. A flip in a value field just reads
  // a different value; a flip in padding refuses; a truncation overflows.
  // Either way the failure is a value, never an exception.
  const full = new Uint8Array([0x15, 0xef, 0xbe, 0xad, 0xde, 0x05, 0xc3]);

  function readSequence(stream) {
    const r = {};
    return (
      stream.serializeBits(r, 5) &&
      stream.serializeAlign() &&
      stream.serializeBits(r, 32) &&
      stream.serializeBits(r, 3) &&
      stream.serializeAlign() &&
      stream.serializeBits(r, 8)
    );
  }

  for (let byte = 0; byte < full.length; byte++) {
    for (let bit = 0; bit < 8; bit++) {
      const doctored = Uint8Array.from(full);
      doctored[byte] ^= 1 << bit;
      assert.doesNotThrow(() => readSequence(new ReadStream(doctored)));
    }
  }
  for (let length = 0; length < full.length; length++) {
    const truncated = full.subarray(0, length);
    let result;
    assert.doesNotThrow(() => {
      result = readSequence(new ReadStream(truncated));
    });
    assert.equal(result, false, `truncated to ${length} bytes must refuse`);
  }
});

test('reset clears a latched error on every stream', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 1); // latches Overflow
  assert.equal(writer.ok, false);
  writer.reset(new Uint8Array(8));
  assert.equal(writer.ok, true);
  assert.equal(writer.serializeBits({ value: 7 }, 3), true);

  const reader = new ReadStream(new Uint8Array([0x81]));
  reader.serializeBits({}, 1);
  reader.serializeAlign(); // latches Align
  assert.equal(reader.ok, false);
  reader.reset(new Uint8Array([0x01]));
  assert.equal(reader.ok, true);
  assert.equal(reader.serializeAlign(), true); // aligned at bit 0: reads nothing

  // a measure stream has no latching operation in the current surface, but
  // reset clears its count and keeps the shared shape
  const measure = new MeasureStream();
  measure.serializeAlign();
  measure.reset();
  assert.equal(measure.ok, true);
  assert.equal(measure.bitsProcessed(), 0);
});
