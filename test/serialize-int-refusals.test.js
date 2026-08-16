// serializeInt refusal tests. The wire is a trust boundary: a ranged read
// must refuse any decoded offset above max - min -- a value smuggled into
// the bit headroom of the encoding -- and refuse truncated data, always as
// latched errors, never throws. Every refusal is proven BOTH WAYS: a
// doctored vector that is refused, and an accept-boundary neighbor that is
// accepted. The write side is checked too: out-of-range values latch
// ValueOutOfRange and put nothing on the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

// Builds a packet whose first field is the raw bit pattern `raw` in `bits`
// bits -- the doctoring tool: serializeBits places patterns serializeInt
// would refuse to write.
function rawPacket(raw, bits) {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: raw }, bits);
  writer.flush();
  return writer.data();
}

test('headroom smuggling refused, boundary neighbor accepted: [0,6]', () => {
  // [0,6]: diff 6 -> 3 bits, so raw 7 is representable but out of range
  const refused = new ReadStream(rawPacket(7, 3));
  const ref = { value: 999 };
  assert.equal(refused.serializeInt(ref, 0, 6), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, 999); // ref untouched on refusal

  // the accept boundary: raw 6 is the largest conforming offset
  const accepted = new ReadStream(rawPacket(6, 3));
  assert.equal(accepted.serializeInt(ref, 0, 6), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 6);
});

test('headroom smuggling refused at an offset range: [10,16]', () => {
  // [10,16]: diff 6 -> 3 bits; raw 7 would decode to 17, above max
  const refused = new ReadStream(rawPacket(7, 3));
  const ref = {};
  assert.equal(refused.serializeInt(ref, 10, 16), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);

  // raw 6 decodes to exactly max = 16
  const accepted = new ReadStream(rawPacket(6, 3));
  assert.equal(accepted.serializeInt(ref, 10, 16), true);
  assert.equal(ref.value, 16);
});

test('every headroom pattern refused, the whole range accepted: [-5,5]', () => {
  // [-5,5]: diff 10 -> 4 bits; raws 11..15 are headroom, raws 0..10 conform
  for (let raw = 11; raw <= 15; raw++) {
    const reader = new ReadStream(rawPacket(raw, 4));
    const ref = {};
    assert.equal(reader.serializeInt(ref, -5, 5), false, `raw ${raw} refused`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, undefined);
  }
  for (let raw = 0; raw <= 10; raw++) {
    const reader = new ReadStream(rawPacket(raw, 4));
    const ref = {};
    assert.equal(reader.serializeInt(ref, -5, 5), true, `raw ${raw} accepted`);
    assert.equal(ref.value, raw - 5); // min + offset
  }
});

test('a full-coverage range has no headroom: every pattern decodes: [-4,3]', () => {
  // [-4,3]: diff 7 -> 3 bits, and all 8 patterns are conforming offsets --
  // the refusal check must be exact, never overzealous
  for (let raw = 0; raw <= 7; raw++) {
    const reader = new ReadStream(rawPacket(raw, 3));
    const ref = {};
    assert.equal(reader.serializeInt(ref, -4, 3), true, `raw ${raw} accepted`);
    assert.equal(ref.value, raw - 4);
    assert.equal(reader.ok, true);
  }
});

test('truncated data refused as Overflow, exact fit accepted', () => {
  // [0,7] needs 3 bits: empty data refuses...
  const empty = new ReadStream(new Uint8Array(0));
  const ref = { value: 999 };
  assert.equal(empty.serializeInt(ref, 0, 7), false);
  assert.equal(empty.error, SerializeError.Overflow);
  assert.equal(ref.value, 999);

  // ...one byte accepts
  const oneByte = new ReadStream(rawPacket(5, 3));
  assert.equal(oneByte.serializeInt(ref, 0, 7), true);
  assert.equal(ref.value, 5);

  // sequential boundary: 6 of 8 bits consumed, a 3-bit read passes the end
  const packet = rawPacket(0, 8);
  const refuses = new ReadStream(packet);
  refuses.serializeBits({}, 6);
  assert.equal(refuses.serializeInt({}, 0, 7), false); // 6 + 3 > 8
  assert.equal(refuses.error, SerializeError.Overflow);

  // its neighbor: a 2-bit read fits exactly
  const accepts = new ReadStream(packet);
  accepts.serializeBits({}, 6);
  assert.equal(accepts.serializeInt(ref, 0, 3), true); // 6 + 2 = 8
  assert.equal(ref.value, 0);
  assert.equal(accepts.ok, true);
});

test('a write past the end latches Overflow, the exact fit succeeds', () => {
  // 61 + 3 = 64 bits: exact fit succeeds
  const fits = new WriteStream(new Uint8Array(8));
  fits.serializeBits({ value: 0 }, 32);
  fits.serializeBits({ value: 0 }, 29);
  assert.equal(fits.serializeInt({ value: 3 }, 0, 7), true);
  assert.equal(fits.ok, true);
  assert.equal(fits.bitsProcessed(), 64);

  // 62 + 3 > 64: the write refuses and the stream latches
  const overflows = new WriteStream(new Uint8Array(8));
  overflows.serializeBits({ value: 0 }, 32);
  overflows.serializeBits({ value: 0 }, 30);
  assert.equal(overflows.serializeInt({ value: 3 }, 0, 7), false);
  assert.equal(overflows.error, SerializeError.Overflow);
  assert.equal(overflows.bitsProcessed(), 62); // nothing was written
});

test('write-side range checks latch, never throw, and write nothing', () => {
  const cases = [
    [8, 0, 7], // above max
    [-1, 0, 7], // below min
    [6, -5, 5], // above max, mixed-sign range
    [-6, -5, 5], // below min, mixed-sign range
    [41, 42, 42], // wrong value for a degenerate range
    [2.5, 0, 7], // non-integer: the int32 domain cannot carry it
    [NaN, 0, 7], // NaN: no comparison can admit it
  ];
  for (const [value, min, max] of cases) {
    const label = `${value} in [${min},${max}]`;
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeInt({ value }, min, max), false, `write ${label}`);
    assert.equal(writer.error, SerializeError.ValueOutOfRange, `latch for ${label}`);
    assert.equal(writer.bitsProcessed(), 0, `nothing written for ${label}`);

    // the measure acts like a write: same refusal (the Go port's stance)
    const measure = new MeasureStream();
    assert.equal(measure.serializeInt({ value }, min, max), false, `measure ${label}`);
    assert.equal(measure.error, SerializeError.ValueOutOfRange);
    assert.equal(measure.bitsProcessed(), 0);
  }

  // the accept boundaries of the same ranges succeed
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 7 }, 0, 7), true);
  assert.equal(writer.serializeInt({ value: 0 }, 0, 7), true);
  assert.equal(writer.serializeInt({ value: 5 }, -5, 5), true);
  assert.equal(writer.serializeInt({ value: -5 }, -5, 5), true);
  assert.equal(writer.serializeInt({ value: 42 }, 42, 42), true);
  assert.equal(writer.ok, true);
});

test('the first refusal latches: later calls no-op and keep the error', () => {
  const reader = new ReadStream(rawPacket(7, 3));
  const ref = {};
  assert.equal(reader.serializeInt(ref, 0, 6), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  // a call that would succeed on a healthy stream now returns false and
  // does not touch the ref or the error
  assert.equal(reader.serializeInt(ref, 0, 6), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, undefined);
  // even the zero-bit degenerate read refuses on a latched stream
  assert.equal(reader.serializeInt(ref, 5, 5), false);
  assert.equal(ref.value, undefined);
});
