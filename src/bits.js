// bitsRequired: the arithmetic every ranged integer's wire cost derives
// from, ported exactly from serialize.h:
//
//     bits_required( min, max ) = ( min == max ) ? 0 : 32 - count_leading_zeros( max - min )
//
// Math.clz32 IS JavaScript's count-leading-zeros builtin, so this is the
// serialize.h __builtin_clz branch verbatim. The portable popcount/log2
// fallback in serialize.h exists only for compilers without the builtin,
// which JavaScript always has, so it is not ported.

const UINT32_RANGE_MESSAGE = 'min and max must be integers in [0,2^32-1]';
const UINT64_RANGE_MESSAGE = 'min and max must be BigInts in [0,2^64-1]';
const UINT128_RANGE_MESSAGE = 'min and max must be BigInts in [0,2^128-1]';

const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

/**
 * The number of bits required to serialize an integer in range [min,max]:
 * zero when min equals max (a degenerate range costs nothing on the wire,
 * per STANDARD.md), otherwise the bit length of max - min.
 *
 * The parameters live in the UNSIGNED 32-bit domain and the subtraction
 * wraps mod 2^32: a signed range is converted with >>> 0 first -- which can
 * leave min numerically above max -- and the wrap reproduces the C++ uint32
 * subtraction exactly. serializeInt performs that conversion internally;
 * call this directly to price fields when designing a message format.
 *
 * @param {number} min the minimum value, an integer in [0,2^32-1].
 * @param {number} max the maximum value, an integer in [0,2^32-1].
 * @returns {number} the bits required, in [0,32].
 */
export function bitsRequired(min, max) {
  if ((min >>> 0) !== min || (max >>> 0) !== max) {
    throw new RangeError(UINT32_RANGE_MESSAGE);
  }
  return min === max ? 0 : 32 - Math.clz32((max - min) >>> 0);
}

/**
 * The bit length of a nonzero unsigned 64-bit BigInt, computed in two 32-bit
 * lanes with Math.clz32 -- the serialize.h no-builtin branch of
 * bits_required64: high ? 32 + bits_required( 0, high ) : bits_required( 0, low ).
 * @param {bigint} x a BigInt in [1,2^64-1].
 * @returns {number} floor( log2( x ) ) + 1, in [1,64].
 */
function bitLength64(x) {
  const hi = Number(x >> 32n);
  return hi !== 0 ? 64 - Math.clz32(hi) : 32 - Math.clz32(Number(x));
}

/**
 * The number of bits required to serialize a 64-bit integer in range
 * [min,max]: zero when min equals max, otherwise the bit length of
 * max - min. Ported from serialize.h's bits_required64.
 *
 * The parameters live in the UNSIGNED 64-bit domain as BigInts and the
 * subtraction wraps mod 2^64: a signed range is converted with
 * BigInt.asUintN(64, x) first -- which can leave min numerically above
 * max -- and the wrap reproduces the C++ uint64 subtraction exactly, so
 * ranges wider than 2^63 are priced correctly. serializeInt64 performs that
 * conversion internally; call this directly to price fields when designing
 * a message format.
 *
 * @param {bigint} min the minimum value, a BigInt in [0,2^64-1].
 * @param {bigint} max the maximum value, a BigInt in [0,2^64-1].
 * @returns {number} the bits required, in [0,64].
 */
export function bitsRequired64(min, max) {
  if (
    typeof min !== 'bigint' || min < 0n || min > UINT64_MAX ||
    typeof max !== 'bigint' || max < 0n || max > UINT64_MAX
  ) {
    throw new RangeError(UINT64_RANGE_MESSAGE);
  }
  return min === max ? 0 : bitLength64(BigInt.asUintN(64, max - min));
}

/**
 * The number of bits required to serialize a 128-bit integer in range
 * [min,max]: zero when min equals max, otherwise the bit length of
 * max - min. Ported from serialize.h's bits_required128:
 * high ? 64 + bits_required64( 0, high ) : bits_required64( 0, low ).
 *
 * The parameters live in the UNSIGNED 128-bit domain as BigInts and the
 * subtraction wraps mod 2^128, so ranges wider than 2^127 are priced
 * correctly. serializeInt128 performs the signed-to-unsigned conversion
 * internally with BigInt.asUintN(128, x).
 *
 * @param {bigint} min the minimum value, a BigInt in [0,2^128-1].
 * @param {bigint} max the maximum value, a BigInt in [0,2^128-1].
 * @returns {number} the bits required, in [0,128].
 */
export function bitsRequired128(min, max) {
  if (
    typeof min !== 'bigint' || min < 0n || min > UINT128_MAX ||
    typeof max !== 'bigint' || max < 0n || max > UINT128_MAX
  ) {
    throw new RangeError(UINT128_RANGE_MESSAGE);
  }
  if (min === max) {
    return 0;
  }
  const diff = BigInt.asUintN(128, max - min);
  const hi = diff >> 64n;
  return hi !== 0n ? 64 + bitLength64(hi) : bitLength64(diff);
}
