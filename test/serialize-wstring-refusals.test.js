// serializeWideString refusal tests (STANDARD.md, "Readers must refuse
// malformed wstring payloads", adopted 2026-08-15) -- the serialize.cs
// battery's shapes. Every refused stream is DOCTORED with raw operations --
// serializeInt for the length, serializeBits(32) per group -- because no
// conforming writer can produce it, and the refusal binds in every build
// mode: hostile input latches an error, never throws. Every refusal is
// proven BOTH WAYS: the doctored vector refused, and an accept-boundary
// neighbor -- the closest conforming stream -- accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  SerializeError,
} from '../src/index.js';

const BUFFER_SIZE = 64;

// Builds a wire whose wide-string field carries exactly `units` as 32-bit
// groups with a length field of units.length -- the doctoring tool:
// serializeBits places groups serializeWideString would refuse to write.
function doctoredWire(units, length = units.length) {
  const writer = new WriteStream(new Uint8Array(512));
  assert.equal(writer.serializeInt({ value: length }, 0, BUFFER_SIZE - 1), true);
  for (const unit of units) {
    assert.equal(writer.serializeBits({ value: unit }, 32), true);
  }
  writer.flush();
  return writer.data();
}

function label(units) {
  return units.map((u) => u.toString(16).padStart(4, '0')).join(' ');
}

function expectRefused(units, error, name = label(units)) {
  const reader = new ReadStream(doctoredWire(units));
  const ref = { value: 'sentinel' };
  assert.equal(reader.serializeWideString(ref, BUFFER_SIZE), false, `[${name}] refused`);
  assert.equal(reader.error, error, `[${name}] latches ${error}`);
  assert.equal(ref.value, 'sentinel', `[${name}] leaves the ref untouched`);
}

function expectAccepted(units, expected, name = label(units)) {
  const reader = new ReadStream(doctoredWire(units));
  const ref = {};
  assert.equal(reader.serializeWideString(ref, BUFFER_SIZE), true, `[${name}] accepted`);
  assert.equal(reader.ok, true);
  assert.equal(ref.value, expected, `[${name}] decodes`);
}

test('a group above 0xFFFF is not a UTF-16 code unit: ValueOutOfRange; the largest BMP unit accepted', () => {
  // including 0x10000..0x10FFFF, the OLD format's astral code point
  // groups: under the code-unit format an astral character is a surrogate
  // pair, never a single group. Fail rather than truncate -- the family
  // rule for a value the local wide character cannot hold.
  for (const invalid of [0x10000, 0x1f600, 0x10ffff, 0x110000, 0xffffffff]) {
    expectRefused([invalid], SerializeError.ValueOutOfRange);
    expectRefused([0x0041, invalid], SerializeError.ValueOutOfRange);
  }
  // the accept boundary: 0xFFFF, the last value that IS a code unit
  expectAccepted([0xffff], '￿');
  expectAccepted([0x0041, 0xffff], 'A￿');
});

test('unpaired, misordered and dangling surrogates: InvalidString; well-formed pairs pass', () => {
  // the serialize.cs unpairedShapes battery. If the reader stored lone
  // surrogates as they arrived instead of refusing, each of these would
  // publish an ill-formed string that a conforming peer would itself
  // refuse if echoed back.
  const shapes = [
    [0xd83d], // lone high surrogate
    [0xd83d, 0x0041], // high followed by a BMP unit
    [0xd83d, 0xd83d], // high followed by another high
    [0xde00], // lone low surrogate
    [0x0041, 0xde00], // low with no high before it
    [0xd83d, 0xde00, 0xd83d], // valid pair, then ends inside a pair
  ];
  for (const units of shapes) {
    expectRefused(units, SerializeError.InvalidString);
  }
  // the accept boundary: the same units correctly paired -- how astral
  // text travels
  expectAccepted([0xd83d, 0xde00], '\u{1F600}');
  expectAccepted([0xd83d, 0xde00, 0x0041], '\u{1F600}A');
  expectAccepted([0xd83d, 0xde00, 0xd83d, 0xde00], '\u{1F600}\u{1F600}');
});

test('the code units fencing the surrogate block are ordinary BMP units: accepted', () => {
  // 0xD7FF and 0xE000 sit one step outside [0xD800,0xDFFF] on each side
  expectAccepted([0xd7ff], '퟿');
  expectAccepted([0xe000], '');
  expectAccepted([0xd7ff, 0xe000], '퟿');
});

test('an interior NUL group is the two-lengths smuggling primitive: InvalidString at every position', () => {
  // wire length 3 versus the length a wcslen consumer perceives; the
  // terminator is never transmitted, so ANY zero group is interior
  expectRefused([0x0000, 0x0061, 0x0062], SerializeError.InvalidString, 'NUL first');
  expectRefused([0x0061, 0x0000, 0x0062], SerializeError.InvalidString, 'NUL interior');
  expectRefused([0x0061, 0x0062, 0x0000], SerializeError.InvalidString, 'NUL last');
  // the accept boundary: 0x0001, the nearest unit that is not NUL
  expectAccepted([0x0061, 0x0001, 0x0062], 'ab', 'nonzero neighbor');
});

test('a length that overruns the data latches Overflow before any group decodes', () => {
  // length 5 with only two groups on the wire: the up-front total-width
  // check fires first
  const reader = new ReadStream(doctoredWire([0x0061, 0x0062], 5));
  const ref = { value: 'sentinel' };
  assert.equal(reader.serializeWideString(ref, BUFFER_SIZE), false);
  assert.equal(reader.error, SerializeError.Overflow);
  assert.equal(ref.value, 'sentinel');

  // the accept boundary: the honest length reads the same groups through
  expectAccepted([0x0061, 0x0062], 'ab', 'honest length');
});

test('a length smuggled into the length field bit headroom latches ValueOutOfRange', () => {
  // bufferSize 5 prices the length at bitsRequired(0,4) = 3 bits, whose
  // headroom carries 5, 6 and 7 -- none a legal length. serializeInt
  // refuses the smuggle before any group is read.
  for (const smuggled of [5, 6, 7]) {
    const writer = new WriteStream(new Uint8Array(64));
    assert.equal(writer.serializeBits({ value: smuggled }, 3), true);
    writer.flush();
    const reader = new ReadStream(writer.data());
    const ref = { value: 'sentinel' };
    assert.equal(reader.serializeWideString(ref, 5), false, `length ${smuggled} refused`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
    assert.equal(ref.value, 'sentinel');
  }

  // the accept boundary: 4 is the largest legal length at bufferSize 5
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 4 }, 3), true);
  for (const unit of [0x61, 0x62, 0x63, 0x64]) {
    assert.equal(writer.serializeBits({ value: unit }, 32), true);
  }
  writer.flush();
  const reader = new ReadStream(writer.data());
  const ref = {};
  assert.equal(reader.serializeWideString(ref, 5), true);
  assert.equal(ref.value, 'abcd');
});

test('refusal stops the stream where it stands: a latched reader refuses every later call', () => {
  const reader = new ReadStream(doctoredWire([0xde00]));
  const ref = { value: 'sentinel' };
  assert.equal(reader.serializeWideString(ref, BUFFER_SIZE), false); // latches InvalidString
  assert.equal(reader.serializeWideString(ref, BUFFER_SIZE), false); // still refused
  assert.equal(reader.serializeBits(ref, 8), false); // and so is everything else
  assert.equal(reader.error, SerializeError.InvalidString);
  assert.equal(ref.value, 'sentinel');
});

test('the control content still round trips: the refusals cost no valid stream', () => {
  // BMP text, an astral pair mid-string, and text after it -- every
  // validator branch crossed by a conforming stream
  expectAccepted(
    [0x0068, 0x00e9, 0x20ac, 0xd83d, 0xde00, 0x0021],
    'hé€\u{1F600}!',
    'control content',
  );
});
