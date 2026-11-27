// Deterministic replay and negative-control suite for the fuzz harness
// (fuzz/harness.js): runs hostileRead (two-sentinel + slack view + terminality)
// and roundTrip (write + tight buffer with 16-byte 0xAA canary + measure +
// read + trailing_data refusal) over directed per-operation first-refusal
// seeds and a fixed xorshift stream, then verifies that all six fuzz negative
// controls and both source-level SABOTAGE patches trap with FuzzCheckError.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ReadStream } from '../src/index.js';
import { NUM_OPS, splitInput, fuzzRead, hostileRead, roundTrip } from '../fuzz/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_URL = pathToFileURL(join(HERE, '..', 'fuzz', 'harness.js')).href;

const EXPECTED_FIRST_REFUSALS = [
  'bits',
  'int',
  'int32',
  'int64',
  'int64 ranged',
  'fixed32',
  'fixed64',
  'fixed128',
  'int128 ranged',
  'int128',
  'bool',
  'float',
  'double',
  'compressed float',
  'uint64',
  'uint128',
  'bits64',
  'bytes',
  'string',
  'end',
  'align',
  'int relative',
  'uint8',
  'uint16',
  'uint32',
];

function makeSeed(opsFill, payloadLen, payloadFill = 0x00, firstOp = null) {
  const buf = new Uint8Array(NUM_OPS + payloadLen);
  buf.fill(opsFill, 0, NUM_OPS);
  if (firstOp !== null) {
    buf[0] = firstOp;
  }
  buf.fill(payloadFill, NUM_OPS);
  return splitInput(buf);
}

function makeInputs(count) {
  const inputs = [];

  // Medium-tier int_relative seed.
  const tierSeed = new Uint8Array(NUM_OPS + 8);
  tierSeed[0] = 13;
  tierSeed[NUM_OPS + 3] = 50;
  inputs.push(splitInput(tierSeed));

  // Directed per-operation first-refusal seeds (including [0x04] x 32 + [0x00]
  // for bool PastEnd and every grouped sub-operation in cases 3, 8, and 15).
  for (let op = 0; op < 16; op++) {
    inputs.push(makeSeed(op, 1, op === 11 ? 0xff : 0x00));
  }
  // Case 3 grouped members: int64, int64 ranged, fixed32, fixed64, fixed128, int128 ranged, int128.
  for (const len of [4, 12, 17, 21, 29, 39, 42]) {
    inputs.push(makeSeed(3, len, 0x00));
  }
  // Case 8 grouped members: uint64, uint128, bits64.
  for (const len of [1, 8, 24]) {
    inputs.push(makeSeed(8, len, 0x00));
  }
  // Case 9: bytes(17) on 1-byte stream.
  inputs.push(makeSeed(0x19, 1, 0x00));
  // Case 12: align after 1 bit on 0xff byte.
  inputs.push(makeSeed(12, 1, 0xff, 4));
  // Case 15 grouped members: uint8 (after 1 bit), uint16 (1 byte), uint32 (3 bytes).
  inputs.push(makeSeed(15, 1, 0x00, 0));
  inputs.push(makeSeed(15, 1, 0x00));
  inputs.push(makeSeed(15, 3, 0x00));

  let state = 0x9e3779b9;
  const nextByte = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state & 0xff;
  };

  for (let n = 0; n < count; n++) {
    const payloadLen = 1 + (nextByte() % 96);
    const buf = new Uint8Array(NUM_OPS + payloadLen);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = nextByte();
    }
    if (n % 7 === 0) {
      buf.fill(n % 2 === 0 ? 0x00 : 0xff, NUM_OPS);
    }
    inputs.push(splitInput(buf));
  }
  return inputs;
}

const INPUTS = makeInputs(128);

test('fuzz replay: hostileRead and roundTrip pass on deterministic corpus and cover every operation on first refusal', () => {
  const seenFirstRefusals = new Set();
  for (const { ops, payload } of INPUTS) {
    hostileRead(ops, payload);
    roundTrip(ops, payload);
    const trace = fuzzRead(new ReadStream(payload), ops);
    const firstRefusal = trace.find((entry) => entry.startsWith('!'));
    if (firstRefusal !== undefined) {
      const colon = firstRefusal.indexOf(':');
      seenFirstRefusals.add(firstRefusal.slice(1, colon));
    }
  }
  for (const name of EXPECTED_FIRST_REFUSALS) {
    assert.ok(seenFirstRefusals.has(name), `missing first-refusal coverage for ${name}`);
  }
});

test('fuzz negative controls: hostileRead traps on sentinel, hostile, and terminality controls', () => {
  const cases = [
    { control: 'sentinel', match: /refused but modified its destination/ },
    { control: 'hostile', match: /int(\s+\[0,\d+\])?\s+read\s+1000000/ },
    { control: 'terminality', match: /moved cursor .* after refusal/ },
  ];

  for (const { control, match } of cases) {
    assert.throws(
      () => {
        for (const { ops, payload } of INPUTS) {
          hostileRead(ops, payload, control);
        }
      },
      match,
      `expected hostileRead control ${control} to trap`,
    );
  }
});

test('fuzz negative controls: roundTrip traps on roundtrip, canary, and trailing controls', () => {
  const cases = [
    { control: 'roundtrip', match: /wrote .*, read back Symbol\(corrupted\)|wrote (true|false), read back (true|false)/ },
    { control: 'canary', match: /canary byte 0 corrupted/ },
    { control: 'trailing', match: /one byte past the writer was accepted at the end/ },
  ];

  for (const { control, match } of cases) {
    assert.throws(
      () => {
        for (const { ops, payload } of INPUTS) {
          roundTrip(ops, payload, control);
        }
      },
      match,
      `expected roundTrip control ${control} to trap`,
    );
  }
});

test('fuzz SABOTAGE controls: sentinel-clobber and int-relative-tier trap on replay', () => {
  const script = `
    import { NUM_OPS, splitInput, hostileRead, roundTrip } from ${JSON.stringify(HARNESS_URL)};
    const tierSeed = new Uint8Array(NUM_OPS + 8);
    tierSeed[0] = 13;
    tierSeed[NUM_OPS + 3] = 50;
    {
      const { ops, payload } = splitInput(tierSeed);
      hostileRead(ops, payload);
      roundTrip(ops, payload);
    }
    const boolSeed = new Uint8Array(NUM_OPS + 1);
    boolSeed.fill(4, 0, NUM_OPS);
    {
      const { ops, payload } = splitInput(boolSeed);
      hostileRead(ops, payload);
      roundTrip(ops, payload);
    }
    let state = 0x9e3779b9;
    const nextByte = () => {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return state & 0xff;
    };
    for (let n = 0; n < 256; n++) {
      const buf = new Uint8Array(NUM_OPS + 1 + (nextByte() % 64));
      for (let i = 0; i < buf.length; i++) buf[i] = nextByte();
      const { ops, payload } = splitInput(buf);
      hostileRead(ops, payload);
      roundTrip(ops, payload);
    }
  `;

  for (const [sabotage, expected] of [
    ['sentinel-clobber', /fuzz check failed: .* refused but modified its destination/],
    ['int-relative-tier', /fuzz check failed: int relative/],
  ]) {
    assert.throws(
      () => {
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, SERIALIZE_FUZZ_SABOTAGE: sabotage },
          stdio: 'pipe',
        });
      },
      (err) => expected.test(String(err.stderr)),
      `expected SABOTAGE ${sabotage} to trap`,
    );
  }
});
