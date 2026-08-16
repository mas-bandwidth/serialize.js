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
