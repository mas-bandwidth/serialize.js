// serializeWideString tests: each 32-bit group is ONE UTF-16 CODE UNIT,
// never a code point (STANDARD.md, "wstring", adopted 2026-08-15). The
// length in units rides first as serializeInt(length, 0, bufferSize - 1) --
// bufferSize counts WIDE CHARACTERS, not bytes -- then the groups follow
// with NO ALIGNMENT anywhere in the operation, the one place the wide path
// deliberately differs from its narrow counterpart. A JavaScript string IS
// a sequence of UTF-16 code units, so charCodeAt units transmit as they
// are and well-formed surrogate pairs pass through natively -- no
// recombination arithmetic, the C# port's situation exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
  bitsRequired,
} from '../src/index.js';

function writeWideString(value, bufferSize, bufferBytes = 512) {
  const writer = new WriteStream(new Uint8Array(bufferBytes));
  assert.equal(writer.serializeWideString({ value }, bufferSize), true);
  writer.flush();
  return writer.data();
}

function readWideString(wire, bufferSize) {
  const reader = new ReadStream(wire);
  const ref = {};
  assert.equal(reader.serializeWideString(ref, bufferSize), true);
  assert.equal(reader.ok, true);
  return ref.value;
}

// THE FAMILY PIN (serialize.h, test_wstring_utf16_code_units): U+1F600 then
// U+0041 in an 8-unit buffer is EXACTLY these 13 bytes -- 3-bit length 3
// (UNITS: the surrogate pair 0xD83D 0xDE00, then 0x0041), then three
// unaligned 32-bit groups, 99 bits total. Byte-for-byte what every other
// implementation emits on every wchar_t width. Never regenerate these.
const FAMILY_PIN_BYTES = [
  0xeb, 0xc1, 0x06, 0x00, 0x00, 0xf0, 0x06, 0x00, 0x08, 0x02, 0x00, 0x00,
  0x00,
];
const FAMILY_PIN_STRING = '\u{1F600}A';

test('the family pin: U+1F600 then U+0041 at bufferSize 8 is exactly 13 bytes, 99 bits', () => {
  // derive the wire from raw bit operations, exactly as the C++ test
  // spells it out: three units in a [0,7] length field, then each unit as
  // a 32-bit group -- and the derivation must agree with the literal pin
  const derived = new WriteStream(new Uint8Array(64));
  assert.equal(derived.serializeInt({ value: 3 }, 0, 7), true);
  assert.equal(derived.serializeBits({ value: 0xd83d }, 32), true); // high surrogate
  assert.equal(derived.serializeBits({ value: 0xde00 }, 32), true); // low surrogate
  assert.equal(derived.serializeBits({ value: 0x0041 }, 32), true); // letter A
  derived.flush();
  assert.equal(derived.bitsProcessed(), 99);
  assert.deepEqual(Array.from(derived.data()), FAMILY_PIN_BYTES);

  // write side: the unified path must produce exactly those bytes -- the
  // astral emoji is TWO units on the wire, split already in the string
  const wire = writeWideString(FAMILY_PIN_STRING, 8);
  assert.equal(wire.length, 13);
  assert.deepEqual(Array.from(wire), FAMILY_PIN_BYTES);

  // measure counts the units transmitted, not the characters held
  const measure = new MeasureStream();
  assert.equal(measure.serializeWideString({ value: FAMILY_PIN_STRING }, 8), true);
  assert.equal(measure.bitsProcessed(), 99);

  // read side: the pair passes through by adjacency -- the string holds
  // the astral character natively
  assert.equal(readWideString(Uint8Array.from(FAMILY_PIN_BYTES), 8), FAMILY_PIN_STRING);
});

test('the STANDARD.md worked example: "мир" at bufferSize 8 is E3 21 00 00 C0 21 00 00 00 22 00 00 00', () => {
  // three characters 0x043C 0x0438 0x0440 -- the byte run decoded step by
  // step in STANDARD.md's Worked Example, 3 + 3*32 = 99 bits = 13 bytes
  const expected = [
    0xe3, 0x21, 0x00, 0x00, 0xc0, 0x21, 0x00, 0x00, 0x00, 0x22, 0x00, 0x00,
    0x00,
  ];
  const wire = writeWideString('мир', 8);
  assert.deepEqual(Array.from(wire), expected);
  assert.equal(readWideString(wire, 8), 'мир');
});

test('the serialize.cs battery pin: "a" + U+1F600 at bufferSize 8 is 0B 03 00 00 E8 C1 06 00 00 F0 06 00 00', () => {
  // the C# conformance vector: 3-bit length 3 (units 0x0061, then the pair
  // 0xD83D 0xDE00), then three unaligned 32-bit groups
  const expected = [
    0x0b, 0x03, 0x00, 0x00, 0xe8, 0xc1, 0x06, 0x00, 0x00, 0xf0, 0x06, 0x00,
    0x00,
  ];
  const wire = writeWideString('a\u{1F600}', 8);
  assert.deepEqual(Array.from(wire), expected);
  assert.equal(readWideString(wire, 8), 'a\u{1F600}');
});

test('no alignment anywhere: behind a 3-bit prefix the group starts at bit 6', () => {
  // { bits(5,3); wstring("A",8) }: length 1 lands in bits [3,6), the
  // 32-bit group begins immediately at bit 6 -- 4D 10 00 00 00. A port
  // that aligns like the narrow path pads bits [6,8) and writes 0D 41 ...
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  assert.equal(writer.serializeWideString({ value: 'A' }, 8), true);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 3 + 3 + 32);
  assert.deepEqual(Array.from(writer.data()), [0x4d, 0x10, 0x00, 0x00, 0x00]);

  const reader = new ReadStream(writer.data());
  const head = {};
  const ref = {};
  assert.equal(reader.serializeBits(head, 3), true);
  assert.equal(reader.serializeWideString(ref, 8), true);
  assert.equal(head.value, 5);
  assert.equal(ref.value, 'A');
});

test('the empty wide string writes only its length field: { bits(5,3); wstring("",8); bits(0xA5,8) } is 45 29', () => {
  // no groups and NO align: the trailing bits pack immediately after the
  // 3-bit zero length. The narrow twin of this sequence pins 05 A5 --
  // its empty payload still aligns; the wide path must not.
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  assert.equal(writer.serializeWideString({ value: '' }, 8), true);
  assert.equal(writer.serializeBits({ value: 0xa5 }, 8), true);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [0x45, 0x29]);

  const reader = new ReadStream(writer.data());
  const head = {};
  const string = { value: 'sentinel' };
  const tail = {};
  assert.equal(reader.serializeBits(head, 3), true);
  assert.equal(reader.serializeWideString(string, 8), true);
  assert.equal(reader.serializeBits(tail, 8), true);
  assert.equal(string.value, '');
  assert.equal(tail.value, 0xa5);
});

test('BMP, astral and empty strings round trip at bufferSize 64', () => {
  // the C# battery's value set: the astral string rides as surrogate
  // pairs, four groups for the two emoji
  const values = ['', 'мир', 'привіт, світ!', '\u{1F600}\u{1F680}'];
  for (const value of values) {
    assert.equal(readWideString(writeWideString(value, 64), 64), value, JSON.stringify(value));
  }
});

test('round trip at every starting bit offset: the unaligned groups land exactly', () => {
  const text = 'hé€\u{1F600}'; // 1-unit BMP text plus a surrogate pair
  for (let offset = 0; offset <= 7; offset++) {
    const writer = new WriteStream(new Uint8Array(64));
    if (offset > 0) {
      writer.serializeBits({ value: 0 }, offset);
    }
    assert.equal(writer.serializeWideString({ value: text }, 32), true);
    writer.flush();

    const reader = new ReadStream(writer.data());
    if (offset > 0) {
      reader.serializeBits({}, offset);
    }
    const ref = {};
    assert.equal(reader.serializeWideString(ref, 32), true, `offset ${offset}`);
    assert.equal(ref.value, text);
  }
});

test('the longest legal string is bufferSize - 1 units; one more refused as ValueOutOfRange', () => {
  const longest = 'a'.repeat(7);
  const wire = writeWideString(longest, 8);
  assert.equal(readWideString(wire, 8), longest);

  // one unit too many is the writer's contract violation: the checked
  // runtime latches where the family's debug build asserts, and nothing
  // lands on the wire
  const refused = new WriteStream(new Uint8Array(512));
  assert.equal(refused.serializeWideString({ value: 'a'.repeat(8) }, 8), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
  assert.equal(refused.bitsProcessed(), 0);
});

test('the length counts UTF-16 code units, not code points', () => {
  // one emoji is TWO units: it fits bufferSize 3 (2 < 3) and refuses
  // bufferSize 2 (2 >= 2), even though it is a single character
  const accepted = new WriteStream(new Uint8Array(64));
  assert.equal(accepted.serializeWideString({ value: '\u{1F600}' }, 3), true);
  assert.equal(accepted.ok, true);

  const refused = new WriteStream(new Uint8Array(64));
  assert.equal(refused.serializeWideString({ value: '\u{1F600}' }, 2), false);
  assert.equal(refused.error, SerializeError.ValueOutOfRange);
});

test('a lone surrogate is the writer contract violated: latched InvalidString, nothing written', () => {
  // the wide wire cannot launder ill-formed UTF-16 the way the narrow
  // encoder's U+FFFD replacement does: conforming readers refuse unpaired
  // surrogates, so the checked runtime refuses to write them
  for (const bad of ['\uD800', '\uDC00', 'a\uD83Db', '\uDE00\uD83D']) {
    const writer = new WriteStream(new Uint8Array(64));
    assert.equal(writer.serializeWideString({ value: bad }, 16), false, JSON.stringify(bad));
    assert.equal(writer.error, SerializeError.InvalidString);
    assert.equal(writer.bitsProcessed(), 0);
  }
  // the accept boundary: the same code units correctly paired
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeWideString({ value: '😀' }, 16), true);
  assert.equal(writer.ok, true);
});

test('a wide string that does not fit the write buffer latches Overflow after the length', () => {
  // 3 units need 96 bits; an 8-byte buffer holds 64. The length field
  // lands, then the up-front group check refuses before any unit is
  // written.
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeWideString({ value: 'abc' }, 16), false);
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.bitsProcessed(), bitsRequired(0, 15));
});

test('caller misuse throws on every stream: bufferSize and value type', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(Uint8Array.from([0x00]));
  const measure = new MeasureStream();
  for (const bad of [1, 0, -1, 1.5, 2 ** 31, '8', null]) {
    assert.throws(() => writer.serializeWideString({ value: 'x' }, bad), RangeError, `write bufferSize ${bad}`);
    assert.throws(() => reader.serializeWideString({}, bad), RangeError, `read bufferSize ${bad}`);
    assert.throws(() => measure.serializeWideString({ value: 'x' }, bad), RangeError, `measure bufferSize ${bad}`);
  }
  for (const bad of [null, undefined, 42, ['a']]) {
    assert.throws(() => writer.serializeWideString({ value: bad }, 8), TypeError);
    assert.throws(() => measure.serializeWideString({ value: bad }, 8), TypeError);
  }
});

test('measure is EXACT for the wide path: no align, so no 7-bit bound', () => {
  // 'golden' at bufferSize 64: 6-bit length + 6*32 bits of groups, and the
  // write from a byte-aligned start costs exactly the same
  const measure = new MeasureStream();
  assert.equal(measure.serializeWideString({ value: 'golden' }, 64), true);
  assert.equal(measure.bitsProcessed(), bitsRequired(0, 63) + 6 * 32);

  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeWideString({ value: 'golden' }, 64), true);
  assert.equal(measure.bitsProcessed(), writer.bitsProcessed());

  // the empty string pays only its length field
  measure.reset();
  assert.equal(measure.serializeWideString({ value: '' }, 8), true);
  assert.equal(measure.bitsProcessed(), bitsRequired(0, 7));

  // a string that cannot be written cannot be measured either
  measure.reset();
  assert.equal(measure.serializeWideString({ value: 'a'.repeat(8) }, 8), false);
  assert.equal(measure.error, SerializeError.ValueOutOfRange);
  measure.reset();
  assert.equal(measure.serializeWideString({ value: '\uD800' }, 8), false);
  assert.equal(measure.error, SerializeError.InvalidString);
});
