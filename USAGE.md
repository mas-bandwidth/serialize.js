# Using serialize.js

Everything the library does, by example. The wire format itself is defined
by [STANDARD.md](STANDARD.md); this document teaches the JavaScript surface
that speaks it.

```js
import {
  WriteStream, ReadStream, MeasureStream, SerializeError,
  refusalName, compressedFloatParams,
  BitWriter, BitReader,
  bitsRequired, bitsRequired64, bitsRequired128,
} from './serialize.js/src/index.js';
```

The library is vendored as source and imported by path — see
[README.md](README.md#getting-it). The specifier becomes a package name once
the npm package is published; the surface below does not change.

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

// the packet: its top-level object, then its end
function serializePacket(stream, player) {
  return serializePlayer(stream, player) && stream.serializeEnd();
}

// write
const player = {
  health: { value: 87 },
  alive: { value: true },
  heading: { value: Math.fround(1.25) },
};
const writer = new WriteStream(new Uint8Array(64)); // length a multiple of 8
serializePacket(writer, player); // -> true
writer.flush(); // ALWAYS flush before touching the bytes
const wire = writer.data(); // a 5-byte Uint8Array: 7 + 1 + 32 bits

// read
const reader = new ReadStream(wire); // exactly the packet: no slack required
const decoded = { health: {}, alive: {}, heading: {} };
serializePacket(reader, decoded); // -> true
decoded.health.value; // 87

// measure
const measure = new MeasureStream();
serializePacket(measure, player); // -> true
measure.bitsProcessed(); // 40
```

**A packet reader reads the end.** `serializeEnd()` goes after the last
field of the packet's top-level object (STANDARD.md, "end"). On read it
refuses a whole byte or more left over as `TrailingData` and a set bit in
the final byte's unused bits as `NonzeroPadding`, so the buffer you hand
`ReadStream` must be exactly the bytes the writer reported, and one value
is always one byte sequence. On write and measure it emits nothing. A
nested object never calls it: only the packet ends.

**A nested object goes through `serializeObject`.**
`stream.serializeObject((s) => serializePlayer(s, player))` calls the
function inline and adds no bits of its own (STANDARD.md, "object"). A
stream that has already failed refuses before the function runs, so even
an object that reads nothing refuses after a refusal, and a function that
returns `false`, or returns `true` over a refusal it ignored, refuses the
whole. A function that returns `false` with nothing refused inside it is
your own refusal, and latches `rejected`; a refusal inside it keeps its own
reason.

**Your own refusal goes through `stream.reject()`.** When the bytes are well
formed but the value they carry is one you refuse, `return stream.reject()`
from the serialize function: it latches `rejected` (STANDARD.md, "Refusal
reasons") through the same latch as every wire refusal, so it is terminal
and a stream that already failed keeps its first reason. It is read only:
on a `WriteStream` or `MeasureStream` the checked runtime throws, and the
production variant returns `false`.

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
r.error; // SerializeError.PastEnd
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

The errors are the standard's closed list of refusal reasons, and
`SerializeError`'s values are spelled exactly as the standard spells them:

| `SerializeError.` | value | the rule |
|---|---|---|
| `PastEnd` | `'past_end'` | a read past the end of the data (or a write past the end of the buffer) |
| `ValueOutOfRange` | `'value_out_of_range'` | a value outside its declared range or domain, on either side of the wire |
| `NonzeroPadding` | `'nonzero_padding'` | a set bit in an align's padding, or in the final byte's padding at the end |
| `TrailingData` | `'trailing_data'` | a whole byte or more after the end of the object |
| `NonFiniteFloat` | `'non_finite_float'` | a NaN or an infinity, or a compressed float decode that is not finite |
| `InvalidUtf8` | `'invalid_utf8'` | a string payload that is not well-formed UTF-8 (or a lone surrogate handed to the checked writer) |
| `EmbeddedNul` | `'embedded_nul'` | a zero byte among a string's bytes (or a U+0000 handed to the checked writer) |
| `NonCanonical` | `'non_canonical'` | the int_relative absolute tier carrying a difference a bounded tier carries |
| `Rejected` | `'rejected'` | the bytes were well formed, and the caller refused the value they carry |

The reason that stands is the **first** refusal's: later refusals on a
failed stream are echoes. A healthy stream's `error` is
`SerializeError.None`, which is `null`, so `if (stream.error)` reads
naturally.

Broken *code* is different from hostile *data*. On a `WriteStream` or
`MeasureStream`, misusing the API is write misuse, and it throws
`TypeError`/`RangeError` in every state, one mechanism on every operation
(IMPLEMENTING.md U9): a bad declaration (bits out of `[1,32]`, bounds outside
int32, an invalid Q format or compressed float declaration), a value of the
wrong type, and a value the declaration cannot carry (outside its range,
wider than its bits, NaN or an infinity, a string holding U+0000 or a lone
surrogate, or too long for its `bufferSize`). Nothing is written. That is
the **checked** mode, the default; whether those caller checks exist at all
is the mode's choice — see the next section.

A `ReadStream` never throws, misuse included (U7): the same bad declaration,
a byte span outside its array, a destination that is not a `Uint8Array`, or
data that is not a `Uint8Array` refuses as `ValueOutOfRange` before any bits
move, and a stream that already failed keeps its first reason.

`stream.fail(reason)` refuses a read with a reason of your choosing,
through the same latch; a reason off the closed list (or none) latches
`rejected`, so a refused stream never reports none. On a write or a measure
`fail` records nothing and returns `false` (U6, U14). `refusalName(error)`
gives the family spelling of any stream's error, `'none'` for no refusal.
`serializeEnd()` on a write or a measure is a no-op that returns `true`
(U12): check `stream.ok` for a write's outcome.

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

**Checked** is everything described above: write misuse throws — the
always-on form of the family's checked-build assertions. Develop and test
here.

**Production** removes the per-operation caller validation from
`WriteStream`, `MeasureStream` and `BitWriter`, exactly as a C/C++ release
build compiles its asserts to nothing. What every write keeps, in both
modes identically: the sticky-error gate and the buffer-end check —

```js
// production mode: a message that does not fit is still a latched VALUE
const w = new WriteStream(new Uint8Array(8));
const big = { value: 1n };
w.serializeUint64(big); // -> true: 64 bits, the buffer is full
w.serializeUint64(big); // -> false: SerializeError.PastEnd, latched
w.ok; // false, and every later call keeps returning false
```

— because overflow is a runtime condition, not a caller bug. Everything
else on the write side is your contract in production: a value outside its
declared range goes out as deterministic garbage (which conforming readers
refuse), a NaN or a U+0000 reaches the wire (where conforming readers
refuse it), a lone surrogate becomes U+FFFD, and nothing is validated for
you. Misuse never
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

`serializeBits` moves a non-negative integer Number that fits `bits`, 1 to
32. `serializeBits64` is its BigInt twin, 1 to 64 bits. A value wider than
its bits, or negative, is write misuse and throws in the checked variant
(U8): the writer never masks a value into something you did not send. Values wider than 32
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
`NonzeroPadding` otherwise.

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

## Floats and doubles: finite values, bit exact

`serializeFloat` (32 bits) and `serializeDouble` (64 bits) carry **finite**
values. A reader refuses a pattern whose exponent is all ones — NaN with any
payload, either sign, signaling or quiet, and both infinities — as
`NonFiniteFloat`, testing the raw bits before any conversion and leaving the
destination untouched. The checked writer throws on a NaN or an infinity,
including a finite double above the float32 range, which narrows to an
infinity. Every finite pattern travels bit exact: negative zero
and the subnormals are never flushed or re-signed. A float is 32 bits on the
wire: write `Math.fround`ed values or you'll be surprised by the read-back.

```js
w4.serializeFloat({ value: Math.fround(3.1415926) });
w4.serializeDouble({ value: 1.0 / 3.0 });
w4.serializeFloat({ value: -0 }); // -0 round trips as -0
w4.serializeFloat({ value: NaN }); // checked: throws RangeError (write misuse)
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
throws in the checked writer; reads refuse integers smuggled above the
quantization ceiling as `ValueOutOfRange`, and a decode that is not finite
as `NonFiniteFloat`. A declaration whose top, `min + delta` in float32,
rounds to an infinity is non-conforming: the checked writer and measure
throw on it, and a reader refuses its non-finite decodes.

`compressedFloatParams(min, max, resolution)` derives the wire constants
once — `{ maxIntegerValue, bits, delta }`, exactly what every
`serializeCompressedFloat` call derives — and
`serializeCompressedFloatPrecomputed(ref, maxIntegerValue, bits, delta, min)`
takes them, skipping the per-call divide, clamp and ceil. The two entry
points share one body, so the wire is identical. Constants that cannot have
come from `compressedFloatParams` (a `bits` that is not
`bitsRequired(0, maxIntegerValue)`, a `maxIntegerValue` outside
`[1, 4294967040]`, a `delta` that is not positive and finite) throw on write
and measure and refuse as `ValueOutOfRange` on read (U16).

```js
const heading = compressedFloatParams(0, 10, 0.01); // once
w5.serializeCompressedFloatPrecomputed(
  { value: 5.0 }, heading.maxIntegerValue, heading.bits, heading.delta, 0,
);
```

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

`serializeBytes(data, offset, length)` takes a span of the array instead
of all of it, with no subarray view allocated per call: the span's length
is the count, and a read fills only the span. `offset` defaults to 0 and
`length` to `data.length - offset`; a span outside the array is caller
misuse: it throws on the write and measure streams in the checked variant,
and a read refuses it as `ValueOutOfRange` (U7). The source and the
destination may share memory, the writer's own buffer or the reader's own
data included: the copy is exact either way. A fixed-capacity array carrying a used length is the
common case:

```js
w6.serializeBytes(text, 0, textLength); // the used prefix, no view
// ...
r6.serializeBytes(text, 0, textLength); // fills text[0, textLength)
```

`BitWriter.writeBytes` and `BitReader.readBytesInto` take the same
`offset, length` span.

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

Reads validate the payload in every build. A zero byte anywhere in the
payload latches `EmbeddedNul`, checked over the whole payload first; then
malformed UTF-8 (overlongs, encoded surrogates, values above U+10FFFF,
truncated sequences, stray continuations) latches `InvalidUtf8`, through a
fatal decoder that never substitutes U+FFFD. Every well-formed payload comes
back exactly: no normalization (`'e\u0301'` stays three bytes), no stripped
byte order mark, every plane.

The checked writer refuses what a reader would (U3, U4): a U+0000, and a
lone surrogate — ill-formed UTF-16, which `TextEncoder` would silently
turn into U+FFFD — are write misuse and throw, before anything is written.
A string that does not fit the buffer writes nothing at all: the room for
the length, the align and the payload is checked first (U10).
Text is UTF-8 on the wire; there is no wide-string operation.

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
is write misuse and throws. On read, a `previous` outside the domain
refuses as `ValueOutOfRange`.

On read, **every tier's reconstruction is checked**: the reader rebuilds
`current` in a width that cannot wrap and refuses the read as
`ValueOutOfRange` unless the result is inside the domain and above
`previous`. The absolute tier's 32 raw bits are read unsigned, so a group
with the top bit set is refused rather than arriving as a negative sequence
number. And the absolute tier is canonical: a `current` no more than 69914
above `previous` has a bounded encoding, so its absolute encoding is refused
as `NonCanonical`. A refused read leaves `ref.value` untouched and is
terminal for the stream.

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
misuse on write and measure, and refuses as `ValueOutOfRange` on read.

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
supported and no slack past the data is required. This is the zero-slack
contract, which the family's IMPLEMENTING.md calls the slower correct
option (a copy or window assembly at reset, a compare per window load);
the 8-byte slack alternative has not been measured against it yet.

## Wire compatibility

The same values produce the same bytes across the family, which implements
**format version 2.0** of the standard: the wire carries only integers and
bytes, and every value has exactly one encoding. This is not aspiration but
pinned fact: the suite runs the family's shared conformance corpus
(`conformance/`, vendored from mas-bandwidth/serialize), requiring every
refusal's stated reason, and carries the golden vectors — including the
106-byte golden message STANDARD.md prints, covering every operation class,
byte for byte — plus the discriminating float vectors, the string pins,
every relative-integer tier, and the fixed point shapes at every group
count. If your message serializes with the same declarations on both ends, a
stream written by any family implementation reads in any other.

Two doctrines worth knowing at the edges:

- **Trailing bits**: writers zero the unused bits of the final byte; a field
  read never looks at them, and the packet's `serializeEnd` refuses a set
  one.
- **Past-end data**: bytes past the end of the data you hand `ReadStream`
  are never read, let alone interpreted.
