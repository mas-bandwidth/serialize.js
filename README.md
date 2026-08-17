# serialize.js

[![CI](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml/badge.svg)](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

A bitpacking serialization library for **JavaScript**. The sixth
implementation of the serialize family, wire compatible with the
[C++](https://github.com/mas-bandwidth/serialize),
[C](https://github.com/mas-bandwidth/serialize.c),
[Go](https://github.com/mas-bandwidth/serialize.go),
[C#](https://github.com/mas-bandwidth/serialize.cs) and
[Rust](https://github.com/mas-bandwidth/serialize.rs) libraries — the same
values produce the same bytes in all six, so a stream written by one reads in
any other.

## Status

**Under construction**, being built chunk by chunk. What exists right now:

- [STANDARD.md](STANDARD.md) — the wire format specification, vendored
  verbatim from [mas-bandwidth/serialize](https://github.com/mas-bandwidth/serialize).
  CI diffs it against upstream on every push.
- The package scaffold: ESM, zero dependencies, no build step, Node 20+,
  tested with node's built-in `node:test` runner on Linux, macOS and Windows.
- The bitpacker: `BitWriter` and `BitReader`, the family wire in two-lane
  32-bit arithmetic. The reader prices its windows **inside** the buffer —
  any data length is supported and no slack past the data is required.
- The streams: `WriteStream`, `ReadStream` and `MeasureStream` share one
  bool-returning serialize surface, so a single serialize function writes,
  reads and measures. Refs are `{ value }` holders — the JavaScript
  translation of the family's ref parameters. The first failure latches on
  `stream.error` and sticks; `measure` is a conservative bound, charging
  7 bits per alignment-performing operation, never exact.
- The integer primitives up to 32 bits: `serializeBits`, `serializeAlign`,
  `serializeInt` (the format's defining ranged operation — offset from min
  in exactly `bitsRequired(min, max)` bits, zero bits for a degenerate
  `min === max` range), the fixed-width helpers `serializeUint8`,
  `serializeUint16`, `serializeUint32`, and `serializeBool`. Reads refuse
  values smuggled into the bit headroom of a range; writes and measures
  refuse out-of-range values as latched errors, never throws.
- The wide integers, in the BigInt value domain (the bitpacker underneath
  stays in 32-bit arithmetic): `serializeBits64` and its alias
  `serializeUint64` (low 32-bit dword first, then the high remainder),
  `serializeInt64` and `serializeInt128` (the ranged operations at 64 and
  128 bits — offsets computed in the unsigned domain, so ranges wider than
  2^63 and 2^127 are exact; up to four 32-bit groups, least significant
  first; wire identical to each other wherever the range fits 64 bits), and
  `serializeUint128` (not ranged — always 128 bits, the low 64-bit half
  first). Wide refusals are checked against the total width up front, so a
  refused operation consumes and writes nothing.
- The floating point operations: `serializeFloat` and `serializeDouble` are
  **bit transparent both ways** — every pattern is legal on the wire (NaNs
  with any payload, signaling NaNs, infinities, negative zero, denormals)
  and the transmitted pattern is reproduced exactly, with NaN payloads
  riding a software narrowing/widening that never sets the quiet bit.
  `serializeCompressedFloat` quantizes to a declared `[min, max]` at a
  resolution in float32 with the standard's **two roundings on each side**
  (`Math.fround` at every step — the roundings are part of the format, and
  the family's discriminating vectors are pinned bit-exactly). Finite
  values outside the declaration clamp; writing a non-finite value latches
  `ValueOutOfRange`; reads refuse integers smuggled above
  `max_integer_value`.
- `serializeBytes` — an align to the byte boundary (part of the format,
  verified on read) then a raw bulk byte copy whose count is never
  transmitted: both sides agree on it by passing arrays of the same length.
  A zero-length array still aligns. The family's conformance pins for the
  zero-count and unaligned paths hold byte-for-byte.
- `serializeString` — **UTF-8 on the wire**: the byte length as
  `serializeInt(length, 0, bufferSize - 1)`, then the payload as
  `serializeBytes`, which aligns. `bufferSize` is part of the message
  format — the same string against different buffer sizes produces
  different bytes. Writes refuse strings of `bufferSize` or more UTF-8
  bytes; reads validate the payload in every build and latch
  `InvalidString` on malformed UTF-8 (the fatal `TextDecoder` refuses
  overlongs, surrogates, values above U+10FFFF, truncated sequences, stray
  continuations) or on an **interior NUL** — valid UTF-8, refused by an
  explicit scan as the two-lengths smuggling primitive. A leading U+FEFF is
  a code point, not a BOM: it survives the round trip. A lone surrogate in
  a written string — ill-formed UTF-16, the writer's contract violated —
  encodes as U+FFFD, the contract surfacing JavaScript's way.
- `serializeWideString` — each 32-bit group is **one UTF-16 code unit**,
  never a code point: the unit count as
  `serializeInt(length, 0, bufferSize - 1)` (`bufferSize` counts wide
  characters), then the groups with **no alignment anywhere** — the one
  place the wide path deliberately differs from its narrow counterpart. A
  JavaScript string *is* a sequence of UTF-16 code units, so `charCodeAt`
  units transmit as they are and well-formed surrogate pairs pass through
  natively — an astral character is two groups on the wire. Writes refuse
  strings of `bufferSize` or more units (`ValueOutOfRange`) and lone
  surrogates (`InvalidString` — the wide wire cannot launder ill-formed
  UTF-16 the way the narrow encoder's U+FFFD replacement does); reads
  refuse groups above 0xFFFF (`ValueOutOfRange`: not a code unit — fail
  rather than truncate), interior NUL groups, and unpaired, misordered or
  dangling surrogates (`InvalidString`). The family's conformance pin —
  U+1F600 then U+0041 at `bufferSize` 8 is exactly 13 bytes, 99 bits — and
  the STANDARD.md worked example both hold byte-for-byte.
- `serializeIntRelative(previous, ref)` — the flag-ladder relative integer
  for **strictly increasing sequences** in the unsigned 32-bit domain
  (`current > previous`, **no wrapping** — the pinned semantics). A
  difference of 1 — the common case for sequence numbers — costs a single
  bit; small differences cost 5/8/13/18/23 bits across the payload tiers;
  past the ladder, six zero flags carry `current` itself as 32 raw bits —
  the absolute form, which the reader checks for ordering and refuses
  otherwise. Payload tiers reconstruct `previous + difference` in uint32
  arithmetic, exactly as the reference does, and every tier's bytes are
  pinned from the canonical serialize.h's own output.
- `serializeFixed(ref, integerBits, fractionBits, min, max)` — Q-format
  fixed point: `ref.value` is the **raw scaled integer** (the real value
  times `2^fractionBits`) in storage of exactly
  `integerBits + fractionBits` bits (8, 16, 32, 64 or 128, the sign bit
  counting toward `integerBits`), with `min` and `max` in **whole units**
  as part of the message format — Numbers for storage of 32 bits or fewer,
  int64 BigInts for 64 and 128. The wire is the offset from
  `min << fractionBits` in exactly the bit length of the raw range, in
  32-bit groups least significant first — **byte identical to
  `serializeInt64` of the raw value** wherever storage fits 64 bits, and
  the round trip is **exact**: no quantization, unlike the compressed
  float. A degenerate `min === max` range costs **zero bits on every
  storage width**. Reads refuse raw values smuggled into the bit headroom
  (reject, never clamp); an invalid declaration throws as caller misuse on
  every stream.
- `bitsRequired(min, max)`, `bitsRequired64` and `bitsRequired128` — the
  serialize.h range-costing arithmetic, for pricing fields when designing a
  message format.

## Design

This is a **hand-port to native JavaScript** — no wasm. It takes the family's
checked-runtime shape: checks run in every build, reads validate everything
(the wire is a trust boundary), and errors are values — bool-returning
serialize methods plus a sticky latched stream error. Hostile input never
throws.

## Testing

```
npm test
```

which is nothing more than `node --test` — the runner's default matcher picks
up every `*.test.js` under `test/`. (A bare directory argument stopped being
accepted by Node 22's runner, so the invocation stays argument-free.)

## License

[BSD 3-Clause](LICENSE), © Más Bandwidth LLC.
