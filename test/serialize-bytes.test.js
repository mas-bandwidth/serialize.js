// serializeBytes tests: an align to the byte boundary -- part of the format,
// verified on read -- then a raw byte copy whose count is never transmitted.
// Carries the C++ conformance pins for the zero-count and unaligned paths
// (STANDARD.md "bytes -- count may be zero", ratified 2026-08-15): each pin
// discriminates against the wrong-but-plausible implementation, because a
// round-trip self-test cannot catch a skipped align -- both halves skip the
// same one. Refusals are proven both ways: doctored vector refused, accept
// neighbor accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

test('golden pin: zero-length bytes still aligns -- { bits(5,3); bytes(0); bits(0xA5,8) } is 05 A5', () => {
  // The zero-length bytes pads bits [3,8) and 0xA5 occupies byte 1. A port
  // that early-returns on count 0 writes { 0x2D, 0x05 } -- every later
  // field shifted by five bits. Pinned in the C++ suite; pinned here.
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  assert.equal(writer.serializeBytes(new Uint8Array(0)), true);
  assert.equal(writer.serializeBits({ value: 0xa5 }, 8), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), 2);
  assert.deepEqual(Array.from(writer.data()), [0x05, 0xa5]);

  const reader = new ReadStream(Uint8Array.from([0x05, 0xa5]));
  const head = {};
  const tail = {};
  assert.equal(reader.serializeBits(head, 3), true);
  assert.equal(reader.serializeBytes(new Uint8Array(0)), true);
  assert.equal(reader.serializeBits(tail, 8), true);
  assert.equal(head.value, 5);
  assert.equal(tail.value, 0xa5);
  assert.equal(reader.bytesProcessed(), 2);
});

test('golden pin: bytes aligns from an unaligned bit index -- { bits(1,1); bytes(EF BE); bits(0x0F,4) } is 01 EF BE 0F', () => {
  // Exercises serialize_bytes' OWN align from bit index 1 -- the case a
  // preceding explicit align would structurally shadow.
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 1 }, 1), true);
  assert.equal(writer.serializeBytes(Uint8Array.from([0xef, 0xbe])), true);
  assert.equal(writer.serializeBits({ value: 0x0f }, 4), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), 4);
  assert.deepEqual(Array.from(writer.data()), [0x01, 0xef, 0xbe, 0x0f]);

  const reader = new ReadStream(Uint8Array.from([0x01, 0xef, 0xbe, 0x0f]));
  const head = {};
  const data = new Uint8Array(2);
  const tail = {};
  assert.equal(reader.serializeBits(head, 1), true);
  assert.equal(reader.serializeBytes(data), true);
  assert.equal(reader.serializeBits(tail, 4), true);
  assert.equal(head.value, 1);
  assert.deepEqual(Array.from(data), [0xef, 0xbe]);
  assert.equal(tail.value, 0x0f);
});

test('bytes round-trip at every starting bit offset', () => {
  const payload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x01]);
  for (let offset = 0; offset <= 7; offset++) {
    const writer = new WriteStream(new Uint8Array(64));
    if (offset > 0) {
      writer.serializeBits({ value: (1 << offset) - 1 }, offset);
    }
    assert.equal(writer.serializeBytes(payload), true);
    writer.flush();

    const reader = new ReadStream(writer.data());
    if (offset > 0) {
      const lead = {};
      assert.equal(reader.serializeBits(lead, offset), true);
      assert.equal(lead.value, (1 << offset) - 1);
    }
    const data = new Uint8Array(payload.length);
    assert.equal(reader.serializeBytes(data), true);
    assert.deepEqual(Array.from(data), Array.from(payload), `offset ${offset}`);
    assert.equal(reader.ok, true);
  }
});

test('doctored align padding before the bytes refused, clean neighbor accepted', () => {
  // clean wire from the unaligned pin: 01 EF BE 0F. Doctor a padding bit
  // (bits 1..7 of byte 0): the align refuses and latches Align.
  for (let p = 1; p <= 7; p++) {
    const doctored = Uint8Array.from([0x01 | (1 << p), 0xef, 0xbe, 0x0f]);
    const reader = new ReadStream(doctored);
    const head = {};
    const data = Uint8Array.from([0x77, 0x77]);
    assert.equal(reader.serializeBits(head, 1), true);
    assert.equal(reader.serializeBytes(data), false, `padding bit ${p} refused`);
    assert.equal(reader.error, SerializeError.Align);
    assert.deepEqual(Array.from(data), [0x77, 0x77]); // untouched on refusal
  }
  // accept neighbor: the clean wire reads through
  const reader = new ReadStream(Uint8Array.from([0x01, 0xef, 0xbe, 0x0f]));
  const head = {};
  const data = new Uint8Array(2);
  assert.equal(reader.serializeBits(head, 1), true);
  assert.equal(reader.serializeBytes(data), true);
  assert.deepEqual(Array.from(data), [0xef, 0xbe]);
});

test('truncated data refused as Overflow, exact-fit neighbor accepted', () => {
  // three bytes on the wire: asking for four must refuse, asking for three
  // must accept -- the boundary proven from both sides
  const wire = Uint8Array.from([0x11, 0x22, 0x33]);

  const refused = new ReadStream(wire);
  const four = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
  assert.equal(refused.serializeBytes(four), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.deepEqual(Array.from(four), [0xaa, 0xbb, 0xcc, 0xdd]); // untouched

  const accepted = new ReadStream(wire);
  const three = new Uint8Array(3);
  assert.equal(accepted.serializeBytes(three), true);
  assert.deepEqual(Array.from(three), [0x11, 0x22, 0x33]);
  assert.equal(accepted.ok, true);
});

test('write past the end of the buffer latches Overflow, exact fit accepted', () => {
  const refused = new WriteStream(new Uint8Array(8));
  assert.equal(refused.serializeBytes(new Uint8Array(9)), false);
  assert.equal(refused.error, SerializeError.Overflow);

  const accepted = new WriteStream(new Uint8Array(8));
  assert.equal(accepted.serializeBytes(new Uint8Array(8)), true);
  assert.equal(accepted.ok, true);
  accepted.flush();
  assert.equal(accepted.bytesProcessed(), 8);
});

test('a latched stream refuses serializeBytes without touching anything', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBytes(new Uint8Array(9)), false); // latch Overflow
  assert.equal(writer.serializeBytes(new Uint8Array(1)), false); // still refused
  assert.equal(writer.error, SerializeError.Overflow);

  const reader = new ReadStream(Uint8Array.from([0x01]));
  const big = new Uint8Array(2);
  assert.equal(reader.serializeBytes(big), false); // latch Overflow
  const one = Uint8Array.from([0x99]);
  assert.equal(reader.serializeBytes(one), false); // still refused
  assert.deepEqual(Array.from(one), [0x99]);
});

test('data must be a Uint8Array on every stream: misuse throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(Uint8Array.from([0x00]));
  const measure = new MeasureStream();
  for (const bad of [null, undefined, [1, 2], 'bytes', new Uint16Array(2)]) {
    assert.throws(() => writer.serializeBytes(bad), TypeError);
    assert.throws(() => reader.serializeBytes(bad), TypeError);
    assert.throws(() => measure.serializeBytes(bad), TypeError);
  }
});

test('measure charges the worst case align plus the bytes', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeBytes(new Uint8Array(7)), true);
  assert.equal(measure.bitsProcessed(), 7 + 56); // 7-bit align bound + 7 bytes

  measure.reset();
  assert.equal(measure.serializeBytes(new Uint8Array(0)), true);
  assert.equal(measure.bitsProcessed(), 7); // the align is charged even at count 0
});

test('the measure bound covers the actual write at every starting offset', () => {
  const payload = Uint8Array.from([0xde, 0xad, 0xbe]);
  const measure = new MeasureStream();
  assert.equal(measure.serializeBytes(payload), true);
  const bound = measure.bitsProcessed();

  for (let offset = 0; offset <= 7; offset++) {
    const writer = new WriteStream(new Uint8Array(64));
    if (offset > 0) {
      writer.serializeBits({ value: 0 }, offset);
    }
    const before = writer.bitsProcessed();
    assert.equal(writer.serializeBytes(payload), true);
    const span = writer.bitsProcessed() - before;
    assert.ok(span <= bound, `offset ${offset}: span ${span} within bound ${bound}`);
  }
});
