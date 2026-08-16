// Stream tests: WriteStream, ReadStream and MeasureStream share one
// bool-returning serialize-method surface, so a single serialize function
// writes, reads and measures the same fields. This file proves the triangle
// on a small mixed sequence -- write it, read it back through the same
// function, measure it, pin the wire bytes -- plus the flags, reset reuse,
// and the shared caller contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

// The family's unified serialize pattern: ONE function, three streams. refs
// are { value } holders -- JavaScript's stand-in for the family's ref
// parameters. On write the values are consumed, on read they are filled in,
// on measure they are ignored.
function serializeSequence(stream, refs) {
  return (
    stream.serializeBits(refs.a, 5) &&
    stream.serializeAlign() &&
    stream.serializeBits(refs.b, 32) &&
    stream.serializeBits(refs.c, 3) &&
    stream.serializeAlign() &&
    stream.serializeBits(refs.d, 8)
  );
}

test('the flags tell a serialize function which way data flows', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.isWriting, true);
  assert.equal(writer.isReading, false);

  const reader = new ReadStream(new Uint8Array(1));
  assert.equal(reader.isWriting, false);
  assert.equal(reader.isReading, true);

  // a measure stream acts like a write stream, so a unified serialize
  // function measures exactly what it would write
  const measure = new MeasureStream();
  assert.equal(measure.isWriting, true);
  assert.equal(measure.isReading, false);
});

test('write/read/measure triangle on a small sequence', () => {
  // write
  const writeRefs = {
    a: { value: 21 },
    b: { value: 0xdeadbeef },
    c: { value: 5 },
    d: { value: 0xc3 },
  };
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(serializeSequence(writer, writeRefs), true);
  assert.equal(writer.ok, true);
  assert.equal(writer.error, SerializeError.None);
  writer.flush();
  // 5 + 3 pad + 32 + 3 + 5 pad + 8 = 56 bits, 7 bytes
  assert.equal(writer.bitsProcessed(), 56);
  assert.equal(writer.bytesProcessed(), 7);
  // Derivation: a=21=0b10101 in bits 0..4, align pads bits 5..7 ->
  // byte 0 = 0x15; b=0xDEADBEEF byte aligned in bytes 1..4, little-endian
  // bit stream -> EF BE AD DE; c=5=0b101 in bits 40..42, align pads
  // 43..47 -> byte 5 = 0x05; d=0xC3 byte aligned in byte 6.
  assert.deepEqual(
    Array.from(writer.data()),
    [0x15, 0xef, 0xbe, 0xad, 0xde, 0x05, 0xc3],
  );

  // read back through the SAME function: fresh refs get filled in
  const readRefs = { a: {}, b: {}, c: {}, d: {} };
  const reader = new ReadStream(writer.data());
  assert.equal(serializeSequence(reader, readRefs), true);
  assert.equal(reader.ok, true);
  assert.equal(reader.error, SerializeError.None);
  assert.equal(readRefs.a.value, 21);
  assert.equal(readRefs.b.value, 0xdeadbeef);
  assert.equal(readRefs.c.value, 5);
  assert.equal(readRefs.d.value, 0xc3);
  assert.equal(reader.bitsProcessed(), 56);
  assert.equal(reader.bytesProcessed(), 7);

  // measure through the SAME function: every align charged the worst case
  // 7 bits -> 5 + 7 + 32 + 3 + 7 + 8 = 62, a bound above the 56 written
  const measure = new MeasureStream();
  assert.equal(serializeSequence(measure, writeRefs), true);
  assert.equal(measure.ok, true);
  assert.equal(measure.bitsProcessed(), 62);
  assert.equal(measure.bytesProcessed(), 8);
  assert.ok(measure.bitsProcessed() >= writer.bitsProcessed());
});

test('alignBits reports the true pad on write and read, worst case on measure', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 1 }, 3);
  assert.equal(writer.alignBits(), 5);
  writer.serializeAlign();
  assert.equal(writer.alignBits(), 0);
  writer.flush();

  const reader = new ReadStream(writer.data());
  reader.serializeBits({}, 3);
  assert.equal(reader.alignBits(), 5);
  reader.serializeAlign();
  assert.equal(reader.alignBits(), 0);

  // the measure does not know where the message lands: always 7
  const measure = new MeasureStream();
  assert.equal(measure.alignBits(), 7);
  measure.serializeBits({}, 8);
  assert.equal(measure.alignBits(), 7);
});

test('reset clears the streams for allocation-free reuse', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0xff }, 8);
  writer.reset(new Uint8Array(8));
  assert.equal(writer.bitsProcessed(), 0);
  assert.equal(writer.ok, true);
  assert.equal(writer.serializeBits({ value: 0x2a }, 8), true);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [0x2a]);

  const reader = new ReadStream(writer.data());
  const ref = {};
  reader.serializeBits(ref, 8);
  assert.equal(ref.value, 0x2a);
  reader.reset(writer.data());
  assert.equal(reader.bitsProcessed(), 0);
  reader.serializeBits(ref, 4);
  assert.equal(ref.value, 0xa);

  const measure = new MeasureStream();
  measure.serializeBits({}, 13);
  measure.serializeAlign();
  assert.equal(measure.bitsProcessed(), 20);
  measure.reset();
  assert.equal(measure.bitsProcessed(), 0);
  assert.equal(measure.ok, true);
});

test('an invalid bits count is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    for (const bits of [0, 33, -1, 2.5, NaN]) {
      assert.throws(() => stream.serializeBits({ value: 0 }, bits), RangeError);
    }
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});
