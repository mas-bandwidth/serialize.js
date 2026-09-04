// serializeIntRelative refusals, proven both ways: every doctored vector
// that must latch sits beside its accept-boundary neighbor. The read-side
// refusals on the absolute tier are the ordering rule (six zero flags, then
// a current at or below previous in 32 raw bits) and the domain rule (a
// group above 2^31 - 1, read unsigned -- STANDARD.md, adopted 2026-09-04);
// the payload-headroom refusal mirrors the family's ranged-integer
// smuggling rule (STANDARD.md: reject, never clamp). Write-side ordering
// and domain violations are the checked runtime's always-on form of the
// family's checked-build assertions: a latched
// SerializeError.ValueOutOfRange, never a throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, ReadStream, MeasureStream, SerializeError } from '../src/index.js';

// Hand-builds a stream holding the absolute tier: six zero flags, then
// current as 32 raw bits -- the doctored form of the reference's own
// validation vector.
function absoluteTierBytes(current) {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0 }, 6);
  writer.serializeBits({ value: current }, 32);
  writer.flush();
  return writer.data();
}

test('the absolute tier refuses current at or below previous', () => {
  // serialize.h's own vector: current 50 against previous 100
  for (const doctored of [50, 99, 100]) {
    const reader = new ReadStream(absoluteTierBytes(doctored));
    const ref = { value: -1 };
    assert.equal(reader.serializeIntRelative(100, ref), false, `refuse ${doctored}`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, -1, 'a refused read leaves the ref unmodified');
  }

  // the accept boundary: 101 via the absolute tier is over-wide but legal
  // on the wire -- the reader checks ordering, not tier minimality
  const reader = new ReadStream(absoluteTierBytes(101));
  const ref = {};
  assert.equal(reader.serializeIntRelative(100, ref), true);
  assert.equal(ref.value, 101);
});

test('the absolute tier refuses a group above the domain, at the boundary', () => {
  // the 32 raw bits are read UNSIGNED (STANDARD.md, adopted 2026-09-04):
  // the top bit set puts the value above 2^31 - 1, so it is refused rather
  // than reappearing as a negative sequence number
  for (const above of [0x80000000, 0x80000001, 0xffffffff]) {
    const reader = new ReadStream(absoluteTierBytes(above));
    const ref = { value: -1 };
    assert.equal(reader.serializeIntRelative(100, ref), false, `refuse ${above}`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, -1, 'a refused read leaves the ref unmodified');
  }

  // the accept boundary: the domain maximum, one below the first refusal
  const reader = new ReadStream(absoluteTierBytes(0x7fffffff));
  const ref = {};
  assert.equal(reader.serializeIntRelative(100, ref), true);
  assert.equal(ref.value, 0x7fffffff);
});

test('a payload offset above its tier range is refused, at the boundary', () => {
  // the second tier's payload is 3 bits for differences 2..6: offsets 5, 6
  // and 7 are bit headroom. Hand-build flags 0,1 then the offset.
  function tierTwo(offset) {
    const writer = new WriteStream(new Uint8Array(8));
    writer.serializeBits({ value: 0b10 | (offset << 2) }, 5);
    writer.flush();
    return writer.data();
  }

  for (const smuggled of [5, 6, 7]) {
    const reader = new ReadStream(tierTwo(smuggled));
    const ref = {};
    assert.equal(reader.serializeIntRelative(100, ref), false, `refuse offset ${smuggled}`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
  }

  // the accept boundary: offset 4 is difference 6, the tier's top
  const reader = new ReadStream(tierTwo(4));
  const ref = {};
  assert.equal(reader.serializeIntRelative(100, ref), true);
  assert.equal(ref.value, 106);
});

test('the last payload tier refuses its headroom too', () => {
  // tier six: 17 payload bits for differences 4378..69914, range 65536;
  // offsets 65537 and up are headroom. Flags are five zeros and a one.
  function tierSix(offset) {
    const writer = new WriteStream(new Uint8Array(8));
    writer.serializeBits({ value: 0b100000 }, 6);
    writer.serializeBits({ value: offset }, 17);
    writer.flush();
    return writer.data();
  }

  const smuggledReader = new ReadStream(tierSix(65537));
  assert.equal(smuggledReader.serializeIntRelative(100, {}), false);
  assert.equal(smuggledReader.error, SerializeError.ValueOutOfRange);

  const boundaryReader = new ReadStream(tierSix(65536));
  const ref = {};
  assert.equal(boundaryReader.serializeIntRelative(100, ref), true);
  assert.equal(ref.value, 100 + 69914);
});

test('truncated data refuses cleanly at every stage of the ladder', () => {
  // a single byte of zeros: six flags read fine, the 32-bit absolute
  // payload does not
  const flagsOnly = new ReadStream(new Uint8Array([0x00]));
  assert.equal(flagsOnly.serializeIntRelative(100, {}), false);
  assert.equal(flagsOnly.error, SerializeError.Overflow);

  // empty data: the very first flag bit already refuses
  const empty = new ReadStream(new Uint8Array(0));
  assert.equal(empty.serializeIntRelative(100, {}), false);
  assert.equal(empty.error, SerializeError.Overflow);
});

test('writes and measures refuse ordering violations as latched errors', () => {
  for (const makeStream of [
    () => new WriteStream(new Uint8Array(8)),
    () => new MeasureStream(),
  ]) {
    // current at previous, below previous, and outside the domain -- whose
    // first refusal is 2^31, one above the domain maximum
    for (const current of [100, 99, 0, -1, 1.5, NaN, 0x80000000, 0x100000000]) {
      const stream = makeStream();
      assert.equal(stream.serializeIntRelative(100, { value: current }), false, `refuse ${current}`);
      assert.equal(stream.error, SerializeError.ValueOutOfRange);
      assert.equal(stream.bitsProcessed(), 0, 'a refused relative write costs nothing');
    }

    // the accept boundary: previous + 1
    const stream = makeStream();
    assert.equal(stream.serializeIntRelative(100, { value: 101 }), true);
    assert.equal(stream.ok, true);
  }
});

test('a refused absolute-tier write puts nothing on the wire', () => {
  // 64-bit buffer: fill 40 bits, leaving 24 -- the 38-bit absolute tier
  // must refuse as one unit, never a dangling flag prefix
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeBits({ value: 0 }, 32), true);
  assert.equal(writer.serializeBits({ value: 0 }, 8), true);
  assert.equal(writer.serializeIntRelative(100, { value: 100000 }), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), 40, 'nothing written on refusal');
});

test('a previous outside the domain is caller misuse and throws on every stream', () => {
  // previous is the caller's own sequence state and never arrives off the
  // wire, so a previous outside the domain 0 to 2^31 - 1 is caller error
  // everywhere -- a 2^31 exactly as a negative one (STANDARD.md, adopted
  // 2026-09-04)
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    for (const previous of [-1, 1.5, NaN, 0x80000000, 0x100000000, '100', 100n]) {
      assert.throws(() => stream.serializeIntRelative(previous, { value: 200 }), RangeError);
    }
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, true);
    assert.equal(stream.bitsProcessed(), 0);
  }

  // the accept boundary: the domain maximum is a legal previous, and the
  // read that follows it has nowhere left to go, so it refuses as a value
  const top = new ReadStream(Uint8Array.from([0x01]));
  const ref = { value: -1 };
  assert.equal(top.serializeIntRelative(0x7fffffff, ref), false);
  assert.equal(top.error, SerializeError.ValueOutOfRange);
  assert.equal(ref.value, -1);
});

test('a non-number current on write or measure is caller misuse and throws', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeIntRelative(100, { value: 101n }), TypeError);
  const measure = new MeasureStream();
  assert.throws(() => measure.serializeIntRelative(100, { value: null }), TypeError);
});

test('a latched stream refuses relative serializes without touching state', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeInt({ value: 9 }, 0, 7), false); // latch ValueOutOfRange
  assert.equal(writer.serializeIntRelative(100, { value: 101 }), false);
  assert.equal(writer.error, SerializeError.ValueOutOfRange);
  assert.equal(writer.bitsProcessed(), 0);

  const reader = new ReadStream(new Uint8Array(0));
  assert.equal(reader.serializeBits({}, 1), false); // latch Overflow
  const ref = { value: -1 };
  assert.equal(reader.serializeIntRelative(100, ref), false);
  assert.equal(ref.value, -1);
});
