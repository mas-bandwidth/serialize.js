// The caller's own refusal (STANDARD.md, "Refusal reasons", `rejected`;
// IMPLEMENTING.md, U2): ReadStream.reject() and a nested object whose
// serialize function fails with nothing latched both latch
// SerializeError.Rejected through the stream's one latch. It is terminal,
// the first reason wins, and it never throws. On a write or a measure there
// is nothing to refuse: the checked runtime throws the misuse, and the
// production variant returns false and latches nothing (U9).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeasureStream, ReadStream, SerializeError, WriteStream } from '../src/index.js';
import { PRODUCTION } from '../src/mode.js';

test('rejected is the ninth reason, spelled as the standard spells it', () => {
  assert.equal(SerializeError.Rejected, 'rejected');
});

test('reject latches rejected after well formed reads, and is terminal', () => {
  const stream = new ReadStream(Uint8Array.of(0x05, 0xab));
  const nibble = { value: -1 };
  assert.equal(stream.serializeBits(nibble, 4), true);
  assert.equal(nibble.value, 5);
  assert.equal(stream.reject(), false);
  assert.equal(stream.error, SerializeError.Rejected);
  assert.equal(stream.ok, false);

  // every later read refuses, consumes nothing and writes nothing
  const bitsBefore = stream.bitsProcessed();
  const after = { value: -1 };
  assert.equal(stream.serializeBits(after, 8), false);
  assert.equal(stream.serializeInt(after, 7, 7), false);
  assert.equal(after.value, -1);
  let called = false;
  assert.equal(stream.serializeObject(() => {
    called = true;
    return true;
  }), false);
  assert.equal(called, false);
  assert.equal(stream.bitsProcessed(), bitsBefore);
  assert.equal(stream.error, SerializeError.Rejected);
});

test('reject on a stream that already refused keeps the first reason', () => {
  const stream = new ReadStream(Uint8Array.of(0xfd, 0xab));
  assert.equal(stream.serializeBits({ value: 0 }, 3), true);
  assert.equal(stream.serializeAlign(), false);
  assert.equal(stream.error, SerializeError.NonzeroPadding);
  assert.equal(stream.reject(), false);
  assert.equal(stream.error, SerializeError.NonzeroPadding);
});

test('a second reject is an echo', () => {
  const stream = new ReadStream(new Uint8Array(1));
  assert.equal(stream.reject(), false);
  assert.equal(stream.reject(), false);
  assert.equal(stream.error, SerializeError.Rejected);
});

test('reset clears a rejection', () => {
  const stream = new ReadStream(new Uint8Array(1));
  stream.reject();
  stream.reset(Uint8Array.of(0x2a));
  assert.equal(stream.ok, true);
  const byte = { value: 0 };
  assert.equal(stream.serializeBits(byte, 8), true);
  assert.equal(byte.value, 0x2a);
});

test('an object whose serialize function returns false latches rejected', () => {
  const stream = new ReadStream(Uint8Array.of(0x05));
  assert.equal(stream.serializeObject((nested) => nested.serializeBits({ value: 0 }, 4) && false), false);
  assert.equal(stream.error, SerializeError.Rejected);
  assert.equal(stream.serializeBits({ value: 0 }, 1), false);
  assert.equal(stream.error, SerializeError.Rejected);
});

test('an object whose serialize function returns a non-true value latches rejected', () => {
  const stream = new ReadStream(Uint8Array.of(0x05));
  assert.equal(stream.serializeObject(() => undefined), false);
  assert.equal(stream.error, SerializeError.Rejected);
});

test('an object that fails after a refusal inside it keeps that refusal', () => {
  const stream = new ReadStream(Uint8Array.of(0xff));
  assert.equal(stream.serializeObject((nested) => nested.serializeBits({ value: 0 }, 16)), false);
  assert.equal(stream.error, SerializeError.PastEnd);
});

test('an object that swallows a refusal and returns true keeps that refusal', () => {
  const stream = new ReadStream(Uint8Array.of(0xff));
  assert.equal(stream.serializeObject((nested) => {
    nested.serializeBits({ value: 0 }, 16);
    return true;
  }), false);
  assert.equal(stream.error, SerializeError.PastEnd);
});

test('reject inside an object latches rejected and the object refuses', () => {
  const stream = new ReadStream(Uint8Array.of(0x05));
  assert.equal(stream.serializeObject((nested) => nested.reject()), false);
  assert.equal(stream.error, SerializeError.Rejected);
});

test('an object whose serialize function accepts is accepted', () => {
  const stream = new ReadStream(Uint8Array.of(0x1a));
  const nibble = { value: 0 };
  const flag = { value: false };
  assert.equal(stream.serializeObject((nested) => nested.serializeBits(nibble, 4) && nested.serializeBool(flag)), true);
  assert.equal(stream.ok, true);
  assert.equal(nibble.value, 10);
  assert.equal(flag.value, true);
});

test('reject on a write or a measure is misuse: checked throws, production returns false', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const measure = new MeasureStream();
  if (PRODUCTION) {
    assert.equal(writer.reject(), false);
    assert.equal(writer.error, SerializeError.None);
    assert.equal(measure.reject(), false);
    assert.equal(measure.error, SerializeError.None);
  } else {
    assert.throws(() => writer.reject(), TypeError);
    assert.throws(() => measure.reject(), TypeError);
    assert.equal(writer.error, SerializeError.None);
    assert.equal(measure.error, SerializeError.None);
  }
});
