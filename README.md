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

## The surface

The complete family operation set, on three streams sharing one
bool-returning serialize surface — `WriteStream`, `ReadStream` and
`MeasureStream` — so a single serialize function writes, reads and
measures. [USAGE.md](USAGE.md) teaches every operation by example.

- **Raw bits**: `serializeBits` (1–32), `serializeBits64` (1–64, BigInt),
  `serializeAlign`.
- **Ranged integers**: `serializeInt`, `serializeInt64`,
  `serializeInt128` — offset from min in exactly the bit length of the
  range, unsigned-domain arithmetic so ranges wider than 2^63/2^127 are
  exact, zero bits for a degenerate range.
- **Unsigned helpers and bool**: `serializeUint8` / `16` / `32` (Number),
  `serializeUint64` / `serializeUint128` (BigInt), `serializeBool`.
- **Floats**: `serializeFloat` and `serializeDouble`, bit transparent both
  ways — every pattern legal, NaN payloads ride a software
  narrowing/widening that never sets the quiet bit;
  `serializeCompressedFloat`, quantizing in float32 with the standard's
  two roundings on each side.
- **Bytes and strings**: `serializeBytes` (aligned bulk copy, count
  agreed, not transmitted); `serializeString` (UTF-8 on the wire, payload
  validated in every build); `serializeWideString` (one 32-bit group per
  UTF-16 code unit, no alignment anywhere — the one place the wide path
  deliberately differs from its narrow counterpart).
- **The relative integer**: `serializeIntRelative` — the flag ladder for
  strictly increasing uint32 sequences, one bit for a difference of 1, no
  wrapping.
- **Fixed point**: `serializeFixed` — Q formats at 8/16/32/64/128-bit
  storage, the raw scaled integer as an exact ranged offset, byte
  identical to `serializeInt64` wherever storage fits 64 bits, zero bits
  for a degenerate range on every width.
- **Range pricing**: `bitsRequired`, `bitsRequired64`, `bitsRequired128`.
- **The bitpacker underneath**: `BitWriter` and `BitReader`, the family
  wire in two-lane 32-bit arithmetic. The reader prices its windows
  **inside** the buffer — any data length is supported, no slack past the
  data required.

ESM, zero dependencies, no build step, Node 20+.

## Conformance

[STANDARD.md](STANDARD.md) — vendored verbatim from
[mas-bandwidth/serialize](https://github.com/mas-bandwidth/serialize) and
diffed against upstream by CI on every push — is the law, and the C++
reference's serialize.h is canonical. The suite pins the family's golden
vectors byte for byte, all minted from the reference's own output: the
112-byte golden wire message covering every operation class in one
stream, the discriminating compressed-float vectors (bit patterns, not
tolerances), the string and wide-string pins, every relative-integer
tier, and the fixed point shapes at every group count. Around the pins
sit the doctrine batteries: trailing-bit indifference, past-end poison,
a sabotage sweep proving every consumed bit of the golden stream is load
bearing (so the battery itself can fail), refusal proofs both ways for
every operation, and a fixed-seed property sweep of randomized op
programs holding write == read and measure >= write across the whole
surface.

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

## Benchmark

```
npm run bench
```

runs [bench/bench.js](bench/bench.js), an operation-for-operation mirror of
serialize.c's `bench.c` (itself a mirror of the C++ `bench.cpp`), so the
family's benchmark outputs read side by side: the raw bitpacker, the
representative stream packet through write, read and measure, and three
packet shapes, at the same iteration counts with the same LCG-driven inputs
and best-of-five-trials discipline. Every row is golden gated before any row
is timed — the exact buffers the loops write are verified byte for byte
against pins produced by the C reference's own bench data paths, and a bench
that fails its goldens reports nothing. `--csv` emits the numbers as
`row,op,units,value`; `BENCH_BITPACKER_PASSES` and `BENCH_STREAM_PACKETS`
scale the loops for linearity checks.

Cross-language tables built from these rows present the fastest measured
implementation as 100% and every other language as a multiple of its time —
on this bench set that reference is C++.

## License

[BSD 3-Clause](LICENSE), © Más Bandwidth LLC.
