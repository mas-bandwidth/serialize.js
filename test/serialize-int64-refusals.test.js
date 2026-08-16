// serializeInt64 refusal tests. The wire is a trust boundary: a ranged
// 64-bit read must refuse any decoded offset above max - min in the
// unsigned domain -- including values smuggled into the bit headroom of the
// TWO DWORD path, serialize.h's test_serialize_int64_validation scenario --
// and refuse truncated data, always as latched errors, never throws. Every
// refusal is proven BOTH WAYS: a doctored vector that is refused, and an
// accept-boundary neighbor that is accepted. The write side is checked too:
// out-of-range values latch ValueOutOfRange and put nothing on the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Builds a packet whose first field is the raw bit pattern `raw` (BigInt)
// in `bits` bits -- the doctoring tool: serializeBits64 places patterns
// serializeInt64 would refuse to write.
function rawPacket(raw, bits) {
  const writer = new WriteStream(new Uint8Array(16));
  writer.serializeBits64({ value: raw }, bits);
  writer.flush();
  return writer.data();
}

test('headroom smuggling refused on the single dword path: [0,6]', () => {
  // [0n,6n]: diff 6 -> 3 bits, so raw 7 is representable but out of range
  const refused = new ReadStream(rawPacket(7n, 3));
  const ref = { value: 999n };
  assert.equal(refused.serializeInt64(ref, 0n, 6n), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, 999n); // ref untouched on refusal

  // the accept boundary: raw 6 is the largest conforming offset
  const accepted = new ReadStream(rawPacket(6n, 3));
  assert.equal(accepted.serializeInt64(ref, 0n, 6n), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 6n);
});

test('headroom smuggling refused on the two dword path: [0, 2^34]', () => {
  // serialize.h's own scenario: the range [0, 2^34] is 35 bits, so values
  // above 2^34 fit in the headroom of the encoding
  const outOfRange = (1n << 34n) + 5n;
  const refused = new ReadStream(rawPacket(outOfRange, 35));
  const ref = { value: 999n };
  assert.equal(refused.serializeInt64(ref, 0n, 1n << 34n), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, 999n);

  // the accept boundary: raw 2^34 decodes to exactly max
  const accepted = new ReadStream(rawPacket(1n << 34n, 35));
  assert.equal(accepted.serializeInt64(ref, 0n, 1n << 34n), true);
  assert.equal(ref.value, 1n << 34n);
});

test('headroom smuggling refused at a mixed-sign wide range', () => {
  // [-5000000000, 5000000000]: diff 10^10 -> 34 bits; the headroom above
  // the diff would decode past max
  const diff = 10000000000n;
  const refused = new ReadStream(rawPacket(diff + 1n, 34));
  const ref = {};
  assert.equal(refused.serializeInt64(ref, -5000000000n, 5000000000n), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, undefined);

  // raw == diff decodes to exactly max = 5000000000
  const accepted = new ReadStream(rawPacket(diff, 34));
  assert.equal(accepted.serializeInt64(ref, -5000000000n, 5000000000n), true);
  assert.equal(ref.value, 5000000000n);
});

test('the full range has no headroom: every corner pattern decodes', () => {
  // [INT64_MIN, INT64_MAX] spans the whole unsigned domain: the refusal
  // check must be exact in that domain, never overzealous
  const patterns = [
    [0n, INT64_MIN], // offset 0 -> min
    [0xffff_ffff_ffff_ffffn, INT64_MAX], // every bit set -> max
    [0x8000_0000_0000_0000n, 0n], // the sign corner -> zero
    [0x7fff_ffff_ffff_ffffn, -1n],
  ];
  for (const [raw, want] of patterns) {
    const reader = new ReadStream(rawPacket(raw, 64));
    const ref = {};
    assert.equal(reader.serializeInt64(ref, INT64_MIN, INT64_MAX), true);
    assert.equal(ref.value, want);
    assert.equal(reader.ok, true);
  }
});

test('truncated data refused as Overflow with NOTHING consumed', () => {
  // a full-range read needs 64 bits; 32 bits of data refuse -- before the
  // low dword is read, so nothing is consumed
  const refused = new ReadStream(new Uint8Array(4));
  const ref = { value: 999n };
  assert.equal(refused.serializeInt64(ref, INT64_MIN, INT64_MAX), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.equal(ref.value, 999n);
  assert.equal(refused.bitsProcessed(), 0);

  // the accept-boundary neighbor: a 32-bit range fits the same data exactly
  const accepted = new ReadStream(new Uint8Array(4));
  assert.equal(accepted.serializeInt64(ref, 0n, 2n ** 32n - 1n), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 0n);
  assert.equal(accepted.bitsProcessed(), 32);
});

test('a write past the end latches Overflow with NOTHING written', () => {
  // 33 bits available, a 34-bit range write refuses up front
  const overflows = new WriteStream(new Uint8Array(8));
  overflows.serializeBits({ value: 0 }, 31);
  assert.equal(
    overflows.serializeInt64({ value: 0n }, -5000000000n, 5000000000n),
    false,
  );
  assert.equal(overflows.error, SerializeError.Overflow);
  assert.equal(overflows.bitsProcessed(), 31); // nothing written

  // the exact fit succeeds: 30 + 34 = 64
  const fits = new WriteStream(new Uint8Array(8));
  fits.serializeBits({ value: 0 }, 30);
  assert.equal(
    fits.serializeInt64({ value: 0n }, -5000000000n, 5000000000n),
    true,
  );
  assert.equal(fits.ok, true);
  assert.equal(fits.bitsProcessed(), 64);
});

test('write-side range checks latch, never throw, and write nothing', () => {
  const cases = [
    [8n, 0n, 7n], // above max
    [-1n, 0n, 7n], // below min
    [5000000001n, -5000000000n, 5000000000n], // above max, wide range
    [-5000000001n, -5000000000n, 5000000000n], // below min, wide range
    [41n, 42n, 42n], // wrong value for a degenerate range
  ];
  for (const [value, min, max] of cases) {
    const label = `${value} in [${min},${max}]`;
    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(writer.serializeInt64({ value }, min, max), false, `write ${label}`);
    assert.equal(writer.error, SerializeError.ValueOutOfRange, `latch for ${label}`);
    assert.equal(writer.bitsProcessed(), 0, `nothing written for ${label}`);

    // the measure acts like a write: same refusal
    const measure = new MeasureStream();
    assert.equal(measure.serializeInt64({ value }, min, max), false, `measure ${label}`);
    assert.equal(measure.error, SerializeError.ValueOutOfRange);
    assert.equal(measure.bitsProcessed(), 0);
  }

  // the accept boundaries of the same ranges succeed
  const writer = new WriteStream(new Uint8Array(24));
  assert.equal(writer.serializeInt64({ value: 7n }, 0n, 7n), true);
  assert.equal(writer.serializeInt64({ value: 0n }, 0n, 7n), true);
  assert.equal(writer.serializeInt64({ value: 5000000000n }, -5000000000n, 5000000000n), true);
  assert.equal(writer.serializeInt64({ value: -5000000000n }, -5000000000n, 5000000000n), true);
  assert.equal(writer.serializeInt64({ value: 42n }, 42n, 42n), true);
  assert.equal(writer.ok, true);
});

test('the first refusal latches: later calls no-op and keep the error', () => {
  const reader = new ReadStream(rawPacket(7n, 3));
  const ref = {};
  assert.equal(reader.serializeInt64(ref, 0n, 6n), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  // a call that would succeed on a healthy stream now returns false and
  // does not touch the ref or the error
  assert.equal(reader.serializeInt64(ref, 0n, 6n), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, undefined);
  // even the zero-bit degenerate read refuses on a latched stream
  assert.equal(reader.serializeInt64(ref, 5n, 5n), false);
  assert.equal(ref.value, undefined);
});
