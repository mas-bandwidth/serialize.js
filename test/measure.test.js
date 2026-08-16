// Measure tests: a measure is a conservative BOUND, never exact
// (STANDARD.md, "The Measure Stream"). The one testable law: for every
// message, measure >= bits written, at EVERY starting bit position -- the
// pad an align writes depends on where the message lands in the final bit
// stream, and the measure does not know, so it charges the worst case 7
// bits per alignment-performing operation. The standard's worked example
// discriminates conforming from exact-from-zero accounting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WriteStream, MeasureStream } from '../src/index.js';

// Mixed op sequences as data: ['bits', value, width] | ['align']. One
// runner drives any stream, so the measured ops and the written ops are the
// same by construction.
function runOps(stream, ops) {
  for (const op of ops) {
    if (op[0] === 'bits') {
      assert.equal(stream.serializeBits({ value: op[1] }, op[2]), true);
    } else {
      assert.equal(stream.serializeAlign(), true);
    }
  }
}

const SEQUENCES = [
  {
    name: 'the standard worked example { bits(8); align; bits(8) }',
    ops: [
      ['bits', 0xab, 8],
      ['align'],
      ['bits', 0xcd, 8],
    ],
    measured: 23, // 8 + 7 + 8: the discriminator, 16 would be exact-from-zero
  },
  {
    name: 'mixed widths with two aligns',
    ops: [
      ['bits', 5, 3],
      ['bits', 0x1ff, 9],
      ['align'],
      ['bits', 1, 1],
      ['align'],
      ['bits', 0xdeadbeef, 32],
    ],
    measured: 59, // 3 + 9 + 7 + 1 + 7 + 32
  },
  {
    name: 'align-free ops measure exactly at every offset',
    ops: [
      ['bits', 21, 5],
      ['bits', 0x7ffffff, 27],
      ['bits', 0xffffffff, 32],
    ],
    measured: 64, // no position-dependent op: the bound is tight everywhere
  },
  {
    name: 'consecutive aligns',
    ops: [['align'], ['align'], ['bits', 0x42, 7]],
    measured: 21, // 7 + 7 + 7: the second align is free on the wire, never in the measure
  },
];

test('measure >= bits written at every starting offset 0..7', () => {
  for (const { name, ops, measured } of SEQUENCES) {
    const measure = new MeasureStream();
    runOps(measure, ops);
    assert.equal(measure.bitsProcessed(), measured, name);

    for (let offset = 0; offset <= 7; offset++) {
      const writer = new WriteStream(new Uint8Array(32));
      if (offset > 0) {
        writer.serializeBits({ value: 0 }, offset);
      }
      const start = writer.bitsProcessed();
      runOps(writer, ops);
      const written = writer.bitsProcessed() - start;
      assert.ok(
        measure.bitsProcessed() >= written,
        `${name}: measure ${measure.bitsProcessed()} >= written ${written} at offset ${offset}`,
      );
      assert.equal(writer.ok, true);
    }
  }
});

test('the worked example discriminates: 23 bits, and offset 1 needs all of them', () => {
  // { bits(8); align; bits(8) } from an aligned start: the align is a no-op
  // and 16 bits are written -- the exact-from-zero answer, insufficient in
  // general. From bit offset 1 the align pads 7 bits and the message spans
  // 23 bits: the conservative measure is the smallest number sufficient at
  // every starting position.
  const ops = SEQUENCES[0].ops;

  const aligned = new WriteStream(new Uint8Array(32));
  runOps(aligned, ops);
  assert.equal(aligned.bitsProcessed(), 16);

  const offset1 = new WriteStream(new Uint8Array(32));
  offset1.serializeBits({ value: 0 }, 1);
  runOps(offset1, ops);
  assert.equal(offset1.bitsProcessed() - 1, 23);

  const measure = new MeasureStream();
  runOps(measure, ops);
  assert.equal(measure.bitsProcessed(), 23);
});

test('every alignment-performing op is charged 7 bits even when the count is aligned', () => {
  // at bit 8 a write's align would pad zero bits; the measure still
  // charges 7, because the message may land unaligned
  const measure = new MeasureStream();
  measure.serializeBits({}, 8);
  measure.serializeAlign();
  assert.equal(measure.bitsProcessed(), 15);
  assert.equal(measure.alignBits(), 7);
});
