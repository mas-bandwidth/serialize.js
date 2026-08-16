// serializeBits64 and serializeUint64 tests: the wide bit-level primitives.
// STANDARD.md "bits": for bits <= 32 a single group, for bits > 32 the low
// 32 bits are written first as a 32-bit group, then the remaining bits - 32
// high bits. serializeUint64 is serialize_bits(value, 64) -- low 32 then
// high 32 -- carrying no range information of its own. Values live in the
// BigInt domain; the bitpacker underneath stays in 32-bit Number arithmetic.
// Refusals are checked against the TOTAL width up front and proven both
// ways: a wide operation that does not fit consumes and writes NOTHING --
// never a dangling low dword.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

// Writes value in `bits` bits, reads it back, and checks both directions
// cost exactly `bits` bits. Returns the wire bytes for pinning.
function roundTrip(value, bits) {
  const label = `${value} in ${bits} bits`;

  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeBits64({ value }, bits), true, `write ${label}`);
  assert.equal(writer.bitsProcessed(), bits, `write cost of ${label}`);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeBits64(ref, bits), true, `read ${label}`);
  assert.equal(ref.value, value, `round trip of ${label}`);
  assert.equal(reader.bitsProcessed(), bits, `read cost of ${label}`);

  const measure = new MeasureStream();
  assert.equal(measure.serializeBits64({ value }, bits), true, `measure ${label}`);
  assert.equal(measure.bitsProcessed(), bits, `measure cost of ${label}`);

  return Array.from(writer.data());
}

test('boundary values round trip at the group-structure edges', () => {
  // single group: bits <= 32
  roundTrip(0n, 1);
  roundTrip(1n, 1);
  roundTrip(0x7fffffffn, 31); // 2^31 - 1: the widest 31-bit value
  roundTrip(0x7fffffffn, 32);
  roundTrip(0x80000000n, 32); // 2^31: the sign-bit corner of the dword
  roundTrip(0xffffffffn, 32); // 2^32 - 1: the widest single group

  // two groups: bits > 32 -- the smallest split and the widest
  roundTrip(0x1_00000000n, 33); // 2^32: the first value needing the high group
  roundTrip(0x1_ffffffffn, 33);
  roundTrip(0x4000_0000_0000_0000n, 63); // 2^62
  roundTrip(0x7fff_ffff_ffff_ffffn, 63); // 2^63 - 1: the widest 63-bit value
  roundTrip(0x8000_0000_0000_0000n, 64); // 2^63: only the top bit set
  roundTrip(0xffff_ffff_ffff_ffffn, 64); // 2^64 - 1: every bit set
  roundTrip(0n, 64);
});

test('pinned wire bytes: 64 bits byte aligned is the value little endian', () => {
  // low 32-bit dword first, then the high dword: for a byte-aligned 64-bit
  // write that is exactly the 8 bytes of the value in little-endian order
  const bytes = roundTrip(0x0123_4567_89ab_cdefn, 64);
  assert.deepEqual(bytes, [0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01]);
});

test('pinned wire bytes: the two-group split at 33 and 40 bits', () => {
  // 33 bits: low dword 0x23456789 (bits 0..31), then high bit 1 (bit 32)
  assert.deepEqual(roundTrip(0x1_23456789n, 33), [0x89, 0x67, 0x45, 0x23, 0x01]);
  // 40 bits: low dword 0xDEADBEEF, then 0xAA in the 8 high bits
  assert.deepEqual(roundTrip(0xaa_dead_beefn, 40), [0xef, 0xbe, 0xad, 0xde, 0xaa]);
});

test('a wide value is byte identical to its two 32-bit groups', () => {
  // the STANDARD's splitting rule, proven against serializeBits itself:
  // serializeBits64(v, 48) == serializeBits(low 32) + serializeBits(high 16)
  const value = 0xcafe_dead_beefn;

  const wide = new WriteStream(new Uint8Array(8));
  assert.equal(wide.serializeBits64({ value }, 48), true);
  wide.flush();

  const groups = new WriteStream(new Uint8Array(8));
  assert.equal(groups.serializeBits({ value: 0xdeadbeef }, 32), true);
  assert.equal(groups.serializeBits({ value: 0xcafe }, 16), true);
  groups.flush();

  assert.equal(wide.bitsProcessed(), groups.bitsProcessed());
  assert.deepEqual(Array.from(wide.data()), Array.from(groups.data()));
});

test('serializeUint64 is serializeBits64 at 64: pinned little-endian bytes', () => {
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(writer.serializeUint64({ value: 0xfedc_ba98_7654_3210n }), true);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 64);
  assert.deepEqual(
    Array.from(writer.data()),
    [0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe],
  );

  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeUint64(ref), true);
  assert.equal(ref.value, 0xfedc_ba98_7654_3210n);

  const measure = new MeasureStream();
  assert.equal(measure.serializeUint64({}), true);
  assert.equal(measure.bitsProcessed(), 64);
});

test('higher bits are ignored and negative BigInts wrap two\'s complement', () => {
  // the call-site conversion of the family: the other ports take a uint64
  // parameter, converting at the call site; here the value is reduced to
  // the bit count the same way
  const writer = new WriteStream(new Uint8Array(24));
  writer.serializeBits64({ value: (1n << 64n) | 5n }, 64); // bit 64 dropped
  writer.serializeBits64({ value: -1n }, 64); // wraps to 2^64 - 1
  writer.serializeBits64({ value: -1n }, 8); // wraps to 0xFF at any width
  writer.flush();

  const reader = new ReadStream(writer.data());
  const a = {};
  const b = {};
  const c = {};
  assert.equal(reader.serializeBits64(a, 64), true);
  assert.equal(reader.serializeBits64(b, 64), true);
  assert.equal(reader.serializeBits64(c, 8), true);
  assert.equal(a.value, 5n);
  assert.equal(b.value, 0xffff_ffff_ffff_ffffn);
  assert.equal(c.value, 0xffn);
});

test('wide values carry no alignment: a bool shifts a 64-bit field', () => {
  // bit 0 = 1, bits 1..64 = 2^64 - 1 -> nine bytes: FF x8 then 01
  const writer = new WriteStream(new Uint8Array(16));
  writer.serializeBool({ value: true });
  writer.serializeBits64({ value: 0xffff_ffff_ffff_ffffn }, 64);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 65);
  assert.deepEqual(
    Array.from(writer.data()),
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  );

  const reader = new ReadStream(writer.data());
  const flag = {};
  const wide = {};
  assert.equal(reader.serializeBool(flag), true);
  assert.equal(reader.serializeBits64(wide, 64), true);
  assert.equal(flag.value, true);
  assert.equal(wide.value, 0xffff_ffff_ffff_ffffn);
});

test('truncated data refused as Overflow with NOTHING consumed', () => {
  // 63 bits of data cannot carry a 64-bit read... but the data is 8 bytes,
  // so consume one bit first to leave 63
  const data = new Uint8Array(8);
  const refused = new ReadStream(data);
  refused.serializeBits({ value: 0 }, 1);
  const ref = { value: 999n };
  assert.equal(refused.serializeBits64(ref, 64), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.equal(ref.value, 999n); // ref untouched
  // the refusal happened BEFORE the low dword was read: checked against
  // the total width up front, so nothing was consumed
  assert.equal(refused.bitsProcessed(), 1);

  // the accept-boundary neighbor: 63 bits fit exactly
  const accepted = new ReadStream(data);
  accepted.serializeBits({ value: 0 }, 1);
  assert.equal(accepted.serializeBits64(ref, 63), true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.bitsProcessed(), 64);
});

test('a write past the end latches Overflow with NOTHING written', () => {
  // 62 bits available, a 33-bit write would dangle its low dword without
  // the up-front total check
  const overflows = new WriteStream(new Uint8Array(8));
  overflows.serializeBits({ value: 0 }, 31);
  assert.equal(overflows.serializeBits64({ value: 0n }, 34), false);
  assert.equal(overflows.error, SerializeError.Overflow);
  assert.equal(overflows.bitsProcessed(), 31); // nothing written

  // the accept-boundary neighbor: 33 bits fit exactly
  const fits = new WriteStream(new Uint8Array(8));
  fits.serializeBits({ value: 0 }, 31);
  assert.equal(fits.serializeBits64({ value: 0x1_00000000n }, 33), true);
  assert.equal(fits.ok, true);
  assert.equal(fits.bitsProcessed(), 64);
});

test('a latched stream refuses the wide operations without touching refs', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits64({ value: 0n }, 64);
  writer.serializeBool({ value: true }); // latches Overflow
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.serializeBits64({ value: 1n }, 1), false);
  assert.equal(writer.serializeUint64({ value: 1n }), false);
  assert.equal(writer.error, SerializeError.Overflow);

  const reader = new ReadStream(new Uint8Array(0));
  const ref = { value: 999n };
  reader.serializeBool(ref); // latches Overflow
  assert.equal(reader.serializeBits64(ref, 1), false);
  assert.equal(reader.serializeUint64(ref), false);
  assert.equal(ref.value, 999n);

  const measure = new MeasureStream();
  measure.serializeInt({ value: 8 }, 0, 7); // latches ValueOutOfRange
  assert.equal(measure.serializeBits64({ value: 0n }, 64), false);
  assert.equal(measure.bitsProcessed(), 0);
});

test('an invalid bit count is caller misuse and throws on every stream', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    for (const bits of [0, -1, 65, 32.5, NaN]) {
      assert.throws(() => stream.serializeBits64({ value: 0n }, bits), RangeError);
    }
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

test('a non-BigInt value on write is caller misuse and throws', () => {
  // the 64-bit domain is BigInt: a Number here is the wrong TYPE, a bug in
  // the calling code (a compile error in the rest of the family), not data
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeBits64({ value: 5 }, 64), TypeError);
  assert.throws(() => writer.serializeUint64({ value: 5 }), TypeError);
  assert.equal(writer.ok, true);
});
