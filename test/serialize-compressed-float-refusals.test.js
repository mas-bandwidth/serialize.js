// serializeCompressedFloat refusal tests. The wire is a trust boundary: a
// read must refuse a decoded integer above max_integer_value -- a value
// smuggled into the bit headroom of the encoding (STANDARD.md: "Readers must
// reject an integer greater than max_integer_value") -- and refuse truncated
// data, always as latched errors, never throws. Every refusal is proven BOTH
// WAYS: a doctored vector that is refused, and an accept-boundary neighbor
// that is accepted. The write side carries the checked runtime's form of the
// family's non-finite assert: writing NaN or an infinity latches
// ValueOutOfRange (ruled 2026-08-15), while every finite float32 value --
// however far outside [min,max] -- clamps and writes. A non-conforming
// DECLARATION is different in kind: the declaration is part of the message
// format, never data, so it throws as caller misuse on every stream in every
// state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

// Builds a packet whose first field is the raw bit pattern `raw` in `bits`
// bits -- the doctoring tool: serializeBits places integers the writer's
// quantization would never produce.
function rawPacket(raw, bits) {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: raw }, bits);
  writer.flush();
  return writer.data();
}

test('headroom smuggling refused, boundary neighbor accepted: [0,10] at 0.01', () => {
  // [0,10] at 0.01: max_integer_value 1000 -> 10 bits, so raws 1001..1023
  // are representable but out of range. 1023 is the far corner of the
  // headroom, 1001 the nearest doctored neighbor.
  const ref = { value: 999 };
  for (const raw of [1001, 1023]) {
    const refused = new ReadStream(rawPacket(raw, 10));
    assert.equal(refused.serializeCompressedFloat(ref, 0, 10, 0.01), false, `raw ${raw}`);
    assert.equal(refused.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, 999, 'ref untouched on refusal');
  }

  // the accept boundary: raw 1000 IS max_integer_value, decoding to exactly max
  const accepted = new ReadStream(rawPacket(1000, 10));
  assert.equal(accepted.serializeCompressedFloat(ref, 0, 10, 0.01), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 10, 'the boundary integer decodes to max exactly');
});

test('a non-finite write refused, the float32 edge accepted', () => {
  // the checked runtime's always-on form of the family's checked-build assertion:
  // NaN and the infinities latch ValueOutOfRange and put nothing on the wire
  for (const value of [NaN, Infinity, -Infinity]) {
    const writer = new WriteStream(new Uint8Array(8));
    assert.equal(writer.serializeCompressedFloat({ value }, 0, 10, 0.01), false, `${value}`);
    assert.equal(writer.error, SerializeError.ValueOutOfRange);
    assert.equal(writer.bitsProcessed(), 0, 'the refused write consumed nothing');
  }

  // the value converts to float32 at the boundary, like the float parameter
  // of the other ports: 3.5e38 overflows float32 to infinity and is refused
  // even though the double is finite...
  const overflowed = new WriteStream(new Uint8Array(8));
  assert.equal(overflowed.serializeCompressedFloat({ value: 3.5e38 }, 0, 10, 0.01), false);
  assert.equal(overflowed.error, SerializeError.ValueOutOfRange);

  // ...while the largest finite float32 is the accept boundary: far outside
  // [0,10], so it clamps to max and writes -- clamping is never a refusal
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeCompressedFloat({ value: 3.4028234663852886e38 }, 0, 10, 0.01), true);
  assert.equal(writer.ok, true);
  writer.flush();
  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeCompressedFloat(ref, 0, 10, 0.01), true);
  assert.equal(ref.value, 10, 'the clamped edge decodes to max');
});

test('a write that does not fit latches Overflow and writes nothing', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 23), true);
  // 9 bits left: the 10-bit declaration does not fit
  assert.equal(writer.serializeCompressedFloat({ value: 5 }, 0, 10, 0.01), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), 55, 'the refused write consumed nothing');

  // the accept boundary: with exactly 10 bits left the write succeeds
  const exact = new WriteStream(new Uint8Array(8));
  assert.equal(exact.serializeBits({ value: 0 }, 32), true);
  assert.equal(exact.serializeBits({ value: 0 }, 22), true);
  assert.equal(exact.serializeCompressedFloat({ value: 5 }, 0, 10, 0.01), true);
  assert.equal(exact.ok, true);
});

test('a truncated read latches Overflow and leaves the ref alone', () => {
  const reader = new ReadStream(new Uint8Array(1)); // 8 bits: 10 needed
  const ref = { value: 42 };
  assert.equal(reader.serializeCompressedFloat(ref, 0, 10, 0.01), false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(ref.value, 42, 'ref untouched on refusal');
  assert.equal(reader.bitsProcessed(), 0, 'the refused read consumed nothing');

  // the accept boundary: 2 bytes carry the 10 bits
  const exact = new ReadStream(rawPacket(500, 10));
  assert.equal(exact.serializeCompressedFloat(ref, 0, 10, 0.01), true);
  assert.equal(exact.ok, true);
});

test('measure refuses a non-finite value like the write it stands in for', () => {
  // a message that cannot be written cannot be measured either
  const measure = new MeasureStream();
  assert.equal(measure.serializeCompressedFloat({ value: NaN }, 0, 10, 0.01), false);
  assert.equal(measure.error, SerializeError.ValueOutOfRange);
  assert.equal(measure.bitsProcessed(), 0);

  // the accept boundary: the largest finite float32 clamps on write, so it
  // measures at the declaration's bit count
  const boundary = new MeasureStream();
  assert.equal(boundary.serializeCompressedFloat({ value: 3.4028234663852886e38 }, 0, 10, 0.01), true);
  assert.equal(boundary.bitsProcessed(), 10);
});

test('a latched error makes compressed floats no-ops, and misuse still throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 5 }, 0, 3), false, 'latch ValueOutOfRange');
  assert.equal(writer.serializeCompressedFloat({ value: 5 }, 0, 10, 0.01), false);
  assert.equal(writer.error, SerializeError.ValueOutOfRange, 'the first error sticks');
  assert.equal(writer.bitsProcessed(), 0);
  // the declaration is validated before the latch check: declaration
  // misuse throws on a latched stream too, while a value-type misuse is
  // never reached -- the latch check returns false before the ref is read,
  // the same order serializeInt pins
  assert.throws(() => writer.serializeCompressedFloat({ value: 5 }, 10, 0, 0.01), RangeError);
  assert.equal(writer.serializeCompressedFloat({ value: '5' }, 0, 10, 0.01), false);
});

test('an invalid declaration is caller misuse and throws on every stream', () => {
  const streams = [
    new WriteStream(new Uint8Array(8)),
    new ReadStream(rawPacket(0, 10)),
    new MeasureStream(),
  ];
  const ref = { value: 5 };
  for (const stream of streams) {
    // min not below max, resolution not positive, NaN parameters
    assert.throws(() => stream.serializeCompressedFloat(ref, 10, 10, 0.01), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, 10, 0, 0.01), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, 0, 10, 0), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, 0, 10, -0.01), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, NaN, 10, 0.01), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, 0, NaN, 0.01), RangeError);
    assert.throws(() => stream.serializeCompressedFloat(ref, 0, 10, NaN), RangeError);
    // non-number parameters
    assert.throws(() => stream.serializeCompressedFloat(ref, '0', 10, 0.01), TypeError);
    // the declaration is float32: bounds that only differ in double
    // collapse to min === max at the boundary and throw
    assert.throws(() => stream.serializeCompressedFloat(ref, 1, 1 + 1e-8, 0.01), RangeError);
    // delta = max - min overflows float32 to infinity: non-conforming
    // (STANDARD.md, adopted 2026-08-15) -- the checked runtime throws
    // where the family's checked builds assert
    assert.throws(() => stream.serializeCompressedFloat(ref, -3e38, 3e38, 1), RangeError);
    // values = delta / resolution overflows float32 to infinity
    assert.throws(() => stream.serializeCompressedFloat(ref, 0, 3e38, 1e-38), RangeError);
    // nothing latched: misuse is a throw, never an error value
    assert.equal(stream.ok, true, 'misuse latches nothing');
  }

  // a non-number VALUE is misuse too, on the streams that read the ref
  // (a read stream never touches the incoming ref value)
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeCompressedFloat({ value: '5' }, 0, 10, 0.01), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeCompressedFloat({ value: 5n }, 0, 10, 0.01), TypeError);
  assert.equal(writer.ok, true, 'value misuse latches nothing');
  assert.equal(measure.ok, true, 'value misuse latches nothing');
});
