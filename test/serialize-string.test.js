// serializeString tests: UTF-8 on the wire, the byte length first as
// serializeInt(length, 0, bufferSize - 1), then the payload as
// serializeBytes -- which aligns. The terminator is never transmitted.
// bufferSize is part of the message format: the same string against
// different buffer sizes produces different bytes. Round trips fence the
// UTF-8 boundary code points -- U+0080, U+D7FF, U+E000, U+10000, U+10FFFF
// -- with their encodings pinned byte-for-byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
  bitsRequired,
} from '../src/index.js';

function writeString(value, bufferSize, bufferBytes = 256) {
  const writer = new WriteStream(new Uint8Array(bufferBytes));
  assert.equal(writer.serializeString({ value }, bufferSize), true);
  writer.flush();
  return writer.data();
}

function readString(wire, bufferSize) {
  const reader = new ReadStream(wire);
  const ref = {};
  assert.equal(reader.serializeString(ref, bufferSize), true);
  assert.equal(reader.ok, true);
  return ref.value;
}

test('golden pin: zero-length string still aligns -- { bits(5,3); string("",8); bits(0xA5,8) } is 05 A5', () => {
  // length 0 in 3 bits, then the zero-length payload's align pads bits
  // [6,8). A port whose string path skips the empty-payload align writes
  // { 0x45, 0x29 }. Pinned in the C++ suite; pinned here.
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeBits({ value: 5 }, 3), true);
  assert.equal(writer.serializeString({ value: '' }, 8), true);
  assert.equal(writer.serializeBits({ value: 0xa5 }, 8), true);
  writer.flush();
  assert.equal(writer.bytesProcessed(), 2);
  assert.deepEqual(Array.from(writer.data()), [0x05, 0xa5]);

  const reader = new ReadStream(Uint8Array.from([0x05, 0xa5]));
  const head = {};
  const string = { value: 'sentinel' };
  const tail = {};
  assert.equal(reader.serializeBits(head, 3), true);
  assert.equal(reader.serializeString(string, 8), true);
  assert.equal(reader.serializeBits(tail, 8), true);
  assert.equal(head.value, 5);
  assert.equal(string.value, '');
  assert.equal(tail.value, 0xa5);
});

test('golden pin: "golden" at bufferSize 64 is 06 67 6F 6C 64 65 6E', () => {
  // length 6 in 6 bits (bitsRequired(0,63)), align pads bits [6,8), then
  // the six ASCII bytes: the exact bytes this field contributes inside the
  // C++ golden wire vector.
  const wire = writeString('golden', 64);
  assert.deepEqual(
    Array.from(wire),
    [0x06, 0x67, 0x6f, 0x6c, 0x64, 0x65, 0x6e],
  );
  assert.equal(readString(wire, 64), 'golden');
});

test('the same string against different buffer sizes produces different bytes', () => {
  // bufferSize 8: 3-bit length, pad to byte -> 02 68 69.
  // bufferSize 1000: 10-bit length (bits 8..9 land in byte 1), pad to
  // byte 2 -> 02 00 68 69. bufferSize is an operand, not transmitted.
  assert.deepEqual(Array.from(writeString('hi', 8)), [0x02, 0x68, 0x69]);
  assert.deepEqual(Array.from(writeString('hi', 1000)), [0x02, 0x00, 0x68, 0x69]);
  assert.equal(readString(writeString('hi', 8), 8), 'hi');
  assert.equal(readString(writeString('hi', 1000), 1000), 'hi');
});

test('round-trip fences the UTF-8 boundary code points, encodings pinned', () => {
  // each fence: [string, pinned payload bytes]. bufferSize 16 -> 4-bit
  // length + 4 pad bits, so byte 0 of the wire IS the length.
  const fences = [
    ['\u0080', [0xc2, 0x80]], // the smallest 2-byte code point
    ['\uD7FF', [0xed, 0x9f, 0xbf]], // the last code point below the surrogate gap
    ['\uE000', [0xee, 0x80, 0x80]], // the first code point above the surrogate gap
    ['\u{10000}', [0xf0, 0x90, 0x80, 0x80]], // the smallest astral code point
    ['\u{10FFFF}', [0xf4, 0x8f, 0xbf, 0xbf]], // the last code point there is
  ];
  for (const [string, payload] of fences) {
    const wire = writeString(string, 16);
    assert.deepEqual(
      Array.from(wire),
      [payload.length, ...payload],
      `wire for U+${string.codePointAt(0).toString(16).toUpperCase()}`,
    );
    assert.equal(readString(wire, 16), string);
  }
});

test('multi-code-point round trip at every starting bit offset', () => {
  // the C++ control content: h, e-acute, euro sign, U+1F600 -- 2, 3 and 4
  // byte sequences behind an unaligned prefix
  const text = 'h\u00E9\u20AC\u{1F600}';
  for (let offset = 0; offset <= 7; offset++) {
    const writer = new WriteStream(new Uint8Array(64));
    if (offset > 0) {
      writer.serializeBits({ value: 0 }, offset);
    }
    assert.equal(writer.serializeString({ value: text }, 32), true);
    writer.flush();

    const reader = new ReadStream(writer.data());
    if (offset > 0) {
      reader.serializeBits({}, offset);
    }
    const ref = {};
    assert.equal(reader.serializeString(ref, 32), true, `offset ${offset}`);
    assert.equal(ref.value, text);
  }
});

test('a leading U+FEFF is a code point, not a BOM: it survives the round trip', () => {
  // the wire is not a file: the decoder must not strip a leading zero-width
  // no-break space the writer serialized
  const text = '\uFEFFx';
  const wire = writeString(text, 16);
  assert.deepEqual(Array.from(wire), [0x04, 0xef, 0xbb, 0xbf, 0x78]);
  assert.equal(readString(wire, 16), text);
});

test('the checked writer refuses a lone surrogate as invalid_utf8, before the encoder can launder it', () => {
  // ill-formed UTF-16 has no UTF-8 encoding at all; TextEncoder would
  // silently write U+FFFD, a character the caller never handed in. The
  // checked writer latches InvalidUtf8 and puts nothing on the wire
  for (const value of ['\ud800', 'a\udc00', 'ab\ud83d', '\ude00\ud83d']) {
    for (const stream of [new WriteStream(new Uint8Array(64)), new MeasureStream()]) {
      assert.throws(() => stream.serializeString({ value }, 16), RangeError, `${JSON.stringify(value)} refused`);
      assert.equal(stream.ok, true);
      assert.equal(stream.bitsProcessed(), 0, 'nothing written');
    }
  }
  // the accept-boundary neighbour: the same surrogates, paired
  const wire = writeString('\ud83d\ude00', 16);
  assert.deepEqual(Array.from(wire), [0x04, 0xf0, 0x9f, 0x98, 0x80]);
  assert.equal(readString(wire, 16), '\u{1F600}');
});

test('the checked writer refuses U+0000 as embedded_nul at every position', () => {
  for (const value of ['\0', '\0ab', 'a\0b', 'ab\0']) {
    for (const stream of [new WriteStream(new Uint8Array(64)), new MeasureStream()]) {
      assert.throws(() => stream.serializeString({ value }, 16), RangeError, `${JSON.stringify(value)} refused`);
      assert.equal(stream.ok, true);
      assert.equal(stream.bitsProcessed(), 0, 'nothing written');
    }
  }
  // the accept-boundary neighbour: U+0001, the nearest character that is not NUL
  assert.deepEqual(Array.from(writeString('a\u0001b', 16)), [0x03, 0x61, 0x01, 0x62]);
});

test('real text round trips byte for byte: no normalization, no replacement, every plane', () => {
  // combining acute stays three bytes, distinct from the precomposed form;
  // a byte order mark, a noncharacter, right-to-left text and four-byte
  // characters all travel unchanged
  const cases = [
    'e\u0301', '\u00E9', '\uFEFF\u7881', '\uFFFF', '\u0628\u0627\u062F\u0648\u0642',
    '\u{1F600}', '\u{20000}', '\u{10FFFF}', '\uBC14\uB451', '\u56F2\u7881',
  ];
  for (const text of cases) {
    const wire = writeString(text, 64);
    const bytes = new TextEncoder().encode(text);
    assert.deepEqual(Array.from(wire.subarray(1)), Array.from(bytes), `${JSON.stringify(text)} writes its UTF-8`);
    assert.equal(readString(wire, 64), text, `${JSON.stringify(text)} reads back exactly`);
  }
  assert.notEqual(readString(writeString('e\u0301', 64), 64), '\u00E9', 'never normalized');
});

test('too-long string is write misuse and throws, the boundary length accepted', () => {
  // bufferSize 4: the payload must fit in 3 bytes
  const refused = new WriteStream(new Uint8Array(64));
  assert.throws(() => refused.serializeString({ value: 'abcd' }, 4), RangeError);
  assert.equal(refused.ok, true);
  assert.equal(refused.bitsProcessed(), 0); // nothing on the wire

  const accepted = new WriteStream(new Uint8Array(64));
  assert.equal(accepted.serializeString({ value: 'abc' }, 4), true);
  assert.equal(accepted.ok, true);
});

test('the length check counts UTF-8 bytes, not UTF-16 code units', () => {
  // e-acute is one code unit but two UTF-8 bytes: it fits bufferSize 3
  // (2 < 3) and refuses bufferSize 2 (2 >= 2)
  const accepted = new WriteStream(new Uint8Array(64));
  assert.equal(accepted.serializeString({ value: '\u00E9' }, 3), true);

  const refused = new WriteStream(new Uint8Array(64));
  assert.throws(() => refused.serializeString({ value: '\u00E9' }, 2), RangeError);
});

test('a string that does not fit the write buffer throws (U9) and writes nothing', () => {
  // 10 payload bytes cannot fit an 8-byte buffer whatever the bufferSize
  const writer = new WriteStream(new Uint8Array(8));
  assert.throws(() => writer.serializeString({ value: 'abcdefghij' }, 16), RangeError);
  assert.equal(writer.error, SerializeError.None);
});

test('bufferSize 1 is the degenerate length field: the empty string in zero bits', () => {
  // STANDARD.md prices the length as serialize_int( length, 0,
  // buffer_size - 1 ), so bufferSize 1 is the range [0,0]: zero bits, the
  // empty string, and nothing on the wire at all -- the align inside
  // serializeBytes is a no-op from bit index 0
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeString({ value: '' }, 1), true);
  assert.equal(writer.bitsProcessed(), 0);

  const reader = new ReadStream(new Uint8Array(0));
  const ref = {};
  assert.equal(reader.serializeString(ref, 1), true);
  assert.equal(ref.value, '');
  assert.equal(reader.bitsProcessed(), 0);

  // one byte of payload has nowhere to go: the length field cannot carry a 1
  const refused = new WriteStream(new Uint8Array(8));
  assert.throws(() => refused.serializeString({ value: 'a' }, 1), RangeError);
});

test('caller misuse: bufferSize and value type throw on write and measure, refuse on read (U7)', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const bad of [0, -1, 1.5, 2 ** 31, '8', null]) {
    assert.throws(() => writer.serializeString({ value: 'x' }, bad), RangeError, `write bufferSize ${bad}`);
    const reader = new ReadStream(Uint8Array.from([0x00]));
    assert.equal(reader.serializeString({}, bad), false, `read bufferSize ${bad}`);
    assert.equal(reader.error, SerializeError.ValueOutOfRange);
    assert.throws(() => measure.serializeString({ value: 'x' }, bad), RangeError, `measure bufferSize ${bad}`);
  }
  for (const bad of [null, undefined, 42, ['a']]) {
    assert.throws(() => writer.serializeString({ value: bad }, 8), TypeError);
    assert.throws(() => measure.serializeString({ value: bad }, 8), TypeError);
  }
});

test('measure prices the length prefix, worst case align, and the payload', () => {
  // "golden" at bufferSize 64: 6-bit length + 7-bit align bound + 48
  // payload bits
  const measure = new MeasureStream();
  assert.equal(measure.serializeString({ value: 'golden' }, 64), true);
  assert.equal(measure.bitsProcessed(), bitsRequired(0, 63) + 7 + 48);

  // the empty string still pays its length field and the align
  measure.reset();
  assert.equal(measure.serializeString({ value: '' }, 8), true);
  assert.equal(measure.bitsProcessed(), bitsRequired(0, 7) + 7);

  // a string that cannot be written cannot be measured either
  measure.reset();
  assert.throws(() => measure.serializeString({ value: 'abcd' }, 4), RangeError);
  assert.equal(measure.ok, true);
});

test('the measure bound covers the actual write at every starting offset', () => {
  const text = 'h\u00E9\u20AC\u{1F600}';
  const measure = new MeasureStream();
  assert.equal(measure.serializeString({ value: text }, 32), true);
  const bound = measure.bitsProcessed();

  for (let offset = 0; offset <= 7; offset++) {
    const writer = new WriteStream(new Uint8Array(64));
    if (offset > 0) {
      writer.serializeBits({ value: 0 }, offset);
    }
    const before = writer.bitsProcessed();
    assert.equal(writer.serializeString({ value: text }, 32), true);
    const span = writer.bitsProcessed() - before;
    assert.ok(span <= bound, `offset ${offset}: span ${span} within bound ${bound}`);
  }
});
