// Declaration arguments on the read stream are judged by native type before
// any arithmetic touches them: a BigInt, a Symbol or an object that cannot be
// coerced to a Number is a declaration that does not fit, so each of the
// seven argument sites refuses it as value_out_of_range -- no throw, a false
// return, no assignment, no cursor movement -- and an earlier latched reason
// is preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BitReader,
  BitWriter,
  ReadStream,
  SerializeError,
  WriteStream,
  copyString,
  refusalName,
} from '../src/index.js';

const BAD_VALUES = {
  bigint: () => 5n,
  symbol: () => Symbol('declaration'),
  'non-coercible object': () => Object.create(null),
  'throwing valueOf': () => ({
    valueOf() {
      throw new Error('coerced');
    },
  }),
};

// each site calls one read operation with `bad` in exactly one argument
const SITES = {
  'serializeBits bits': (s, ref, bad) => s.serializeBits(ref, bad),
  'serializeBits64 bits': (s, ref, bad) => s.serializeBits64(ref, bad),
  'serializeInt min': (s, ref, bad) => s.serializeInt(ref, bad, 10),
  'serializeInt max': (s, ref, bad) => s.serializeInt(ref, 0, bad),
  'serializeFixed integerBits': (s, ref, bad) => s.serializeFixed(ref, bad, 8, -10, 10),
  'serializeFixed fractionBits': (s, ref, bad) => s.serializeFixed(ref, 8, bad, -10, 10),
  'serializeBytes offset': (s, ref, bad) => s.serializeBytes(new Uint8Array(2), bad),
};

const DATA = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

for (const [site, call] of Object.entries(SITES)) {
  for (const [kind, make] of Object.entries(BAD_VALUES)) {
    test(`${site}: ${kind} refused as value_out_of_range`, () => {
      const stream = new ReadStream(DATA);
      const ref = { value: 999 };
      assert.equal(call(stream, ref, make()), false);
      assert.equal(stream.error, SerializeError.ValueOutOfRange);
      assert.equal(ref.value, 999);
      assert.equal(stream.bitsProcessed(), 0);
    });

    test(`${site}: ${kind} keeps an earlier past_end`, () => {
      const stream = new ReadStream(new Uint8Array(1));
      const probe = { value: 0 };
      assert.equal(stream.serializeBits(probe, 16), false);
      assert.equal(stream.error, SerializeError.PastEnd);
      const ref = { value: 999 };
      assert.equal(call(stream, ref, make()), false);
      assert.equal(stream.error, SerializeError.PastEnd);
      assert.equal(ref.value, 999);
      assert.equal(stream.bitsProcessed(), 0);
    });
  }
}

test('U14: refusalName gives the family spellings, and none for no refusal', () => {
  assert.equal(refusalName(SerializeError.None), 'none');
  assert.equal(refusalName(undefined), 'none');
  for (const reason of Object.values(SerializeError)) {
    if (reason !== null) {
      assert.equal(refusalName(reason), reason);
    }
  }
  assert.equal(refusalName('bogus'), '');
  assert.deepEqual(
    Object.values(SerializeError).filter((r) => r !== null).map(refusalName),
    ['past_end', 'value_out_of_range', 'nonzero_padding', 'trailing_data', 'non_finite_float',
      'invalid_utf8', 'embedded_nul', 'non_canonical', 'rejected'],
  );
});

// U15, serialize_copy_string (reference v2.1.1, test_copy_string): the
// longest prefix of the text before its first NUL whose strict UTF-8
// encoding fits destSize - 1 bytes and does not end inside a character.
// JavaScript strings are UTF-16, so destSize counts UTF-8 bytes. The two
// ill-formed byte vectors have no UTF-16 source and are skipped.
const COPY_STRING = [
  ['abc', 8, 'abc'],
  ['a\0bc', 8, 'a'],
  ['abcdefghij', 4, 'abc'],
  ['\u00e9\u00e9', 4, '\u00e9'],
  ['\u00e9\u00e9', 3, '\u00e9'],
  ['a\u{1F600}', 3, 'a'],
  ['a\u{1F600}', 4, 'a'],
  ['a\u{1F600}', 5, 'a'],
  ['a\u{1F600}', 6, 'a\u{1F600}'],
  ['abc', 1, ''],
];

test('U15: copyString keeps the longest whole-character UTF-8 prefix that fits destSize - 1', () => {
  for (const [source, destSize, expected] of COPY_STRING) {
    assert.equal(copyString(source, destSize), expected, `${JSON.stringify(source)}, ${destSize}`);
  }
});

test('U15: what copyString returns, serializeString with bufferSize = destSize writes and reads back', () => {
  for (const [source, destSize] of COPY_STRING) {
    const text = copyString(source, destSize);
    const writer = new WriteStream(new Uint8Array(64));
    assert.equal(writer.serializeString({ value: text }, destSize), true);
    writer.flush();
    const ref = { value: null };
    assert.equal(new ReadStream(writer.data()).serializeString(ref, destSize), true);
    assert.equal(ref.value, text);
  }
});

// Audit L (js): a copy whose source and destination share memory must copy
// as if through a temporary, at every size, on the write and the read side.
// The small-copy byte loop smeared an overlapping source at 64 bytes or fewer.
for (const n of [1, 4, 16, 63, 64, 65, 66, 68, 128]) {
  test(`audit overlap: a write whose source is the writer's own buffer copies exactly (${n} bytes)`, () => {
    const buffer = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      buffer[i] = i;
    }
    const expected = Array.from(buffer.subarray(0, n));
    const writer = new WriteStream(buffer);
    writer.serializeBits({ value: 0x03020100 }, 32);
    writer.serializeBits({ value: 0x07060504 }, 32);
    assert.equal(writer.serializeBytes(buffer.subarray(0, n)), true);
    writer.flush();
    assert.deepEqual(Array.from(writer.data().subarray(8, 8 + n)), expected);
  });

  test(`audit overlap: a read into the reader's own data copies exactly (${n} bytes)`, () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = (i * 7 + 1) & 0xff;
    }
    const expected = Array.from(data.subarray(8, 8 + n));
    const reader = new ReadStream(data);
    reader.serializeBits({ value: 0 }, 32);
    reader.serializeBits({ value: 0 }, 32);
    const dest = data.subarray(12, 12 + n);
    assert.equal(reader.serializeBytes(dest), true);
    assert.deepEqual(Array.from(dest), expected);
  });
}

test('audit overlap: the bitpacker copies an overlapping span exactly too', () => {
  const buffer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    buffer[i] = i + 1;
  }
  const expected = Array.from(buffer.subarray(0, 20));
  const writer = new BitWriter(buffer);
  writer.writeBits(0x04030201, 32); // the bytes already there
  writer.writeBytes(buffer, 0, 20);
  writer.flushBits();
  assert.deepEqual(Array.from(buffer.subarray(4, 24)), expected);

  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    data[i] = 64 - i;
  }
  const want = Array.from(data.subarray(4, 24));
  const reader = new BitReader(data);
  reader.readBits(32);
  reader.readBytesInto(data, 6, 20);
  assert.deepEqual(Array.from(data.subarray(6, 26)), want);
});
