// Stream tests: WriteStream, ReadStream and MeasureStream share one
// bool-returning serialize-method surface, so a single serialize function
// writes, reads and measures the same fields. This file proves the triangle
// on a small mixed sequence -- write it, read it back through the same
// function, measure it, pin the wire bytes -- plus the flags, reset reuse,
// and the shared caller contract.

import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
} from '../src/index.js';
import { misuse } from './misuse.js';

// The family's unified serialize pattern: ONE function, three streams. refs
// are { value } holders -- JavaScript's stand-in for the family's ref
// parameters. On write the values are consumed, on read they are filled in,
// on measure they are checked as the write would check them.
function serializeSequence(stream, refs) {
  return (
    stream.serializeBits(refs.a, 5) &&
    stream.serializeAlign() &&
    stream.serializeBits(refs.b, 32) &&
    stream.serializeBits(refs.c, 3) &&
    stream.serializeAlign() &&
    stream.serializeBits(refs.d, 8)
  );
}

test('the flags tell a serialize function which way data flows', () => {
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(writer.isWriting, true);
  assert.equal(writer.isReading, false);

  const reader = new ReadStream(new Uint8Array(1));
  assert.equal(reader.isWriting, false);
  assert.equal(reader.isReading, true);

  // a measure stream acts like a write stream, so a unified serialize
  // function measures exactly what it would write
  const measure = new MeasureStream();
  assert.equal(measure.isWriting, true);
  assert.equal(measure.isReading, false);
});

test('write/read/measure triangle on a small sequence', () => {
  // write
  const writeRefs = {
    a: { value: 21 },
    b: { value: 0xdeadbeef },
    c: { value: 5 },
    d: { value: 0xc3 },
  };
  const writer = new WriteStream(new Uint8Array(8));
  assert.equal(serializeSequence(writer, writeRefs), true);
  assert.equal(writer.ok, true);
  assert.equal(writer.error, SerializeError.None);
  writer.flush();
  // 5 + 3 pad + 32 + 3 + 5 pad + 8 = 56 bits, 7 bytes
  assert.equal(writer.bitsProcessed(), 56);
  assert.equal(writer.bytesProcessed(), 7);
  // Derivation: a=21=0b10101 in bits 0..4, align pads bits 5..7 ->
  // byte 0 = 0x15; b=0xDEADBEEF byte aligned in bytes 1..4, little-endian
  // bit stream -> EF BE AD DE; c=5=0b101 in bits 40..42, align pads
  // 43..47 -> byte 5 = 0x05; d=0xC3 byte aligned in byte 6.
  assert.deepEqual(
    Array.from(writer.data()),
    [0x15, 0xef, 0xbe, 0xad, 0xde, 0x05, 0xc3],
  );

  // read back through the SAME function: fresh refs get filled in
  const readRefs = { a: {}, b: {}, c: {}, d: {} };
  const reader = new ReadStream(writer.data());
  assert.equal(serializeSequence(reader, readRefs), true);
  assert.equal(reader.ok, true);
  assert.equal(reader.error, SerializeError.None);
  assert.equal(readRefs.a.value, 21);
  assert.equal(readRefs.b.value, 0xdeadbeef);
  assert.equal(readRefs.c.value, 5);
  assert.equal(readRefs.d.value, 0xc3);
  assert.equal(reader.bitsProcessed(), 56);
  assert.equal(reader.bytesProcessed(), 7);

  // measure through the SAME function: every align charged the worst case
  // 7 bits -> 5 + 7 + 32 + 3 + 7 + 8 = 62, a bound above the 56 written
  const measure = new MeasureStream();
  assert.equal(serializeSequence(measure, writeRefs), true);
  assert.equal(measure.ok, true);
  assert.equal(measure.bitsProcessed(), 62);
  assert.equal(measure.bytesProcessed(), 8);
  assert.ok(measure.bitsProcessed() >= writer.bitsProcessed());
});

test('alignBits reports the true pad on write and read, worst case on measure', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 1 }, 3);
  assert.equal(writer.alignBits(), 5);
  writer.serializeAlign();
  assert.equal(writer.alignBits(), 0);
  writer.flush();

  const reader = new ReadStream(writer.data());
  reader.serializeBits({}, 3);
  assert.equal(reader.alignBits(), 5);
  reader.serializeAlign();
  assert.equal(reader.alignBits(), 0);

  // the measure does not know where the message lands: always 7
  const measure = new MeasureStream();
  assert.equal(measure.alignBits(), 7);
  measure.serializeBits({ value: 0 }, 8);
  assert.equal(measure.alignBits(), 7);
});

test('reset clears the streams for allocation-free reuse', () => {
  const writer = new WriteStream(new Uint8Array(8));
  writer.serializeBits({ value: 0xff }, 8);
  writer.reset(new Uint8Array(8));
  assert.equal(writer.bitsProcessed(), 0);
  assert.equal(writer.ok, true);
  assert.equal(writer.serializeBits({ value: 0x2a }, 8), true);
  writer.flush();
  assert.deepEqual(Array.from(writer.data()), [0x2a]);

  const reader = new ReadStream(writer.data());
  const ref = {};
  reader.serializeBits(ref, 8);
  assert.equal(ref.value, 0x2a);
  reader.reset(writer.data());
  assert.equal(reader.bitsProcessed(), 0);
  reader.serializeBits(ref, 4);
  assert.equal(ref.value, 0xa);

  const measure = new MeasureStream();
  measure.serializeBits({ value: 0 }, 13);
  measure.serializeAlign();
  assert.equal(measure.bitsProcessed(), 20);
  measure.reset();
  assert.equal(measure.bitsProcessed(), 0);
  assert.equal(measure.ok, true);
});

test('an invalid bits count is caller misuse: it throws on write and measure, and refuses on read', () => {
  const writer = new WriteStream(new Uint8Array(8));
  const reader = new ReadStream(new Uint8Array(8));
  const measure = new MeasureStream();
  for (const stream of [writer, reader, measure]) {
    for (const bits of [0, 33, -1, 2.5, NaN]) {
      misuse(stream, () => stream.serializeBits({ value: 0 }, bits), RangeError);
    }
    // misuse throws even though nothing latched: the streams stay healthy
    assert.equal(stream.ok, !stream.isReading);
    assert.equal(stream.bitsProcessed(), 0);
  }
});

// A ref may be any object with a value property, a getter included. Each
// write and measure reads ref.value exactly once, so the value it checks is
// the value it encodes, and a getter that runs another serializeFixed cannot
// change the outer call's declaration. Self-contained: it runs in a child
// process under each mode, because the mode is fixed at module load.
function getterHolderReport({ WriteStream, MeasureStream }) {
  const counting = (value) => {
    const holder = { reads: 0 };
    Object.defineProperty(holder, 'value', {
      get() {
        holder.reads += 1;
        return value;
      },
    });
    return holder;
  };
  const operations = [
    ['serializeBits', 9, (stream, ref) => stream.serializeBits(ref, 8)],
    ['serializeUint8', 9, (stream, ref) => stream.serializeUint8(ref)],
    ['serializeUint16', 9, (stream, ref) => stream.serializeUint16(ref)],
    ['serializeUint32', 9, (stream, ref) => stream.serializeUint32(ref)],
    ['serializeFixed', 9, (stream, ref) => stream.serializeFixed(ref, 8, 0, 0, 100)],
    ['serializeFixed wide', 9n, (stream, ref) => stream.serializeFixed(ref, 32, 32, 0n, 100n)],
  ];
  const reads = operations.map(([name, value, operation]) => {
    const writeRef = counting(value);
    operation(new WriteStream(new Uint8Array(16)), writeRef);
    const measureRef = counting(value);
    operation(new MeasureStream(), measureRef);
    return { name, write: writeRef.reads, measure: measureRef.reads };
  });

  // the getter runs a serializeFixed with another declaration before it
  // answers: the outer call must still use its own
  const reentrant = {
    get value() {
      new WriteStream(new Uint8Array(8)).serializeFixed({ value: 0 }, 16, 0, -1000, 1000);
      new MeasureStream().serializeFixed({ value: 0 }, 16, 0, -1000, 1000);
      return 42;
    },
  };
  const fixed = (ref) => {
    const writer = new WriteStream(new Uint8Array(8));
    writer.serializeFixed(ref, 8, 0, 0, 100);
    writer.flush();
    const measure = new MeasureStream();
    measure.serializeFixed(ref, 8, 0, 0, 100);
    return { bytes: Array.from(writer.data()), bits: writer.bitsProcessed(), measured: measure.bitsProcessed() };
  };
  return { reads, reentrant: fixed(reentrant), plain: fixed({ value: 42 }) };
}

function getterHolderReportUnder(nodeEnv) {
  const index = new URL('../src/index.js', import.meta.url).href;
  const script = `import * as api from ${JSON.stringify(index)};\n` +
    `process.stdout.write(JSON.stringify((${getterHolderReport.toString()})(api)));\n`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: nodeEnv },
  });
  assert.equal(result.status, 0, `NODE_ENV=${nodeEnv} child exited with ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

for (const nodeEnv of ['development', 'production']) {
  test(`a getter on ref.value is read once per write and measure, and cannot clobber serializeFixed (NODE_ENV=${nodeEnv})`, () => {
    const report = getterHolderReportUnder(nodeEnv);
    for (const { name, write, measure } of report.reads) {
      assert.equal(write, 1, `${name}: write reads ref.value ${write} times`);
      // a production measure trusts the value and may not read it at all
      if (nodeEnv === 'production') {
        assert.ok(measure <= 1, `${name}: measure reads ref.value ${measure} times`);
      } else {
        assert.equal(measure, 1, `${name}: measure reads ref.value ${measure} times`);
      }
    }
    assert.deepEqual(report.reentrant, report.plain);
  });
}
