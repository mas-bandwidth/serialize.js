// Declaration arguments on the read stream are judged by native type before
// any arithmetic touches them: a BigInt, a Symbol or an object that cannot be
// coerced to a Number is a declaration that does not fit, so each of the
// seven argument sites refuses it as value_out_of_range -- no throw, a false
// return, no assignment, no cursor movement -- and an earlier latched reason
// is preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReadStream, SerializeError } from '../src/index.js';

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
