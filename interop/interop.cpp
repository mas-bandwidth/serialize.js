/*
    The C++ half of the cross language interop harness.

    Built in CI against the real C++ serialize library (github.com/mas-bandwidth/serialize)
    at the release the workflow pins, and run head to head with this port's half. Neither
    half is a local one-off: the exact release candidate in this repository exchanges bytes
    with the exact reference, on every push and pull request.

        interop write <file>    write the boundary message and hand the bytes over
        interop read  <file>    decode the other half's bytes, check every value, re-encode
                                and require the result to be byte identical to the input
        interop refuse <file>   every proper prefix of the other half's bytes is a truncated
                                stream, and every one of them must be REFUSED

    THE MESSAGE is the boundary set: every operation STANDARD.md defines, at the values where
    implementations disagree. Zero bit ranges on all three ranged widths and on fixed point;
    the domain edges of int, int64, int128 and int_relative; the maximum widths of bits,
    uint128 and the four group fixed point path; both sides of the alignment rule, including
    the align inside a zero length bytes; empty and full strings; and the wide string cases
    the surrogate rule governs, up to the largest code unit. Each section is preceded by an
    align, so a divergence localizes to a section instead of shifting every byte after it.

    WHAT IT DELIBERATELY DOES NOT CARRY: a NaN payload. STANDARD.md's bit transparency claim
    covers it, but a NaN's payload bits do not survive every language's float type on the way
    to the wire, so a difference here would say nothing about the wire format. Each port pins
    its own NaN patterns in its own suite, where the claim can be tested honestly.

    Build with asserts ON (no -DNDEBUG): they are the C++ half of "API misuse panics", and the
    degenerate ranges must pass with the library's own checks enabled rather than around them.

    The library tag is pinned in ONE place, .github/workflows/ci.yml, and this file names no
    version. Any change to the sequence below must be mirrored in this port's half, and never
    changes the wire format.
*/

#include "serialize.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

// ---------------------------------------------------------------------------------------
// section 1: raw bit groups, every width boundary

struct BitsVector { int bits; uint64_t value; };

static const BitsVector bits_vectors[] =
{
    {  1, 1 },                              // the minimum width, at its maximum value
    {  1, 0 },                              // and at its minimum
    {  7, 0x7F },                           // a sub-byte width, all ones
    { 31, 0x7FFFFFFF },                     // one below the single group maximum
    { 32, 0xFFFFFFFFULL },                  // the widest single group, all ones
    { 32, 0 },                              // and all zeros
    { 33, 0x1FFFFFFFFULL },                 // the first width past the 32 bit split
    { 64, 0xFFFFFFFFFFFFFFFFULL },          // the maximum width, all ones
    { 64, 0 },                              // and all zeros
};
static const int bits_count = (int) ( sizeof( bits_vectors ) / sizeof( bits_vectors[0] ) );

// ---------------------------------------------------------------------------------------
// section 3: the fixed width unsigned helpers at their domain edges

static const uint32_t uint8_values[]  = { 0x00u, 0xFFu };
static const uint32_t uint16_values[] = { 0x0000u, 0xFFFFu };
static const uint32_t uint32_values[] = { 0x00000000u, 0xFFFFFFFFu };
static const uint64_t uint64_values[] = { 0ULL, 0xFFFFFFFFFFFFFFFFULL };
static const int uint8_count  = (int) ( sizeof( uint8_values  ) / sizeof( uint8_values[0]  ) );
static const int uint16_count = (int) ( sizeof( uint16_values ) / sizeof( uint16_values[0] ) );
static const int uint32_count = (int) ( sizeof( uint32_values ) / sizeof( uint32_values[0] ) );
static const int uint64_count = (int) ( sizeof( uint64_values ) / sizeof( uint64_values[0] ) );

static const int uint128_count = 3;

// ---------------------------------------------------------------------------------------
// sections 5 to 7: the ranged integers

struct IntVector { int32_t min; int32_t max; int32_t value; };

static const IntVector int_vectors[] =
{
    { 42, 42, 42 },                                     // degenerate: zero bits, mid sequence
    { -100, +100, -100 },                               // the bottom of the range
    { -100, +100, +100 },                               // the top of the range
    { INT32_MIN, INT32_MAX, INT32_MIN },                // the full domain, 32 bits on the wire
    { INT32_MIN, INT32_MAX, INT32_MAX },
    { -100, +100, -37 },                                // a live field after the degenerate one
};
static const int int_count = (int) ( sizeof( int_vectors ) / sizeof( int_vectors[0] ) );

struct Int64Vector { int64_t min; int64_t max; int64_t value; };

static const Int64Vector int64_vectors[] =
{
    { 10000000000LL, 10000000000LL, 10000000000LL },    // degenerate, with bounds past 2^32
    { -5000000000LL, +5000000000LL, -5000000000LL },    // a range wider than 32 bits, bottom
    { -5000000000LL, +5000000000LL, +5000000000LL },    // and top
    { INT64_MIN, INT64_MAX, INT64_MIN },                // the full domain, 64 bits on the wire
    { INT64_MIN, INT64_MAX, INT64_MAX },
};
static const int int64_count = (int) ( sizeof( int64_vectors ) / sizeof( int64_vectors[0] ) );

static const int int128_count = 4;

// the 128 bit constants are built rather than tabulated: serialize::int128_t is native
// __int128 where the compiler has it and the emulated pair where it does not, and only one
// of those is a literal type.
static serialize::int128_t int128_min_value()
{
    return serialize::int128_t( serialize::uint128_t( 1 ) << 127 );
}

static serialize::int128_t int128_max_value()
{
    return ~int128_min_value();
}

// 2^100 + 7: a degenerate bound that no 64 bit path can carry
static serialize::int128_t int128_degenerate_value()
{
    return ( serialize::int128_t( 1 ) << 100 ) + serialize::int128_t( 7 );
}

// ---------------------------------------------------------------------------------------
// section 9: int_relative, every tier at both ends and the domain edges

struct RelativeVector { int32_t previous; int32_t current; };

static const RelativeVector relative_vectors[] =
{
    { 0, 1 },                               // one-bit
    { 0, 2 }, { 0, 6 },                     // bounded-3, both ends
    { 0, 7 }, { 0, 23 },                    // bounded-5
    { 0, 24 }, { 0, 280 },                  // bounded-9
    { 0, 281 }, { 0, 4377 },                // bounded-13
    { 0, 4378 }, { 0, 69914 },              // bounded-17
    { 0, 69915 },                           // absolute, at its smallest difference
    { 2147483646, 2147483647 },             // one-bit, at the top of the domain
    { 0, 2147483647 },                      // absolute, at the top of the domain
};
static const int relative_count = (int) ( sizeof( relative_vectors ) / sizeof( relative_vectors[0] ) );

// ---------------------------------------------------------------------------------------
// section 10: float and double, given as bit patterns so no decimal literal is parsed twice

static const uint32_t float_bits[] =
{
    0x00000000u,                            // +0
    0x80000000u,                            // -0
    0x7F800000u,                            // +infinity
    0xFF800000u,                            // -infinity
    0x7F7FFFFFu,                            // the largest finite float32
    0x00800000u,                            // the smallest normal
    0x00000001u,                            // the smallest subnormal
    0x3F800000u,                            // 1.0f
    0xBF800000u,                            // -1.0f
};
static const int float_count = (int) ( sizeof( float_bits ) / sizeof( float_bits[0] ) );

static const uint64_t double_bits[] =
{
    0x0000000000000000ULL,                  // +0
    0x8000000000000000ULL,                  // -0
    0x7FF0000000000000ULL,                  // +infinity
    0xFFF0000000000000ULL,                  // -infinity
    0x7FEFFFFFFFFFFFFFULL,                  // the largest finite float64
    0x0010000000000000ULL,                  // the smallest normal
    0x0000000000000001ULL,                  // the smallest subnormal
    0x3FF0000000000000ULL,                  // 1.0
    0xBFF0000000000000ULL,                  // -1.0
};
static const int double_count = (int) ( sizeof( double_bits ) / sizeof( double_bits[0] ) );

// ---------------------------------------------------------------------------------------
// section 11: compressed_float

struct CompressedFloatVector { float value; float min; float max; float res; };

static const CompressedFloatVector compressed_float_vectors[] =
{
    { 0.0f, 0.0f, 10.0f, 0.01f },                   // the bottom of the range: integer 0
    { 10.0f, 0.0f, 10.0f, 0.01f },                  // the top: the maximum integer
    { 0.005f, 0.0f, 10.0f, 0.01f },                 // between quanta: 1 under float32, 0 widened
    { 0.025f, 0.0f, 10.0f, 0.01f },                 // between quanta: 3 vs 2
    { 0.105f, 0.0f, 10.0f, 0.01f },                 // between quanta: 11 vs 10
    { 9.995f, 0.0f, 10.0f, 0.01f },                 // between quanta: 1000 vs 999
    { -100.0f, -100.0f, 100.0f, 0.01f },            // the bottom of a range with a non-zero min
    { -42.573f, -100.0f, 100.0f, 0.01f },           // off quantum over a non-zero min
    { 8388609.0f, 0.0f, 8388609.0f, 1.0f },         // clamp witness A: an unclamped writer emits
                                                    // a code its own reader rejects (schema#109)
    { 16777215.0f, 0.0f, 16777215.0f, 1.0f },       // clamp witness B: one bit wider than the field
    { 0.0f, 0.0f, 1.0f, 1.0f },                     // a one bit field, both codes
    { 1.0f, 0.0f, 1.0f, 1.0f },
};
static const int compressed_float_count = (int) ( sizeof( compressed_float_vectors ) / sizeof( compressed_float_vectors[0] ) );

// ---------------------------------------------------------------------------------------
// section 12: bytes. The block lengths, and the byte each block is filled with.

struct BytesVector { int length; uint8_t fill; };

static const BytesVector bytes_vectors[] =
{
    { 0, 0x00 },                            // zero length: the align happens anyway
    { 8, 0x00 },
    { 8, 0xFF },
    { 1, 0x5A },
};
static const int bytes_count = (int) ( sizeof( bytes_vectors ) / sizeof( bytes_vectors[0] ) );
static const int bytes_max = 8;

// ---------------------------------------------------------------------------------------
// section 13: string. buffer_size 16 throughout, so the length field is four bits.

static const int string_buffer_size = 16;
static const int string_count = 3;

// ---------------------------------------------------------------------------------------
// section 14: wstring. buffer_size 8 throughout: at most seven UTF-16 code units.

static const int wstring_buffer_size = 8;
static const int wstring_count = 6;

// the wide strings as explicit code points, so no source file encoding can reach the wire.
// On a four byte wchar_t the astral entry is one wchar_t and two code units, and the library
// splits it into its surrogate pair at the boundary; on a two byte wchar_t it is already the
// pair. Both produce the same bytes, which is the rule this entry exists to hold.
static void init_wide_strings( wchar_t strings[wstring_count][wstring_buffer_size] )
{
    memset( (void*) strings, 0, sizeof( wchar_t ) * wstring_count * wstring_buffer_size );

    // 0: empty
    // 1: cyrillic "мир", basic plane
    strings[1][0] = (wchar_t) 0x043C;
    strings[1][1] = (wchar_t) 0x0438;
    strings[1][2] = (wchar_t) 0x0440;
    // 2: the first code unit above the surrogate block
    strings[2][0] = (wchar_t) 0xE000;
    // 3: the largest code unit there is
    strings[3][0] = (wchar_t) 0xFFFF;
    // 4: an astral code point between two basic plane ones: four code units, one pair
    strings[4][0] = (wchar_t) 0x0041;
    strings[4][1] = (wchar_t) 0x1F600;
    strings[4][2] = (wchar_t) 0x0042;
    // 5: seven code units, the most buffer_size 8 carries
    for ( int i = 0; i < 7; i++ )
    {
        strings[5][i] = (wchar_t) ( 0x0061 + i );
    }
}

// ---------------------------------------------------------------------------------------
// the message

struct InteropData
{
    uint64_t bits_values[bits_count];
    bool bool_values[2];
    uint32_t uint8_values_data[uint8_count];
    uint32_t uint16_values_data[uint16_count];
    uint32_t uint32_values_data[uint32_count];
    uint64_t uint64_values_data[uint64_count];
    serialize::uint128_t uint128_values_data[uint128_count];
    int32_t int_values[int_count];
    int64_t int64_values[int64_count];
    serialize::int128_t int128_values[int128_count];
    int16_t fixed_q8_8_min;
    int16_t fixed_q8_8_max;
    int32_t fixed_q16_16_degenerate;
    int64_t fixed_q48_16_min;
    int64_t fixed_q48_16_max;
    serialize::int128_t fixed_q112_16_max;
    serialize::int128_t fixed_q64_64_degenerate;
    serialize::int128_t fixed_q64_64_max;
    int32_t relative_values[relative_count];
    float float_values[float_count];
    double double_values[double_count];
    float compressed_float_values[compressed_float_count];
    uint32_t filler;
    uint8_t bytes_values[bytes_count][bytes_max];
    char strings[string_count][string_buffer_size];
    wchar_t wide_strings[wstring_count][wstring_buffer_size];
};

static float float_from_bits( uint32_t bits )
{
    float value;
    memcpy( &value, &bits, sizeof( value ) );
    return value;
}

static uint32_t bits_from_float( float value )
{
    uint32_t bits;
    memcpy( &bits, &value, sizeof( bits ) );
    return bits;
}

static double double_from_bits( uint64_t bits )
{
    double value;
    memcpy( &value, &bits, sizeof( value ) );
    return value;
}

static uint64_t bits_from_double( double value )
{
    uint64_t bits;
    memcpy( &bits, &value, sizeof( bits ) );
    return bits;
}

static void InteropInit( InteropData & data )
{
    memset( (void*) &data, 0, sizeof( data ) );

    for ( int i = 0; i < bits_count; i++ )
    {
        data.bits_values[i] = bits_vectors[i].value;
    }

    data.bool_values[0] = true;
    data.bool_values[1] = false;

    for ( int i = 0; i < uint8_count;  i++ ) { data.uint8_values_data[i]  = uint8_values[i];  }
    for ( int i = 0; i < uint16_count; i++ ) { data.uint16_values_data[i] = uint16_values[i]; }
    for ( int i = 0; i < uint32_count; i++ ) { data.uint32_values_data[i] = uint32_values[i]; }
    for ( int i = 0; i < uint64_count; i++ ) { data.uint64_values_data[i] = uint64_values[i]; }

    data.uint128_values_data[0] = serialize::uint128_t( 0u );
    data.uint128_values_data[1] = ~serialize::uint128_t( 0u );
    data.uint128_values_data[2] = ( serialize::uint128_t( 0x0123456789ABCDEFULL ) << 64 )
                                | serialize::uint128_t( 0x0FEDCBA987654321ULL );

    for ( int i = 0; i < int_count;   i++ ) { data.int_values[i]   = int_vectors[i].value;   }
    for ( int i = 0; i < int64_count; i++ ) { data.int64_values[i] = int64_vectors[i].value; }

    data.int128_values[0] = int128_degenerate_value();
    data.int128_values[1] = serialize::int128_t( 5000000000LL );
    data.int128_values[2] = int128_min_value();
    data.int128_values[3] = int128_max_value();

    data.fixed_q8_8_min = (int16_t) ( -100 * 256 );                             // the bottom of the range
    data.fixed_q8_8_max = (int16_t) ( 100 * 256 );                              // the top
    data.fixed_q16_16_degenerate = (int32_t) ( 7 * 65536 );                     // min == max: zero bits
    data.fixed_q48_16_min = -( (int64_t) 100000 * 65536 );                      // 34 bits on the wire
    data.fixed_q48_16_max = (int64_t) 100000 * 65536;
    data.fixed_q112_16_max = serialize::int128_t( 144115188075855872LL ) << 16; // 75 bits, three groups
    data.fixed_q64_64_degenerate = serialize::int128_t( 5 ) << 64;              // zero bits at 128 bit storage
    data.fixed_q64_64_max = serialize::int128_t( INT64_MAX ) << 64;             // 128 bits, four groups

    for ( int i = 0; i < relative_count; i++ )
    {
        data.relative_values[i] = relative_vectors[i].current;
    }

    for ( int i = 0; i < float_count;  i++ ) { data.float_values[i]  = float_from_bits( float_bits[i] ); }
    for ( int i = 0; i < double_count; i++ ) { data.double_values[i] = double_from_bits( double_bits[i] ); }

    for ( int i = 0; i < compressed_float_count; i++ )
    {
        data.compressed_float_values[i] = compressed_float_vectors[i].value;
    }

    data.filler = 5;
    for ( int i = 0; i < bytes_count; i++ )
    {
        memset( data.bytes_values[i], bytes_vectors[i].fill, (size_t) bytes_vectors[i].length );
    }

    serialize_copy_string( data.strings[0], "", string_buffer_size );
    serialize_copy_string( data.strings[1], "0123456789abcde", string_buffer_size );    // fifteen bytes: full
    serialize_copy_string( data.strings[2], "\xD0\xBC\xD0\xB8\xD1\x80", string_buffer_size );  // "мир", six UTF-8 bytes

    init_wide_strings( data.wide_strings );
}

template <typename Stream> bool InteropSerialize( Stream & stream, InteropData & data )
{
    // ----- raw bit groups
    for ( int i = 0; i < bits_count; i++ )
    {
        serialize_bits( stream, data.bits_values[i], bits_vectors[i].bits );
    }

    // ----- bool, both codes
    for ( int i = 0; i < 2; i++ )
    {
        serialize_bool( stream, data.bool_values[i] );
    }

    // both sides of the alignment rule: the stream is unaligned here, so the first align
    // pads, and the second must write nothing at all
    serialize_align( stream );
    serialize_align( stream );

    // ----- the fixed width unsigned helpers
    for ( int i = 0; i < uint8_count;  i++ ) { serialize_uint8( stream, data.uint8_values_data[i] );   }
    for ( int i = 0; i < uint16_count; i++ ) { serialize_uint16( stream, data.uint16_values_data[i] ); }
    for ( int i = 0; i < uint32_count; i++ ) { serialize_uint32( stream, data.uint32_values_data[i] ); }
    for ( int i = 0; i < uint64_count; i++ ) { serialize_uint64( stream, data.uint64_values_data[i] ); }
    for ( int i = 0; i < uint128_count; i++ ) { serialize_uint128( stream, data.uint128_values_data[i] ); }

    // ----- ranged integers
    for ( int i = 0; i < int_count; i++ )
    {
        serialize_int( stream, data.int_values[i], int_vectors[i].min, int_vectors[i].max );
    }
    for ( int i = 0; i < int64_count; i++ )
    {
        serialize_int64( stream, data.int64_values[i], int64_vectors[i].min, int64_vectors[i].max );
    }
    {
        const serialize::int128_t degenerate = int128_degenerate_value();
        const serialize::int128_t minimum = int128_min_value();
        const serialize::int128_t maximum = int128_max_value();
        serialize_int128( stream, data.int128_values[0], degenerate, degenerate );
        // bounds inside the 64 bit domain: the bytes are identical to serialize_int64 here
        serialize_int128( stream, data.int128_values[1], serialize::int128_t( -5000000000LL ), serialize::int128_t( 5000000000LL ) );
        serialize_int128( stream, data.int128_values[2], minimum, maximum );
        serialize_int128( stream, data.int128_values[3], minimum, maximum );
    }

    // ----- fixed point, at the ends of its ranges and degenerate on two storage widths
    serialize_align( stream );
    serialize_fixed( stream, data.fixed_q8_8_min, 8, 8, -100, +100 );
    serialize_fixed( stream, data.fixed_q8_8_max, 8, 8, -100, +100 );
    serialize_fixed( stream, data.fixed_q16_16_degenerate, 16, 16, 7, 7 );
    serialize_fixed( stream, data.fixed_q48_16_min, 48, 16, -100000, +100000 );
    serialize_fixed( stream, data.fixed_q48_16_max, 48, 16, -100000, +100000 );
    serialize_fixed( stream, data.fixed_q112_16_max, 112, 16, -144115188075855872LL, +144115188075855872LL );
    serialize_fixed( stream, data.fixed_q64_64_degenerate, 64, 64, 5, 5 );
    serialize_fixed( stream, data.fixed_q64_64_max, 64, 64, INT64_MIN, INT64_MAX );

    // ----- int_relative
    for ( int i = 0; i < relative_count; i++ )
    {
        serialize_int_relative( stream, relative_vectors[i].previous, data.relative_values[i] );
    }

    // ----- float and double
    for ( int i = 0; i < float_count;  i++ ) { serialize_float( stream, data.float_values[i] );   }
    for ( int i = 0; i < double_count; i++ ) { serialize_double( stream, data.double_values[i] ); }

    // ----- compressed_float
    for ( int i = 0; i < compressed_float_count; i++ )
    {
        serialize_compressed_float( stream, data.compressed_float_values[i],
                                    compressed_float_vectors[i].min,
                                    compressed_float_vectors[i].max,
                                    compressed_float_vectors[i].res );
    }

    // ----- bytes. The three bit filler leaves the stream unaligned, so the align that
    // begins the first block -- a ZERO LENGTH one -- is load bearing.
    serialize_bits( stream, data.filler, 3 );
    for ( int i = 0; i < bytes_count; i++ )
    {
        serialize_bytes( stream, data.bytes_values[i], bytes_vectors[i].length );
    }

    // ----- string
    for ( int i = 0; i < string_count; i++ )
    {
        serialize_string( stream, data.strings[i], string_buffer_size );
    }

    // ----- wstring
    for ( int i = 0; i < wstring_count; i++ )
    {
        serialize_wstring( stream, data.wide_strings[i], wstring_buffer_size );
    }

    return true;
}

// What a conforming reader recovers. Everything is exact except the compressed floats, which
// are lossy by construction: the reader returns the nearest quantum, so they are compared
// within one resolution step. Floats compare by BIT PATTERN -- a value comparison cannot see
// -0.0, which is the whole point of half of this section.
static bool InteropCheck( const InteropData & data )
{
    InteropData expected;
    InteropInit( expected );

    for ( int i = 0; i < bits_count; i++ )
    {
        if ( data.bits_values[i] != expected.bits_values[i] ) { printf( "mismatch: bits[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < 2; i++ )
    {
        if ( data.bool_values[i] != expected.bool_values[i] ) { printf( "mismatch: bool[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < uint8_count; i++ )
    {
        if ( data.uint8_values_data[i] != expected.uint8_values_data[i] ) { printf( "mismatch: uint8[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < uint16_count; i++ )
    {
        if ( data.uint16_values_data[i] != expected.uint16_values_data[i] ) { printf( "mismatch: uint16[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < uint32_count; i++ )
    {
        if ( data.uint32_values_data[i] != expected.uint32_values_data[i] ) { printf( "mismatch: uint32[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < uint64_count; i++ )
    {
        if ( data.uint64_values_data[i] != expected.uint64_values_data[i] ) { printf( "mismatch: uint64[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < uint128_count; i++ )
    {
        if ( !( data.uint128_values_data[i] == expected.uint128_values_data[i] ) ) { printf( "mismatch: uint128[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < int_count; i++ )
    {
        if ( data.int_values[i] != expected.int_values[i] ) { printf( "mismatch: int[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < int64_count; i++ )
    {
        if ( data.int64_values[i] != expected.int64_values[i] ) { printf( "mismatch: int64[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < int128_count; i++ )
    {
        if ( !( data.int128_values[i] == expected.int128_values[i] ) ) { printf( "mismatch: int128[%d]\n", i ); return false; }
    }
    if ( data.fixed_q8_8_min != expected.fixed_q8_8_min ) { printf( "mismatch: fixed q8.8 min\n" ); return false; }
    if ( data.fixed_q8_8_max != expected.fixed_q8_8_max ) { printf( "mismatch: fixed q8.8 max\n" ); return false; }
    if ( data.fixed_q16_16_degenerate != expected.fixed_q16_16_degenerate ) { printf( "mismatch: fixed q16.16 degenerate\n" ); return false; }
    if ( data.fixed_q48_16_min != expected.fixed_q48_16_min ) { printf( "mismatch: fixed q48.16 min\n" ); return false; }
    if ( data.fixed_q48_16_max != expected.fixed_q48_16_max ) { printf( "mismatch: fixed q48.16 max\n" ); return false; }
    if ( !( data.fixed_q112_16_max == expected.fixed_q112_16_max ) ) { printf( "mismatch: fixed q112.16 max\n" ); return false; }
    if ( !( data.fixed_q64_64_degenerate == expected.fixed_q64_64_degenerate ) ) { printf( "mismatch: fixed q64.64 degenerate\n" ); return false; }
    if ( !( data.fixed_q64_64_max == expected.fixed_q64_64_max ) ) { printf( "mismatch: fixed q64.64 max\n" ); return false; }
    for ( int i = 0; i < relative_count; i++ )
    {
        if ( data.relative_values[i] != expected.relative_values[i] ) { printf( "mismatch: int_relative[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < float_count; i++ )
    {
        if ( bits_from_float( data.float_values[i] ) != float_bits[i] ) { printf( "mismatch: float[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < double_count; i++ )
    {
        if ( bits_from_double( data.double_values[i] ) != double_bits[i] ) { printf( "mismatch: double[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < compressed_float_count; i++ )
    {
        const float difference = data.compressed_float_values[i] - compressed_float_vectors[i].value;
        const float magnitude = difference < 0.0f ? -difference : difference;
        if ( magnitude > compressed_float_vectors[i].res ) { printf( "mismatch: compressed_float[%d]\n", i ); return false; }
    }
    if ( data.filler != expected.filler ) { printf( "mismatch: filler\n" ); return false; }
    for ( int i = 0; i < bytes_count; i++ )
    {
        if ( memcmp( data.bytes_values[i], expected.bytes_values[i], (size_t) bytes_vectors[i].length ) != 0 ) { printf( "mismatch: bytes[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < string_count; i++ )
    {
        if ( strcmp( data.strings[i], expected.strings[i] ) != 0 ) { printf( "mismatch: string[%d]\n", i ); return false; }
    }
    for ( int i = 0; i < wstring_count; i++ )
    {
        if ( wcscmp( data.wide_strings[i], expected.wide_strings[i] ) != 0 ) { printf( "mismatch: wstring[%d]\n", i ); return false; }
    }
    return true;
}

// ---------------------------------------------------------------------------------------

static const int buffer_size = 1024;

// + 8: read buffer allocations extend eight bytes past the data, per the read allocation
// contract, and the writer shares the array so the two halves cannot disagree about size
static uint8_t write_buffer[buffer_size + 8];
static uint8_t read_buffer[buffer_size + 8];
static uint8_t reencode_buffer[buffer_size + 8];

static bool encode( uint8_t * buffer, InteropData & data, int64_t & bytes )
{
    memset( buffer, 0, (size_t) buffer_size + 8 );
    serialize::WriteStream stream( buffer, buffer_size );
    if ( !InteropSerialize( stream, data ) )
    {
        return false;
    }
    stream.Flush();
    bytes = stream.GetBytesProcessed();
    return true;
}

static int Write( const char * path )
{
    InteropData data;
    InteropInit( data );

    int64_t bytes = 0;
    if ( !encode( write_buffer, data, bytes ) )
    {
        fprintf( stderr, "interop cpp write: serialize failed\n" );
        return 1;
    }

    FILE * file = fopen( path, "wb" );
    if ( !file )
    {
        fprintf( stderr, "interop cpp write: could not open %s\n", path );
        return 1;
    }
    if ( fwrite( write_buffer, 1, (size_t) bytes, file ) != (size_t) bytes )
    {
        fprintf( stderr, "interop cpp write: short write to %s\n", path );
        fclose( file );
        return 1;
    }
    fclose( file );

    printf( "interop cpp: wrote %d bytes to %s\n", (int) bytes, path );
    return 0;
}

static int64_t load( const char * path, uint8_t * buffer )
{
    FILE * file = fopen( path, "rb" );
    if ( !file )
    {
        fprintf( stderr, "interop cpp: could not open %s\n", path );
        return -1;
    }
    memset( buffer, 0, (size_t) buffer_size + 8 );
    const size_t bytes = fread( buffer, 1, (size_t) buffer_size, file );
    fclose( file );
    if ( bytes == 0 || bytes >= (size_t) buffer_size )
    {
        fprintf( stderr, "interop cpp: unexpected size %d for %s\n", (int) bytes, path );
        return -1;
    }
    return (int64_t) bytes;
}

static bool decode( uint8_t * buffer, int64_t bytes, InteropData & data )
{
    memset( (void*) &data, 0, sizeof( data ) );
    serialize::ReadStream stream( buffer, bytes );
    return InteropSerialize( stream, data );
}

static int Read( const char * path )
{
    const int64_t bytes = load( path, read_buffer );
    if ( bytes < 0 )
    {
        return 1;
    }

    InteropData data;
    if ( !decode( read_buffer, bytes, data ) )
    {
        fprintf( stderr, "interop cpp read: could not decode %s\n", path );
        return 1;
    }
    if ( !InteropCheck( data ) )
    {
        fprintf( stderr, "interop cpp read: %s decoded to unexpected values\n", path );
        return 1;
    }

    // re-encode what was decoded: the bytes must be identical to the input
    int64_t reencoded = 0;
    if ( !encode( reencode_buffer, data, reencoded ) )
    {
        fprintf( stderr, "interop cpp read: re-encode failed\n" );
        return 1;
    }
    if ( reencoded != bytes || memcmp( reencode_buffer, read_buffer, (size_t) bytes ) != 0 )
    {
        fprintf( stderr, "interop cpp read: re-encoded bytes differ from %s\n", path );
        return 1;
    }

    printf( "interop cpp: decoded and re-encoded %d bytes from %s, byte identical\n", (int) bytes, path );
    return 0;
}

// The hostile half: every proper prefix of a valid stream is a truncated stream, and a
// conforming reader refuses every one of them. Nothing here may crash, hang or accept.
static int Refuse( const char * path )
{
    const int64_t bytes = load( path, read_buffer );
    if ( bytes < 0 )
    {
        return 1;
    }

    for ( int64_t length = 0; length < bytes; length++ )
    {
        memset( reencode_buffer, 0, (size_t) buffer_size + 8 );
        memcpy( reencode_buffer, read_buffer, (size_t) length );
        InteropData data;
        if ( decode( reencode_buffer, length, data ) )
        {
            fprintf( stderr, "interop cpp refuse: the %d byte prefix of %s was ACCEPTED\n", (int) length, path );
            return 1;
        }
    }

    printf( "interop cpp: refused all %d truncated prefixes of %s\n", (int) bytes, path );
    return 0;
}

int main( int argc, char ** argv )
{
    if ( argc != 3 )
    {
        fprintf( stderr, "usage: interop write|read|refuse <file>\n" );
        return 2;
    }
    if ( strcmp( argv[1], "write" ) == 0 )
    {
        return Write( argv[2] );
    }
    if ( strcmp( argv[1], "read" ) == 0 )
    {
        return Read( argv[2] );
    }
    if ( strcmp( argv[1], "refuse" ) == 0 )
    {
        return Refuse( argv[2] );
    }
    fprintf( stderr, "usage: interop write|read|refuse <file>\n" );
    return 2;
}
