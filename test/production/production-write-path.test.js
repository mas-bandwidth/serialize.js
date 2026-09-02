// The production write path: what NODE_ENV=production keeps, and what it
// removes (see src/mode.js and STANDARD.md, "Writes assume trusted data").
//
// This file IS the production-mode leg's spine and only runs there: under
// the default dev sweep every test here skips, because each one asserts the
// ABSENCE of a dev assert -- an invalid-parameter call that throws or
// latches in dev passes through in production, the caller-trust contract,
// exactly as a C/C++ release build trusts its caller. The dev half of every
// proof already lives in the misuse and refusal suites (streams.test.js,
// serialize-*-refusals.test.js), which the dev leg runs.
//
// The production leg (npm run test:production, and CI's production step)
// runs this file plus every test file that asserts no dev-only caller
// validation -- the golden wire and family pins, the 256-program property
// sweep, the read-side refusal batteries (ruling #8 binds in EVERY mode)
// and the stream error model among them -- so wire identity and the read
// trust boundary are re-proven under the production variants, not assumed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, WriteStream, ReadStream, MeasureStream, SerializeError } from '../../src/index.js';
import { PRODUCTION } from '../../src/mode.js';

// Under the dev sweep the spine is silent: a green run prints test names and
// nothing else, and a skip notice is narration (the family's convention, as
// serialize.h states it). SERIALIZE_TEST_VERBOSE=1 restores the skips with
// their reason; under NODE_ENV=production the spine simply runs.
const VERBOSE = process.env.SERIALIZE_TEST_VERBOSE === '1';
const gate = { skip: PRODUCTION ? false : 'production-mode leg: run with NODE_ENV=production' };

function spine(name, options, fn) {
  if (PRODUCTION || VERBOSE) {
    test(name, options, fn);
  }
}

function ref(value) {
  return { value };
}

spine('the mode is frozen at load: this leg sees the production variants', gate, () => {
  assert.equal(PRODUCTION, true);
  assert.equal(process.env.NODE_ENV, 'production');
});

spine('overflow still latches in production: sticky, wire intact, reset clears', gate, () => {
  const buffer = new Uint8Array(8);
  const stream = new WriteStream(buffer);

  assert.equal(stream.serializeUint32(ref(1)), true);
  assert.equal(stream.serializeUint32(ref(2)), true);

  // the third word does not fit: the buffer-end refusal is the retained
  // hard check, and it is a latched value, never a throw
  assert.equal(stream.serializeUint32(ref(3)), false);
  assert.equal(stream.error, SerializeError.Overflow);
  assert.equal(stream.ok, false);

  // sticky: every later call fails without touching the stream
  assert.equal(stream.serializeBool(ref(true)), false);
  assert.equal(stream.bitsProcessed(), 64);
  assert.equal(stream.error, SerializeError.Overflow);

  // the accepted words are intact on the wire
  stream.flush();
  const readStream = new ReadStream(stream.data());
  const out = ref(0);
  assert.equal(readStream.serializeUint32(out), true);
  assert.equal(out.value, 1);
  assert.equal(readStream.serializeUint32(out), true);
  assert.equal(out.value, 2);

  // reset clears the latch
  stream.reset(buffer);
  assert.equal(stream.ok, true);
  assert.equal(stream.error, SerializeError.None);
});

spine('wide writes are still checked as one total width up front', gate, () => {
  const stream = new WriteStream(new Uint8Array(8));
  assert.equal(stream.serializeUint32(ref(7)), true);
  // 128 bits cannot fit the remaining 32: refused up front, NOTHING written
  assert.equal(stream.serializeUint128(ref(1n)), false);
  assert.equal(stream.error, SerializeError.Overflow);
  assert.equal(stream.bitsProcessed(), 32);
});

spine('an invalid bits count that throws in dev passes through in production', gate, () => {
  // dev: validateBits throws RangeError on every stream in every state
  // (streams.test.js proves it). production: the caller is trusted -- the
  // call passes through, and a following valid write is undisturbed.
  const stream = new WriteStream(new Uint8Array(8));
  assert.equal(stream.serializeBits(ref(5), 0), true);
  assert.equal(stream.bitsProcessed(), 0);
  assert.equal(stream.serializeUint8(ref(42)), true);
  stream.flush();

  const readStream = new ReadStream(stream.data());
  const out = ref(0);
  assert.equal(readStream.serializeUint8(out), true);
  assert.equal(out.value, 42);

  const measure = new MeasureStream();
  assert.equal(measure.serializeBits(ref(5), 0), true);
  assert.equal(measure.bitsProcessed(), 0);
});

spine('an out-of-range ranged write that latches in dev passes through in production', gate, () => {
  // dev: serializeInt latches ValueOutOfRange and writes nothing
  // (serialize-int-refusals.test.js proves it). production: the value is
  // the caller's contract -- the masked offset goes out, deterministically
  // (JavaScript wire arithmetic: 300 & 0xff = 44), and the reader decodes
  // that in-range garbage. Garbage in, garbage on the wire: the C release
  // contract, without undefined behavior.
  const stream = new WriteStream(new Uint8Array(8));
  assert.equal(stream.serializeInt(ref(300), 0, 255), true);
  assert.equal(stream.ok, true);
  assert.equal(stream.bitsProcessed(), 8);
  stream.flush();

  const readStream = new ReadStream(stream.data());
  const out = ref(0);
  assert.equal(readStream.serializeInt(out, 0, 255), true);
  assert.equal(out.value, 44);
});

spine('a wrong-typed value that throws in dev passes through in production', gate, () => {
  // dev: serializeFloat throws TypeError on a non-number. production: the
  // conversion inside the wire arithmetic absorbs it (ToNumber -> NaN) and
  // 32 bits go out.
  const stream = new WriteStream(new Uint8Array(8));
  assert.equal(stream.serializeFloat(ref('not a number')), true);
  assert.equal(stream.ok, true);
  assert.equal(stream.bitsProcessed(), 32);
});

spine('the wstring well-formedness scan is gone: the writer trusts, the reader refuses', gate, () => {
  // dev: a lone surrogate latches InvalidString on write -- the checked
  // form of the family's debug assert over the standard's named type case,
  // the O(n) scan no release path carries
  // (serialize-wstring-refusals.test.js proves it). production: the writer
  // trusts the caller and the ill-formed unit reaches the wire -- where a
  // CONFORMING READER refuses it, because ruling #8's read-side content
  // refusals bind in every mode.
  const stream = new WriteStream(new Uint8Array(8));
  assert.equal(stream.serializeWideString(ref('\uD800'), 4), true);
  assert.equal(stream.ok, true);
  stream.flush();

  const readStream = new ReadStream(stream.data());
  const out = ref('');
  assert.equal(readStream.serializeWideString(out, 4), false);
  assert.equal(readStream.error, SerializeError.InvalidString);
  assert.equal(out.value, '');
});

spine('a production measure cannot fail', gate, () => {
  // dev: an out-of-range value latches ValueOutOfRange on the measure too
  // (a message that cannot be written cannot be measured). production: the
  // measure is pure bit arithmetic, the C++ release shape -- it prices the
  // declaration and cannot fail.
  const measure = new MeasureStream();
  assert.equal(measure.serializeInt(ref(999), 0, 10), true);
  assert.equal(measure.ok, true);
  assert.equal(measure.error, SerializeError.None);
  assert.equal(measure.bitsProcessed(), 4); // bitsRequired(0, 10)
});

spine('the production bitpacker keeps exactly one hard check: tryWriteBits at the buffer end', gate, () => {
  const writer = new BitWriter(new Uint8Array(8));

  // dev: writeBits(value, 0) throws RangeError (bitwriter.test.js proves
  // it). production: no validation -- the call passes through as a 0-bit
  // no-op.
  writer.writeBits(1, 0);
  assert.equal(writer.bitsWritten(), 0);

  // the retained hard check: a past-end tryWriteBits refuses as a value,
  // writing nothing -- the false the stream layer latches Overflow from
  assert.equal(writer.tryWriteBits(0xffffffff, 32), true);
  assert.equal(writer.tryWriteBits(0xffffffff, 32), true);
  assert.equal(writer.tryWriteBits(1, 1), false);
  assert.equal(writer.bitsWritten(), 64);
});
