// serializeUint128 tests: the fixed-width 128-bit primitive. NOT ranged --
// always 128 bits on the wire, the low 64-bit half first, then the high
// half, each half low dword first; byte aligned that is the 16 bytes of the
// value in little-endian order (STANDARD.md "uint128"). The value patterns
// and the golden pin are serialize.h's own (test_serialize_uint128), and
// the cross-form check proves the portability story: two serializeUint64
// calls reproduce the wire exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

test('round trips across the value patterns', () => {
  // serialize.h's patterns: zero, max, each half alone, alternating bits,
  // distinct halves
  const values = [
    0n,
    2n ** 128n - 1n,
    0xffff_ffff_ffff_ffffn << 64n, // high half only
    0xffff_ffff_ffff_ffffn, // low half only
    (0xaaaa_aaaa_aaaa_aaaan << 64n) | 0x5555_5555_5555_5555n, // alternating
    (0x0123_4567_89ab_cdefn << 64n) | 0xfedc_ba98_7654_3210n, // distinct halves
  ];
  for (const value of values) {
    const writer = new WriteStream(new Uint8Array(16));
    assert.equal(writer.serializeUint128({ value }), true, `write ${value}`);
    assert.equal(writer.bitsProcessed(), 128);
    writer.flush();

    const reader = new ReadStream(writer.data());
    const ref = {};
    assert.equal(reader.serializeUint128(ref), true, `read ${value}`);
    assert.equal(ref.value, value, `round trip of ${value}`);
    assert.equal(reader.bitsProcessed(), 128);

    const measure = new MeasureStream();
    assert.equal(measure.serializeUint128({ value }), true);
    assert.equal(measure.bitsProcessed(), 128);
  }
});

test('cross-form consistency: byte identical to two serializeUint64 halves', () => {
  // the portability story pinned by serialize.h: an implementation without
  // a 128-bit type reproduces the wire exactly with two 64-bit operations,
  // low half first
  const lowHalf = 0xfedc_ba98_7654_3210n;
  const highHalf = 0x0123_4567_89ab_cdefn;

  const whole = new WriteStream(new Uint8Array(16));
  assert.equal(whole.serializeUint128({ value: (highHalf << 64n) | lowHalf }), true);
  whole.flush();

  const halves = new WriteStream(new Uint8Array(16));
  assert.equal(halves.serializeUint64({ value: lowHalf }), true);
  assert.equal(halves.serializeUint64({ value: highHalf }), true);
  halves.flush();

  assert.equal(whole.bitsProcessed(), halves.bitsProcessed());
  assert.deepEqual(Array.from(whole.data()), Array.from(halves.data()));
});

test('the golden pin: 16 bytes in little-endian order, low half first', () => {
  // serialize.h's golden vector, pinned forever
  const goldenBytes = [
    0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
    0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01,
  ];
  const goldenValue = (0x0123_4567_89ab_cdefn << 64n) | 0xfedc_ba98_7654_3210n;

  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeUint128({ value: goldenValue }), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), 16);
  assert.deepEqual(Array.from(writer.data()), goldenBytes);

  const reader = new ReadStream(Uint8Array.from(goldenBytes));
  const ref = {};
  assert.equal(reader.serializeUint128(ref), true);
  assert.equal(ref.value, goldenValue);
});

test('higher bits are ignored and negative BigInts wrap two\'s complement', () => {
  const writer = new WriteStream(new Uint8Array(32));
  writer.serializeUint128({ value: (1n << 128n) | 5n }); // bit 128 dropped
  writer.serializeUint128({ value: -1n }); // wraps to 2^128 - 1
  writer.flush();

  const reader = new ReadStream(writer.data());
  const a = {};
  const b = {};
  assert.equal(reader.serializeUint128(a), true);
  assert.equal(reader.serializeUint128(b), true);
  assert.equal(a.value, 5n);
  assert.equal(b.value, 2n ** 128n - 1n);
});

test('a uint128 carries no alignment: a bool shifts the whole field', () => {
  const value = (0x0123_4567_89ab_cdefn << 64n) | 0xfedc_ba98_7654_3210n;
  const writer = new WriteStream(new Uint8Array(24));
  writer.serializeBool({ value: true });
  writer.serializeUint128({ value });
  writer.flush();
  assert.equal(writer.bitsProcessed(), 129);

  const reader = new ReadStream(writer.data());
  const flag = {};
  const wide = {};
  assert.equal(reader.serializeBool(flag), true);
  assert.equal(reader.serializeUint128(wide), true);
  assert.equal(flag.value, true);
  assert.equal(wide.value, value);
});

test('truncated data refused as Overflow with NOTHING consumed', () => {
  // 127 bits of headroom cannot carry a 128-bit read: consume one bit of a
  // 16-byte buffer first
  const data = new Uint8Array(16);
  const refused = new ReadStream(data);
  refused.serializeBits({ value: 0 }, 1);
  const ref = { value: 999n };
  assert.equal(refused.serializeUint128(ref), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.equal(ref.value, 999n); // ref untouched
  assert.equal(refused.bitsProcessed(), 1); // nothing consumed

  // the accept-boundary neighbor: the exact 128-bit fit
  const accepted = new ReadStream(data);
  assert.equal(accepted.serializeUint128(ref), true);
  assert.equal(accepted.ok, true);
  assert.equal(ref.value, 0n);
});

test('a write past the end latches Overflow with NOTHING written', () => {
  const overflows = new WriteStream(new Uint8Array(16));
  overflows.serializeBits({ value: 0 }, 1);
  assert.equal(overflows.serializeUint128({ value: 0n }), false);
  assert.equal(overflows.error, SerializeError.Overflow);
  assert.equal(overflows.bitsProcessed(), 1); // nothing written

  const fits = new WriteStream(new Uint8Array(16));
  assert.equal(fits.serializeUint128({ value: 0n }), true);
  assert.equal(fits.ok, true);
  assert.equal(fits.bitsProcessed(), 128);
});

test('a latched stream refuses the uint128 without touching refs', () => {
  const writer = new WriteStream(new Uint8Array(16));
  writer.serializeUint128({ value: 0n });
  writer.serializeBool({ value: true }); // latches Overflow
  assert.equal(writer.serializeUint128({ value: 1n }), false);
  assert.equal(writer.error, SerializeError.Overflow);

  const reader = new ReadStream(new Uint8Array(0));
  const ref = { value: 999n };
  reader.serializeBool(ref); // latches Overflow
  assert.equal(reader.serializeUint128(ref), false);
  assert.equal(ref.value, 999n);
});

test('a non-BigInt value on write is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.throws(() => writer.serializeUint128({ value: 5 }), TypeError);
  assert.equal(writer.ok, true);
});
