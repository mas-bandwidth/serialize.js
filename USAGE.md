# Using serialize.js

Everything the library does, by example. The wire format itself is defined
by [STANDARD.md](STANDARD.md); this document teaches the JavaScript surface
that speaks it.

```js
import {
  WriteStream, ReadStream, MeasureStream, SerializeError,
  BitWriter, BitReader,
  bitsRequired, bitsRequired64, bitsRequired128,
} from 'serialize';
```

## One serialize function, three streams

The family's defining pattern: write, read and measure share a single
serialize function. Every operation returns a bool, values travel in
`{ value }` holder objects (the JavaScript translation of the family's ref
parameters), and the stream direction decides whether the holder is
consumed or filled.

```js
function serializePlayer(stream, player) {
  return (
    stream.serializeInt(player.health, 0, 100) &&
    stream.serializeBool(player.alive) &&
    stream.serializeFloat(player.heading)
  );
}

// write
const player = {
  health: { value: 87 },
  alive: { value: true },
  heading: { value: Math.fround(1.25) },
};
const writer = new WriteStream(new Uint8Array(64)); // length a multiple of 8
serializePlayer(writer, player); // -> true
writer.flush(); // ALWAYS flush before touching the bytes
const wire = writer.data(); // a 5-byte Uint8Array: 7 + 1 + 32 bits

// read
const reader = new ReadStream(wire); // any length, no slack required
const decoded = { health: {}, alive: {}, heading: {} };
serializePlayer(reader, decoded); // -> true
decoded.health.value; // 87

// measure
const measure = new MeasureStream();
serializePlayer(measure, player); // -> true
measure.bitsProcessed(); // 40
```

`WriteStream` needs a buffer whose length is a multiple of 8 (the writer
works in 64-bit words). `ReadStream` accepts any data length and never
reads outside it. `MeasureStream` touches no memory at all — it prices a
message so you can size buffers; its bound is conservative (see
[Measuring](#measuring)).

All three streams expose `bitsProcessed()`, `bytesProcessed()`,
`isWriting` / `isReading`, and `reset(...)` for allocation-free reuse.

## Errors are values

The wire is a trust boundary: hostile bytes never throw. Every failure —
a truncated read, a value outside its range, a malformed string — returns
`false` and latches the first error on the stream, where it sticks; every
later call returns `false` without disturbing it.

```js
const r = new ReadStream(Uint8Array.of(0x00)); // 8 bits of data
r.serializeBits({}, 32); // -> false: past the end
r.error; // SerializeError.Overflow
r.ok; // false
r.serializeBits({}, 1); // -> false: the error is latched
r.reset(Uint8Array.of(0x00)); // clears state AND the latched error
```

A refused read leaves its destination **exactly as it was**: every scalar
read checks before it assigns, so a caller that reads `ref.value` after a
`false` sees what was there before the call, never a value the stream did
not carry. The exception is `serializeBytes`, which fills a caller-owned
buffer whose contents after a refusal are unspecified.

And the failure is **terminal**: nothing after a failing read has a defined
position, so the stream itself refuses everything that follows rather than
leaving that to your discipline. `reset()` — pointing the stream at a new
buffer — is what clears it.

The error codes: `Overflow` (past the end of data or buffer),
`ValueOutOfRange` (a value outside its declared range, on either side of
the wire), `Align` (nonzero alignment padding — the serialize functions
don't match), `InvalidString` (a malformed string payload). A healthy
stream's `error` is `SerializeError.None`, which is `null`, so
`if (stream.error)` reads naturally.

Broken *code* is different from hostile *data*: misusing the API — bits
out of `[1,32]`, a non-BigInt where the domain is BigInt, an invalid
declaration — throws `TypeError`/`RangeError` on every stream, in every
state, and writing a value outside its declared range latches
`ValueOutOfRange` and writes nothing. That is the **checked** mode, the
default; whether those caller checks exist at all is the mode's choice —
see the next section.

## The two modes: checked and production

The family standard makes the caller responsible for well-formed writes.
Writer contracts are assertions in a **checked build** — the standard's
term for a build with assertions enabled — and the languages that can
compile those out do. JavaScript can't strip code at compile time, so the
write path forks **once, at module load**, on `NODE_ENV`:

```sh
node app.js                       # checked: the development default
NODE_ENV=production node app.js   # production: the caller-trust release shape
```

**Checked** is everything described above: caller misuse throws, invalid
values latch — the always-on form of the family's checked-build
assertions. Develop and test here.

**Production** removes the per-operation caller validation from
`WriteStream`, `MeasureStream` and `BitWriter`, exactly as a C/C++ release
build compiles its asserts to nothing. What every write keeps, in both
modes identically: the sticky-error gate and the buffer-end check —

```js
// production mode: a message that does not fit is still a latched VALUE
const w = new WriteStream(new Uint8Array(8));
const big = { value: 1n };
w.serializeUint64(big); // -> true: 64 bits, the buffer is full
w.serializeUint64(big); // -> false: SerializeError.Overflow, latched
w.ok; // false, and every later call keeps returning false
```

— because overflow is a runtime condition, not a caller bug. Everything
else on the write side is your contract in production: a value outside its
declared range goes out as deterministic garbage (which conforming readers
refuse), a lone surrogate reaches the wide-string wire (where conforming
readers refuse it), and nothing is validated for you. Misuse never
corrupts memory — JavaScript's own bounds semantics are the backstop — it
corrupts your message. The wire for *conforming* writes is byte identical
in both modes: `npm run test:production` re-runs the golden pins and the
property sweep under the production variants to prove it.

Reads are untouched by the mode: the wire is a trust boundary, and every
read-side refusal — bounds, ranges, alignment padding, string content —
binds in every mode.

The selection is frozen: the environment is read once, and whole classes
are chosen at export time (`ReadStream` has no variants). Changing
`NODE_ENV` after load has no effect.

## Raw bits

`serializeBits` moves the low `bits` of a non-negative Number, 1 to 32.
`serializeBits64` is its BigInt twin, 1 to 64 bits. Values wider than 32
bits go low 32-bit dword first — the family's group rule.

```js
const w = new WriteStream(new Uint8Array(16));
w.serializeBits({ value: 5 }, 3); // 3 bits on the wire
w.serializeBits({ value: 0xdeadbeef }, 32); // full width
w.serializeBits64({ value: 0x123456789abcdef0n }, 64); // BigInt domain
w.serializeAlign(); // zero-pads to the next byte boundary
w.flush();
```

`serializeAlign` writes zero bits up to the next byte boundary (nothing if
already aligned); the reader verifies the padding is zero and latches
`Align` otherwise.

## Ranged integers

`serializeInt(ref, min, max)` is the format's defining operation: the
value rides as an offset from `min` in exactly `bitsRequired(min, max)`
bits. Both sides must state the same range — the range is part of the
message format, not the wire.

```js
w2.serializeInt({ value: -37 }, -100, 100); // 8 bits
w2.serializeInt({ value: 7 }, 7, 7); // degenerate range: ZERO bits
```

`min <= max` is the legal relation for every ranged operation —
`serializeInt`, `serializeInt64`, `serializeInt128` and `serializeFixed`,
on every storage width. The **degenerate** `min === max` range is a field
you may declare, not misuse: the writer emits nothing, the reader consumes
nothing and takes the value from `min`, and a measure adds zero bits.
(`serializeCompressedFloat` is not a ranged operation and is the one
exception: it quantizes across its bounds, so it requires `min < max`.)

Reads refuse values smuggled into the bit headroom of a range (an offset
above `max - min` latches `ValueOutOfRange` — reject, never clamp).

`serializeInt64` and `serializeInt128` are the same operation in the
BigInt domain, with offsets computed in unsigned arithmetic so ranges
wider than 2^63 and 2^127 are exact, in 32-bit groups least significant
first:

```js
w2.serializeInt64({ value: -5000000000n }, -5000000000n, 5000000000n); // 34 bits
w2.serializeInt128({ value: 0n }, -(2n ** 127n), 2n ** 127n - 1n); // 128 bits
```

`bitsRequired(min, max)`, `bitsRequired64` and `bitsRequired128` price a
range when designing a message format. They live in the **unsigned**
domain (the subtraction wraps, reproducing the C++ arithmetic exactly);
convert a signed bound with `>>> 0` / `BigInt.asUintN` first, just as the
serialize operations do internally:

```js
bitsRequired(0, 200); // 8: the cost of serializeInt over [-100, +100]
bitsRequired(-100 >>> 0, 100); // 8: same range, converted bounds
bitsRequired64(BigInt.asUintN(64, -5000000000n), 5000000000n); // 34
bitsRequired128(0n, 2n ** 100n); // 101
```

## The unsigned helpers and bool

Fixed-width conveniences. The 8/16/32-bit helpers live in the Number
domain; 64 and 128 are BigInt. `serializeUint128` is always 128 bits, low
64-bit half first. `serializeBool` is one bit, and the reader refuses a
latched stream just like every other operation.

```js
w3.serializeUint8({ value: 0x7f });
w3.serializeUint16({ value: 0x1234 });
w3.serializeUint32({ value: 0x12345678 });
w3.serializeUint64({ value: 0x123456789abcdef0n });
w3.serializeUint128({ value: (1n << 100n) + 1n });
w3.serializeBool({ value: true });
```

## Floats and doubles: bit transparent

`serializeFloat` (32 bits) and `serializeDouble` (64 bits) reproduce the
transmitted pattern exactly — every pattern is legal on the wire: NaNs
with any payload, signaling NaNs, infinities, negative zero, denormals.
Float32 values ride a software narrowing/widening that never sets the
quiet bit. Note that a float is 32 bits on the wire: write
`Math.fround`ed values or you'll be surprised by the read-back.

```js
w4.serializeFloat({ value: Math.fround(3.1415926) });
w4.serializeDouble({ value: 1.0 / 3.0 });
w4.serializeFloat({ value: -0 }); // -0 round trips as -0
```

## The compressed float

`serializeCompressedFloat(ref, min, max, resolution)` quantizes into a
declared range at a resolution — the one lossy operation. The declaration
is part of the message format. The arithmetic is float32 with the
standard's two roundings on each side (`Math.fround` at every step — the
roundings are part of the format, and the family's discriminating vectors
pin the decoded bit patterns exactly).

```js
w5.serializeCompressedFloat({ value: 5.0 }, 0.0, 10.0, 0.01); // 10 bits
// reading it back yields exactly 5.0: the value sits on a quantum.
// off-quantum values come back within the resolution; re-encoding a
// decoded value is byte-identical (the round trip is idempotent).
```

Finite values outside `[min, max]` clamp on write; a non-finite value
latches `ValueOutOfRange`; reads refuse integers smuggled above the
quantization ceiling.

## Raw bytes

`serializeBytes(data)` aligns to the byte boundary (the alignment is part
of the format, padding verified on read) and then bulk-copies. The count
is never transmitted: both sides agree by passing arrays of the same
length. On read, the array you pass is filled in place — and if the read
refuses, its contents are unspecified, so check the return before you use
it.

```js
w6.serializeBytes(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
// ...
const out = new Uint8Array(4);
r6.serializeBytes(out); // out now holds the bytes
```

A zero-length array still performs (and verifies) the align.

## Strings: UTF-8 on the wire

`serializeString(ref, bufferSize)` sends the UTF-8 byte length as
`serializeInt(length, 0, bufferSize - 1)`, then the payload as
`serializeBytes` (which aligns). `bufferSize` is part of the message
format — the same string against different buffer sizes produces
different bytes — and the payload must fit `bufferSize - 1` bytes.

```js
w7.serializeString({ value: 'golden' }, 16);
const s = {};
r7.serializeString(s, 16); // s.value === 'golden'
```

Reads validate the payload in every build: malformed UTF-8 (overlongs,
surrogate code points, values above U+10FFFF, truncated sequences, stray
continuations) and interior NULs latch `InvalidString`. A lone surrogate
in a *written* string — ill-formed UTF-16, the writer's contract
violated — encodes as U+FFFD, the contract surfacing JavaScript's way.

## Wide strings: UTF-16 code units

`serializeWideString(ref, bufferSize)` sends the unit count, then one
32-bit group per UTF-16 code unit — never a code point — with no
alignment anywhere: the one place the wide path deliberately differs from
its narrow counterpart. A JavaScript string *is* a sequence of UTF-16
code units, so astral characters are two groups on the wire, exactly as
the family's 2-byte-wchar_t ports split them. `bufferSize` counts wide
characters.

```js
w8.serializeWideString({ value: '\u{1f600}A' }, 8); // 3 units: 99 bits
```

Writes refuse over-long strings (`ValueOutOfRange`) and lone surrogates
(`InvalidString` — the wide wire cannot carry ill-formed UTF-16, because
conforming readers refuse it). Reads refuse groups above 0xFFFF, interior
NUL groups, and unpaired, misordered or dangling surrogates.

## The relative integer

`serializeIntRelative(previous, ref)` prices strictly increasing sequences
— sequence numbers, ack chains — over the operation's domain, the
non-negative int32 range **0 to 2^31 − 1 inclusive**. `current > previous`
always, no wrapping. A difference of 1 costs a single bit; small
differences ride payload tiers of 5/8/13/18/23 bits; past the ladder, six
zero flags carry `current` itself as 32 raw bits.

```js
w9.serializeIntRelative(100, { value: 101 }); // 1 bit
w9.serializeIntRelative(100, { value: 2100 }); // the mid-ladder tier
// read side: pass the same previous, get current back
r9.serializeIntRelative(100, seq); // seq.value === 101
```

`previous` is caller state, not wire: both sides already know it, and a
`previous` outside the domain throws as misuse — the domain belongs to the
operation, not to your storage type, so `2**31` is caller error exactly as
`-1` is. Writing a `current` at or below `previous`, or above the domain,
latches `ValueOutOfRange`.

On read, **every tier's reconstruction is checked**: the reader rebuilds
`current` in a width that cannot wrap and refuses the read unless the
result is inside the domain and above `previous`. The absolute tier's 32
raw bits are read unsigned, so a group with the top bit set is refused
rather than arriving as a negative sequence number. A refused read leaves
`ref.value` untouched and is terminal for the stream.

## Fixed point

`serializeFixed(ref, integerBits, fractionBits, min, max)` carries
Q-format fixed point. `ref.value` is the **raw scaled integer** — the
real value times `2^fractionBits` — in storage of exactly
`integerBits + fractionBits` bits (8, 16, 32, 64 or 128; the sign bit
counts toward `integerBits`). `min` and `max` are in **whole units**,
part of the message format: Numbers for storage of 32 bits or fewer,
int64 BigInts for 64 and 128 — the value domain follows the storage
width.

```js
// -3.25 in Q8.8 over [-100, +100] units: raw is -3.25 * 256 = -832
w10.serializeFixed({ value: -832 }, 8, 8, -100, 100); // 16 bits

// 1234.5 in Q16.16 over [-2000, +2000]
w10.serializeFixed({ value: 1234 * 65536 + 32768 }, 16, 16, -2000, 2000);

// 12345.5 in Q48.16 over [-100000, +100000]: 64-bit storage, BigInt lane
w10.serializeFixed({ value: 12345n * 65536n + 32768n }, 48, 16, -100000n, 100000n); // 34 bits

// Q64.64 over the full unit range: 128 bits, four groups
w10.serializeFixed({ value: 1n << 64n }, 64, 64, -(2n ** 63n), 2n ** 63n - 1n);
```

The wire is the offset from `min << fractionBits` in exactly the bit
length of the raw range — byte identical to `serializeInt64` of the raw
value wherever storage fits 64 bits — and the round trip is **exact**: no
quantization, unlike the compressed float. A degenerate `min === max`
range costs zero bits on every storage width. Reads refuse raw values
smuggled into the bit headroom; an invalid declaration throws as caller
misuse.

## Measuring

`MeasureStream` prices a message without a buffer. For everything except
alignment it is exact; any operation that aligns (`serializeAlign`,
`serializeBytes`, `serializeString`) charges the worst case — 7 bits of
padding — because the measure stream cannot know what alignment the field
will land on inside your message. The guarantee is a bound, never
equality:

```js
measure.bitsProcessed() >= writer.bitsProcessed(); // always true
```

Size buffers from the measured bound (rounded up to a multiple of 8 bytes
for `WriteStream`).

## The bitpacker underneath

`BitWriter` and `BitReader` are the streams' engine — the family wire in
two-lane 32-bit arithmetic — and are exported for code that wants raw
bitpacking without the serialize surface or its checks:

```js
const bw = new BitWriter(new Uint8Array(16));
bw.writeBits(5, 3);
bw.writeAlign();
bw.writeBytes(Uint8Array.of(1, 2, 3));
bw.flushBits();

const br = new BitReader(bw.data());
br.readBits(3); // 5
br.readAlign(); // true: padding was zero
br.readBytes(3); // Uint8Array [1, 2, 3]
```

The reader prices its windows **inside** the buffer: any data length is
supported and no slack past the data is required.

## Wire compatibility

The same values produce the same bytes across the family, which implements
**format version 1.1** of the standard. This is not aspiration but pinned
fact: the suite runs the family's shared conformance corpus
(`conformance/`, vendored from mas-bandwidth/serialize) and carries the
golden vectors — including serialize.h's 112-byte golden wire message
covering every operation class, byte for byte — plus the discriminating
float vectors, the string and wide-string pins, every relative-integer
tier, and the fixed point shapes at every group count, all minted from the
C++ implementation's own output. If your message serializes with the same
declarations on both ends, a stream written by any family implementation
reads in any other.

Two doctrines worth knowing at the edges:

- **Trailing bits**: writers zero the unused bits of the final byte;
  readers never reject a stream for their contents.
- **Past-end data**: bytes past the end of the data you hand `ReadStream`
  are never read, let alone interpreted.
