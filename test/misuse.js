// A shared helper for the caller-misuse batteries: the same bad call is
// write misuse on a WriteStream or MeasureStream, which the checked runtime
// throws (IMPLEMENTING.md U9), and caller misuse on a ReadStream, which
// refuses as value_out_of_range and never throws (U7, U16). The reader is
// re-initialised over zeros before each call, so every call is judged on a
// healthy stream.

import assert from 'node:assert/strict';

import { SerializeError } from '../src/index.js';

const ZEROS = new Uint8Array(32);

export function misuse(stream, call, type) {
  if (!stream.isReading) {
    assert.throws(call, type);
    return;
  }
  stream.reset(ZEROS);
  let result;
  assert.doesNotThrow(() => {
    result = call();
  });
  assert.equal(result, false);
  assert.equal(stream.error, SerializeError.ValueOutOfRange);
  assert.equal(stream.bitsProcessed(), 0);
}
