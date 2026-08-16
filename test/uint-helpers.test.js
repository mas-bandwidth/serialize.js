// Fixed-width helper tests: serializeUint8/16/32 are aliases for
// serializeBits at 8, 16 and 32 bits carrying no range information of
// their own, and serializeBool is one bit (STANDARD.md "Bit-Level
// Primitives"). Wire bytes are pinned, overflow refusals are proven both
// ways, and the three streams speak the helpers through one unified
// serialize function.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';

test('pinned wire bytes: byte-aligned helpers are little-endian identity', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.serializeUint8({ value: 0xc3 }), true);
  assert.equal(writer.serializeUint16({ value: 0xbeef }), true);
  assert.equal(writer.serializeUint32({ value: 0xdeadbeef }), true);
  writer.flush();
  assert.equal(writer.bitsProcessed(), 56);
  assert.deepEqual(
    Array.from(writer.data()),
    [0xc3, 0xef, 0xbe, 0xef, 0xbe, 0xad, 0xde],
  );

  const reader = new ReadStream(writer.data());
  const a = {};
  const b = {};
  const c = {};
  assert.equal(reader.serializeUint8(a), true);
  assert.equal(reader.serializeUint16(b), true);
  assert.equal(reader.serializeUint32(c), true);
  assert.equal(a.value, 0xc3);
  assert.equal(b.value, 0xbeef);
  assert.equal(c.value, 0xdeadbeef);
});

test('pinned wire bytes: bools are single bits, LSB first', () => {
  // true, false, true, true -> bits 0..3 = 1,0,1,1 -> byte 0x0D
  const writer = new WriteStream(new Uint8Array(8));
  for (const value of [true, false, true, true]) {
    assert.equal(writer.serializeBool({ value }), true);
  }
  writer.flush();
  assert.equal(writer.bitsProcessed(), 4);
  assert.deepEqual(Array.from(writer.data()), [0x0d]);

  const reader = new ReadStream(writer.data());
  const ref = {};
  const expected = [true, false, true, true];
  for (const want of expected) {
    assert.equal(reader.serializeBool(ref), true);
    assert.equal(ref.value, want); // strict: a REAL boolean, not 0/1
  }
});

test('helpers carry no alignment: a bool shifts a uint8 mid-byte', () => {
  // bit 0 = 1 (bool true), bits 1..8 = 0xFF -> bytes FF 01
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBool({ value: true });
  writer.serializeUint8({ value: 0xff });
  writer.flush();
  assert.equal(writer.bitsProcessed(), 9);
  assert.deepEqual(Array.from(writer.data()), [0xff, 0x01]);

  const reader = new ReadStream(writer.data());
  const flag = {};
  const byte = {};
  assert.equal(reader.serializeBool(flag), true);
  assert.equal(reader.serializeUint8(byte), true);
  assert.equal(flag.value, true);
  assert.equal(byte.value, 0xff);
});

test('domain boundary values round trip', () => {
  const writer = new WriteStream(new Uint8Array(16));
  writer.serializeUint8({ value: 0 });
  writer.serializeUint8({ value: 0xff });
  writer.serializeUint16({ value: 0 });
  writer.serializeUint16({ value: 0xffff });
  writer.serializeUint32({ value: 0 });
  writer.serializeUint32({ value: 0xffffffff });
  assert.equal(writer.ok, true);
  writer.flush();

  const reader = new ReadStream(writer.data());
  const expected = [
    ['serializeUint8', 0],
    ['serializeUint8', 0xff],
    ['serializeUint16', 0],
    ['serializeUint16', 0xffff],
    ['serializeUint32', 0],
    ['serializeUint32', 0xffffffff],
  ];
  for (const [method, want] of expected) {
    const ref = {};
    assert.equal(reader[method](ref), true);
    assert.equal(ref.value, want);
  }
});

test('higher bits are ignored: the call-site conversion of the family', () => {
  // the other ports take uint8/uint16/uint32 parameters, converting at the
  // call site; here the helper masks to its width the same way
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeUint8({ value: 0x1c3 }); // low 8 bits: 0xC3
  writer.serializeUint16({ value: 0x5beef }); // low 16 bits: 0xBEEF
  writer.serializeUint32({ value: 0x1_0000_0005 }); // low 32 bits: 5
  writer.flush();

  const reader = new ReadStream(writer.data());
  const a = {};
  const b = {};
  const c = {};
  reader.serializeUint8(a);
  reader.serializeUint16(b);
  reader.serializeUint32(c);
  assert.equal(a.value, 0xc3);
  assert.equal(b.value, 0xbeef);
  assert.equal(c.value, 5);
});

// Consumes or writes exactly n prefix bits through serializeBits, in
// chunks that respect its [1,32] contract.
function processPrefix(stream, n) {
  while (n > 0) {
    const chunk = Math.min(n, 32);
    stream.serializeBits({ value: 0 }, chunk);
    n -= chunk;
  }
}

test('truncated data refused as Overflow, the exact fit accepted', () => {
  const cases = [
    ['serializeUint8', 8],
    ['serializeUint16', 16],
    ['serializeUint32', 32],
    ['serializeBool', 1],
  ];
  for (const [method, bits] of cases) {
    // one bit short: refused, ref untouched
    const data = new Uint8Array(Math.ceil(bits / 8));
    const refused = new ReadStream(data);
    processPrefix(refused, data.length * 8 - bits + 1);
    const ref = { value: 999 };
    assert.equal(refused[method](ref), false, `${method} refused when short`);
    assert.equal(refused.error, SerializeError.Overflow);
    assert.equal(ref.value, 999);

    // the exact fit: accepted
    const accepted = new ReadStream(data);
    processPrefix(accepted, data.length * 8 - bits);
    assert.equal(accepted[method](ref), true, `${method} fits exactly`);
    assert.equal(accepted.ok, true);
  }
});

test('a write past the end latches Overflow, the exact fit succeeds', () => {
  const cases = [
    ['serializeUint8', 8, { value: 0 }],
    ['serializeUint16', 16, { value: 0 }],
    ['serializeUint32', 32, { value: 0 }],
    ['serializeBool', 1, { value: true }],
  ];
  for (const [method, bits, ref] of cases) {
    const fits = new WriteStream(new Uint8Array(8));
    processPrefix(fits, 64 - bits);
    assert.equal(fits[method](ref), true, `${method} fits exactly`);
    assert.equal(fits.bitsProcessed(), 64);

    const overflows = new WriteStream(new Uint8Array(8));
    processPrefix(overflows, 64 - bits + 1);
    assert.equal(overflows[method](ref), false, `${method} overflows`);
    assert.equal(overflows.error, SerializeError.Overflow);
    assert.equal(overflows.bitsProcessed(), 64 - bits + 1); // nothing written
  }
});

test('measures are exact for the fixed-width helpers', () => {
  const measure = new MeasureStream();
  assert.equal(measure.serializeUint8({}), true);
  assert.equal(measure.bitsProcessed(), 8);
  assert.equal(measure.serializeUint16({}), true);
  assert.equal(measure.bitsProcessed(), 24);
  assert.equal(measure.serializeUint32({}), true);
  assert.equal(measure.bitsProcessed(), 56);
  assert.equal(measure.serializeBool({}), true);
  assert.equal(measure.bitsProcessed(), 57);
});

test('a latched stream refuses every helper without touching refs', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeBits({ value: 0 }, 32);
  writer.serializeUint8({ value: 1 }); // latches Overflow
  assert.equal(writer.error, SerializeError.Overflow);
  assert.equal(writer.serializeUint16({ value: 2 }), false);
  assert.equal(writer.serializeUint32({ value: 3 }), false);
  assert.equal(writer.serializeBool({ value: true }), false);
  assert.equal(writer.error, SerializeError.Overflow);

  const reader = new ReadStream(new Uint8Array(0));
  const ref = { value: 999 };
  reader.serializeBool(ref); // latches Overflow
  assert.equal(reader.serializeUint8(ref), false);
  assert.equal(reader.serializeUint16(ref), false);
  assert.equal(reader.serializeUint32(ref), false);
  assert.equal(ref.value, 999);
});

// The family's unified serialize pattern across the whole chunk-4 surface:
// ONE function, three streams.
function serializeMessage(stream, refs) {
  return (
    stream.serializeBool(refs.alive) &&
    stream.serializeInt(refs.health, 0, 100) &&
    stream.serializeUint8(refs.flags) &&
    stream.serializeInt(refs.dx, -5, 5) &&
    stream.serializeUint16(refs.itemId) &&
    stream.serializeUint32(refs.sequence) &&
    stream.serializeInt(refs.version, 3, 3) // degenerate: zero bits
  );
}

test('write/read/measure triangle across the integer surface', () => {
  const writeRefs = {
    alive: { value: true },
    health: { value: 73 },
    flags: { value: 0xa5 },
    dx: { value: -3 },
    itemId: { value: 0x1234 },
    sequence: { value: 0xdeadbeef },
    version: { value: 3 },
  };
  const writer = new WriteStream(new Uint8Array(16));
  assert.equal(serializeMessage(writer, writeRefs), true);
  assert.equal(writer.ok, true);
  writer.flush();
  // 1 + 7 + 8 + 4 + 16 + 32 + 0 = 68 bits
  assert.equal(writer.bitsProcessed(), 68);

  const readRefs = {
    alive: {},
    health: {},
    flags: {},
    dx: {},
    itemId: {},
    sequence: {},
    version: {},
  };
  const reader = new ReadStream(writer.data());
  assert.equal(serializeMessage(reader, readRefs), true);
  assert.equal(reader.ok, true);
  assert.equal(readRefs.alive.value, true);
  assert.equal(readRefs.health.value, 73);
  assert.equal(readRefs.flags.value, 0xa5);
  assert.equal(readRefs.dx.value, -3);
  assert.equal(readRefs.itemId.value, 0x1234);
  assert.equal(readRefs.sequence.value, 0xdeadbeef);
  assert.equal(readRefs.version.value, 3);
  assert.equal(reader.bitsProcessed(), 68);

  // no alignment ops in the message, so the measure is exact here
  const measure = new MeasureStream();
  assert.equal(serializeMessage(measure, writeRefs), true);
  assert.equal(measure.bitsProcessed(), 68);
});
