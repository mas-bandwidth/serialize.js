// Deterministic replay and negative-control suite for the fuzz harness
// (fuzz/harness.js): runs hostileRead (two-sentinel + slack view + terminality)
// and roundTrip (write + tight buffer with 16-byte 0xAA canary + measure +
// read + trailing_data refusal) over a fixed xorshift stream, then verifies
// that all six fuzz negative controls and both source-level SABOTAGE patches
// trap with FuzzCheckError.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NUM_OPS, splitInput, hostileRead, roundTrip } from '../fuzz/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = join(HERE, '..', 'fuzz', 'harness.js');

function makeInputs(count) {
  let state = 0x9e3779b9;
  const nextByte = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state & 0xff;
  };

  const inputs = [];
  const tierSeed = new Uint8Array(NUM_OPS + 8);
  tierSeed[0] = 13;
  tierSeed[NUM_OPS + 3] = 50;
  inputs.push(splitInput(tierSeed));

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

test('fuzz replay: hostileRead and roundTrip pass on deterministic xorshift corpus', () => {
  for (const { ops, payload } of INPUTS) {
    hostileRead(ops, payload);
    roundTrip(ops, payload);
  }
});

test('fuzz negative controls: hostileRead traps on sentinel, hostile, and terminality controls', () => {
  const cases = [
    { control: 'sentinel', match: /refused but modified its destination/ },
    { control: 'hostile', match: /hostile negative control/ },
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
    { control: 'roundtrip', match: /roundtrip negative control/ },
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
    import { NUM_OPS, splitInput, hostileRead, roundTrip } from ${JSON.stringify(HARNESS_PATH)};
    const tierSeed = new Uint8Array(NUM_OPS + 8);
    tierSeed[0] = 13;
    tierSeed[NUM_OPS + 3] = 50;
    {
      const { ops, payload } = splitInput(tierSeed);
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
    ['sentinel-clobber', /fuzz check failed: bits refused but modified its destination/],
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
