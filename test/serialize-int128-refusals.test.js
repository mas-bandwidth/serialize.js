// serializeInt128 refusal tests. The wire is a trust boundary: the ranged
// 128-bit read must refuse any decoded offset above max - min in the
// unsigned 128-bit domain -- reject, never clamp (STANDARD.md "int128") --
// at every group structure, and refuse truncated data, always as latched
// errors, never throws. Every refusal is proven BOTH WAYS: a doctored
// vector that is refused, and an accept-boundary neighbor that is accepted.
// The write side is checked too: out-of-range values latch ValueOutOfRange
// and put nothing on the wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

// Builds a packet whose first field is the raw bit pattern `raw` (BigInt)
// in `bits` bits, `bits` in [1,128] -- the doctoring tool. serializeBits64
// chunks compose the identical 32-bit group stream: for bits > 64, the low
// 64 bits are two full groups, then the remainder splits exactly as the
// int128 path splits its third and fourth groups.
function rawPacket(raw, bits) {
  const writer = new WriteStream(new Uint8Array(24));
  if (bits <= 64) {
    writer.serializeBits64({ value: raw }, bits);
  } else {
    writer.serializeBits64({ value: BigInt.asUintN(64, raw) }, 64);
    writer.serializeBits64({ value: raw >> 64n }, bits - 64);
  }
  writer.flush();
  return writer.data();
}

test('the doctoring tool composes the identical group stream', () => {
  // prove the premise: rawPacket over a conforming offset reproduces the
  // serializeInt128 wire exactly, at a three-group width
  const min = -(2n ** 70n);
  const max = 2n ** 70n;
  const value = -0x0123456789abcdefn;
  const offset = BigInt.asUintN(128, value - min); // 72 bits

  const direct = new WriteStream(new Uint8Array(24));
  assert.equal(direct.serializeInt128({ value }, min, max), true);
  direct.flush();

  assert.deepEqual(Array.from(rawPacket(offset, 72)), Array.from(direct.data()));
});

test('same bits, different bounds: the range check alone convicts', () => {
  // serialize.h's scenario: [0,255] and [0,200] both cost 8 bits, so the
  // reader consumes the same bits and the range check is what refuses --
  // proving the refusal, not just the absence of a crash
  const packet = rawPacket(255n, 8);
  const refused = new ReadStream(packet);
  const ref = { value: 999n };
  assert.equal(refused.serializeInt128(ref, 0n, 200n), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, 999n); // ref untouched
  assert.equal(refused.bitsProcessed(), 8); // consumed, then convicted

  // the accept boundary: raw 200 decodes to exactly max
  const accepted = new ReadStream(rawPacket(200n, 8));
  assert.equal(accepted.serializeInt128(ref, 0n, 200n), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 200n);
});

test('headroom smuggling refused at every wide group structure', () => {
  // two groups, three groups, four groups: for each, the smallest raw
  // pattern above the diff is refused and the diff itself is accepted
  const cases = [
    [0n, 1n << 34n, 35], // two groups: 32 + 3
    [-(2n ** 70n), 2n ** 70n, 72], // three groups: 32 + 32 + 8
    [0n, 1n << 100n, 101], // four groups: 32 + 32 + 32 + 5
  ];
  for (const [min, max, bits] of cases) {
    const label = `[${min},${max}]`;
    const diff = BigInt.asUintN(128, max - min);

    const refused = new ReadStream(rawPacket(diff + 1n, bits));
    const ref = {};
    assert.equal(refused.serializeInt128(ref, min, max), false, `${label} refused`);
    assert.equal(refused.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, undefined);

    const accepted = new ReadStream(rawPacket(diff, bits));
    assert.equal(accepted.serializeInt128(ref, min, max), true, `${label} accepted`);
    assert.equal(ref.value, max); // min + diff = max
  }
});

test('the full range has no headroom: every corner pattern decodes', () => {
  const patterns = [
    [0n, INT128_MIN], // offset 0 -> min
    [2n ** 128n - 1n, INT128_MAX], // every bit set -> max
    [1n << 127n, 0n], // the sign corner -> zero
    [(1n << 127n) - 1n, -1n],
  ];
  for (const [raw, want] of patterns) {
    const reader = new ReadStream(rawPacket(raw, 128));
    const ref = {};
    assert.equal(reader.serializeInt128(ref, INT128_MIN, INT128_MAX), true);
    assert.equal(ref.value, want);
    assert.equal(reader.ok, true);
  }
});

test('truncated data refused as Overflow with NOTHING consumed', () => {
  // a full-range read needs 128 bits; 64 bits of data refuse up front
  const refused = new ReadStream(new Uint8Array(8));
  const ref = { value: 999n };
  assert.equal(refused.serializeInt128(ref, INT128_MIN, INT128_MAX), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.equal(ref.value, 999n);
  assert.equal(refused.bitsProcessed(), 0);

  // the accept-boundary neighbor: a 64-bit range fits the same data exactly
  const accepted = new ReadStream(new Uint8Array(8));
  assert.equal(accepted.serializeInt128(ref, 0n, 2n ** 64n - 1n), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 0n);
  assert.equal(accepted.bitsProcessed(), 64);
});

test('a write past the end latches Overflow with NOTHING written', () => {
  // a 102-bit range cannot fit an 8-byte buffer
  const overflows = new WriteStream(new Uint8Array(8));
  assert.equal(
    overflows.serializeInt128({ value: 0n }, -(2n ** 100n), 2n ** 100n),
    false,
  );
  assert.equal(overflows.error, SerializeError.Overflow);
  assert.equal(overflows.bitsProcessed(), 0); // nothing written

  // the exact fit succeeds: a 64-bit range in the same buffer
  const fits = new WriteStream(new Uint8Array(8));
  assert.equal(fits.serializeInt128({ value: 0n }, 0n, 2n ** 64n - 1n), true);
  assert.equal(fits.ok, true);
  assert.equal(fits.bitsProcessed(), 64);
});

test('write-side range checks latch, never throw, and write nothing', () => {
  const cases = [
    [201n, 0n, 200n], // above max
    [-1n, 0n, 200n], // below min
    [(2n ** 100n) + 1n, -(2n ** 100n), 2n ** 100n], // above max, four groups
    [-(2n ** 100n) - 1n, -(2n ** 100n), 2n ** 100n], // below min, four groups
    [41n, 42n, 42n], // wrong value for a degenerate range
  ];
  for (const [value, min, max] of cases) {
    const label = `${value} in [${min},${max}]`;
    const writer = new WriteStream(new Uint8Array(24));
    assert.equal(writer.serializeInt128({ value }, min, max), false, `write ${label}`);
    assert.equal(writer.error, SerializeError.ValueOutOfRange, `latch for ${label}`);
    assert.equal(writer.bitsProcessed(), 0, `nothing written for ${label}`);

    const measure = new MeasureStream();
    assert.equal(measure.serializeInt128({ value }, min, max), false, `measure ${label}`);
    assert.equal(measure.error, SerializeError.ValueOutOfRange);
    assert.equal(measure.bitsProcessed(), 0);
  }

  // the accept boundaries of the same ranges succeed
  const writer = new WriteStream(new Uint8Array(48));
  assert.equal(writer.serializeInt128({ value: 200n }, 0n, 200n), true);
  assert.equal(writer.serializeInt128({ value: 0n }, 0n, 200n), true);
  assert.equal(writer.serializeInt128({ value: 2n ** 100n }, -(2n ** 100n), 2n ** 100n), true);
  assert.equal(writer.serializeInt128({ value: -(2n ** 100n) }, -(2n ** 100n), 2n ** 100n), true);
  assert.equal(writer.serializeInt128({ value: 42n }, 42n, 42n), true);
  assert.equal(writer.ok, true);
});

test('the first refusal latches: later calls no-op and keep the error', () => {
  const reader = new ReadStream(rawPacket(255n, 8));
  const ref = {};
  assert.equal(reader.serializeInt128(ref, 0n, 200n), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  assert.equal(reader.serializeInt128(ref, 0n, 200n), false);
  assert.equal(reader.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, undefined);
  // even the zero-bit degenerate read refuses on a latched stream
  assert.equal(reader.serializeInt128(ref, 5n, 5n), false);
  assert.equal(ref.value, undefined);
});
