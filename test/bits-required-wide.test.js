// bitsRequired64 / bitsRequired128 tests: the range-costing arithmetic for
// the wide integer domains, ported from serialize.h's bits_required64 and
// bits_required128. The parameters live in the unsigned domains and the
// subtraction wraps, so ranges wider than 2^63 / 2^127 price exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bitsRequired, bitsRequired64, bitsRequired128 } from '../src/index.js';

test('bitsRequired64 at every boundary the 32-bit arithmetic cannot reach', () => {
  // degenerate: zero bits
  assert.equal(bitsRequired64(0n, 0n), 0);
  assert.equal(bitsRequired64(2n ** 64n - 1n, 2n ** 64n - 1n), 0);

  // the STANDARD's examples hold at 64 bits: [0,7] is 3 bits, [0,8] is 4
  assert.equal(bitsRequired64(0n, 1n), 1);
  assert.equal(bitsRequired64(0n, 7n), 3);
  assert.equal(bitsRequired64(0n, 8n), 4);
  assert.equal(bitsRequired64(100n, 107n), 3); // offset range: diff decides

  // the 2^31 edge: [0,2^31-1] is 31 bits, [0,2^31] is 32
  assert.equal(bitsRequired64(0n, 2n ** 31n - 1n), 31);
  assert.equal(bitsRequired64(0n, 2n ** 31n), 32);

  // the 2^32 edge: [0,2^32-1] is 32 bits, [0,2^32] is 33 -- the first
  // range that does not exist in the 32-bit domain at all
  assert.equal(bitsRequired64(0n, 2n ** 32n - 1n), 32);
  assert.equal(bitsRequired64(0n, 2n ** 32n), 33);

  // the 2^63 edge and the full domain
  assert.equal(bitsRequired64(0n, 2n ** 63n - 1n), 63);
  assert.equal(bitsRequired64(0n, 2n ** 63n), 64);
  assert.equal(bitsRequired64(0n, 2n ** 64n - 1n), 64);
});

test('bitsRequired64 wraps mod 2^64: signed ranges wider than 2^63 are exact', () => {
  // full int64 range: umin = 2^63 (INT64_MIN converted), umax = 2^63-1,
  // diff wraps to 2^64-1 -> 64 bits
  const uminFull = BigInt.asUintN(64, -(2n ** 63n));
  const umaxFull = BigInt.asUintN(64, 2n ** 63n - 1n);
  assert.equal(uminFull > umaxFull, true); // conversion leaves min above max
  assert.equal(bitsRequired64(uminFull, umaxFull), 64);

  // [-1, 2^63-1]: diff wraps to 2^63 -> 64 bits
  assert.equal(bitsRequired64(BigInt.asUintN(64, -1n), 2n ** 63n - 1n), 64);

  // [-100,100]: the serialize.h test pin -- bits_required64(-100,100) == 8
  assert.equal(
    bitsRequired64(BigInt.asUintN(64, -100n), BigInt.asUintN(64, 100n)),
    8,
  );
});

test('bitsRequired64 agrees with bitsRequired on the shared domain', () => {
  const pairs = [
    [0, 0],
    [0, 1],
    [0, 7],
    [0, 8],
    [100, 107],
    [0, 255],
    [0, 65535],
    [0, 2147483647],
    [0, 4294967295],
    [4000000000, 4294967295],
  ];
  for (const [min, max] of pairs) {
    assert.equal(
      bitsRequired64(BigInt(min), BigInt(max)),
      bitsRequired(min, max),
      `[${min},${max}]`,
    );
  }
});

test('bitsRequired128 at every group boundary', () => {
  // degenerate: zero bits
  assert.equal(bitsRequired128(0n, 0n), 0);
  assert.equal(bitsRequired128(2n ** 128n - 1n, 2n ** 128n - 1n), 0);

  // small ranges price identically to the narrower arithmetic
  assert.equal(bitsRequired128(0n, 7n), 3);
  assert.equal(bitsRequired128(0n, 255n), 8);

  // the 2^32 edge: one group becomes two
  assert.equal(bitsRequired128(0n, 2n ** 32n - 1n), 32);
  assert.equal(bitsRequired128(0n, 2n ** 32n), 33);

  // the 2^64 edge: two groups become three
  assert.equal(bitsRequired128(0n, 2n ** 64n - 1n), 64);
  assert.equal(bitsRequired128(0n, 2n ** 64n), 65);

  // the 2^96 edge: three groups become four
  assert.equal(bitsRequired128(0n, 2n ** 96n - 1n), 96);
  assert.equal(bitsRequired128(0n, 2n ** 96n), 97);

  // the serialize.h golden range: [-2^70, 2^70] is 72 bits
  assert.equal(
    bitsRequired128(
      BigInt.asUintN(128, -(2n ** 70n)),
      BigInt.asUintN(128, 2n ** 70n),
    ),
    72,
  );

  // [-2^100, 2^100] is 102 bits: the serialize.h wide-band pin
  assert.equal(
    bitsRequired128(
      BigInt.asUintN(128, -(2n ** 100n)),
      BigInt.asUintN(128, 2n ** 100n),
    ),
    102,
  );

  // the 2^127 edge and the full domain
  assert.equal(bitsRequired128(0n, 2n ** 127n - 1n), 127);
  assert.equal(bitsRequired128(0n, 2n ** 127n), 128);
  assert.equal(bitsRequired128(0n, 2n ** 128n - 1n), 128);
});

test('bitsRequired128 wraps mod 2^128: signed ranges wider than 2^127 are exact', () => {
  // full int128 range: diff wraps to 2^128-1 -> 128 bits
  const uminFull = BigInt.asUintN(128, -(2n ** 127n));
  const umaxFull = BigInt.asUintN(128, 2n ** 127n - 1n);
  assert.equal(uminFull > umaxFull, true);
  assert.equal(bitsRequired128(uminFull, umaxFull), 128);
});

test('bitsRequired128 agrees with bitsRequired64 on the shared domain', () => {
  const pairs = [
    [0n, 0n],
    [0n, 1n],
    [0n, 255n],
    [0n, 2n ** 32n],
    [0n, 2n ** 63n],
    [0n, 2n ** 64n - 1n],
    [2n ** 60n, 2n ** 64n - 1n],
  ];
  for (const [min, max] of pairs) {
    assert.equal(
      bitsRequired128(min, max),
      bitsRequired64(min, max),
      `[${min},${max}]`,
    );
  }
});

test('parameters outside the unsigned domains are caller misuse and throw', () => {
  // bitsRequired64: Numbers, negatives and values past 2^64-1 all refuse
  assert.throws(() => bitsRequired64(0, 100), RangeError);
  assert.throws(() => bitsRequired64(0n, 100), RangeError);
  assert.throws(() => bitsRequired64(-1n, 100n), RangeError);
  assert.throws(() => bitsRequired64(0n, 2n ** 64n), RangeError);

  // bitsRequired128: same contract at the wider domain
  assert.throws(() => bitsRequired128(0, 100), RangeError);
  assert.throws(() => bitsRequired128(-1n, 100n), RangeError);
  assert.throws(() => bitsRequired128(0n, 2n ** 128n), RangeError);
});
