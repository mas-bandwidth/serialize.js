// bitsRequired tests: the arithmetic every ranged integer's wire cost
// derives from. Every expectation is cross-checked in a comment against
// serialize.h's bits_required:
//
//     bits_required( min, max ) = ( min == max ) ? 0 : 32 - __builtin_clz( max - min )
//
// with the subtraction performed in uint32, wrapping mod 2^32.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bitsRequired } from '../src/index.js';

test('degenerate min == max costs zero bits', () => {
  // STANDARD.md "Integers": the value is known from the range alone and
  // nothing is written. serialize.h: ( min == max ) ? 0 : ...
  assert.equal(bitsRequired(0, 0), 0);
  assert.equal(bitsRequired(42, 42), 0);
  assert.equal(bitsRequired(0xffffffff, 0xffffffff), 0);
});

test('bitsRequired matches serialize.h across range shapes', () => {
  // the STANDARD's own examples
  assert.equal(bitsRequired(0, 7), 3); // 32 - clz(7) = 32 - 29 = 3
  assert.equal(bitsRequired(0, 8), 4); // 32 - clz(8) = 32 - 28 = 4

  // narrow ranges
  assert.equal(bitsRequired(0, 1), 1); // 32 - clz(1) = 32 - 31 = 1
  assert.equal(bitsRequired(0, 2), 2); // 32 - clz(2) = 32 - 30 = 2
  assert.equal(bitsRequired(0, 3), 2); // diff 3, still 2 bits
  assert.equal(bitsRequired(0, 4), 3); // diff 4 needs a third bit

  // power-of-two edges: a diff of 2^n - 1 costs n bits, 2^n costs n + 1
  assert.equal(bitsRequired(0, 255), 8); //   32 - clz(255)        =  8
  assert.equal(bitsRequired(0, 256), 9); //   32 - clz(256)        =  9
  assert.equal(bitsRequired(0, 65535), 16); // 32 - clz(65535)     = 16
  assert.equal(bitsRequired(0, 65536), 17); // 32 - clz(65536)     = 17
  assert.equal(bitsRequired(0, 0x7fffffff), 31); // 32 - clz(2^31-1) = 31
  assert.equal(bitsRequired(0, 0x80000000), 32); // 32 - clz(2^31)   = 32
  assert.equal(bitsRequired(0, 0xffffffff), 32); // 32 - clz(2^32-1) = 32

  // only the offset matters, never the endpoints
  assert.equal(bitsRequired(100, 107), 3); // diff 7: same as [0,7]
  assert.equal(bitsRequired(1000, 1001), 1); // diff 1: one bit
  assert.equal(bitsRequired(0xfffffff8, 0xffffffff), 3); // diff 7 at the top
});

test('the subtraction wraps mod 2^32: signed ranges arrive converted', () => {
  // serializeInt converts int32 bounds with >>> 0, so in the unsigned
  // domain min can EXCEED max and the subtraction must wrap -- exactly the
  // C++ uint32 arithmetic in serialize.h.
  // [-5,5]: (5 - 4294967291) mod 2^32 = 10 -> 32 - clz(10) = 4
  assert.equal(bitsRequired(-5 >>> 0, 5 >>> 0), 4);
  // [-128,127]: diff 255 -> 8 bits
  assert.equal(bitsRequired(-128 >>> 0, 127 >>> 0), 8);
  // [-1,0]: diff 1 -> 1 bit
  assert.equal(bitsRequired(-1 >>> 0, 0), 1);
  // full-range int32: diff 0xFFFFFFFF -> 32 bits
  assert.equal(bitsRequired(-2147483648 >>> 0, 2147483647 >>> 0), 32);
});

test('parameters outside the unsigned 32-bit domain are misuse and throw', () => {
  for (const bad of [-1, 0x100000000, 1.5, NaN, '7', null, undefined]) {
    assert.throws(() => bitsRequired(bad, 10), RangeError);
    assert.throws(() => bitsRequired(0, bad), RangeError);
  }
});
