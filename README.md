# serialize.js

[![CI](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml/badge.svg)](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

If this library helps you, please support it: **[Become a supporter](https://www.patreon.com/MasBandwidth/membership)**

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
  validated on read in every mode); `serializeWideString` (one 32-bit group per
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

This is a **hand-port to native JavaScript** — no wasm. Errors are values —
bool-returning serialize methods plus a sticky latched stream error — and
hostile input never throws.

The check model is the family standard's (STANDARD.md, "Writes assume
trusted data"): **the caller is responsible for well-formed writes**, with
writer contracts asserted in debug and compiled to zero in release.
JavaScript has no compiler to strip code, so the write path forks **once,
at module load**, on `NODE_ENV` — the JS `#ifdef`:

- **Checked** (the default): caller misuse throws, invalid values latch —
  the always-on form of the family's debug asserts. Develop and test here.
- **Production** (`NODE_ENV=production`): the caller is trusted, exactly as
  a C/C++ release build trusts it. Per-operation caller validation is gone
  from `WriteStream`, `MeasureStream` and `BitWriter`; every write keeps
  the sticky-error gate and the buffer-end check, whose false latches
  `Overflow` — a message that does not fit is a runtime condition, not a
  caller bug. Misuse produces garbage on the wire (which conforming readers
  refuse), never memory unsafety: JavaScript's own bounds semantics
  backstop the trusted path.

The selection is frozen — the environment is read once, whole classes are
chosen at export time, changing `NODE_ENV` after load has no effect — and
the wire is byte identical in both modes: the golden pins and the property
sweep are re-run under the production variants. Reads validate everything
in **every** mode: the wire is a trust boundary, `ReadStream` has no
variants, and the read-side content refusals bind in production too.

## Testing

```
npm test                  # dev leg: the checked variants, every suite
npm run test:production   # production leg: wire, trust boundary and
                          # caller-trust contract under the production variants
```

`npm test` is nothing more than `node --test` — the runner's default matcher
picks up every `*.test.js` under `test/`. (A bare directory argument stopped
being accepted by Node 22's runner, so the invocation stays argument-free.)
The production leg runs `production-tests.mjs`, which spawns the same runner
with `NODE_ENV=production` pinned over every test file that asserts no
dev-only caller validation, plus `test/production/` — where each dev assert
is proven **absent**: calls that throw or latch in dev pass through in
production, and overflow still latches. CI runs both legs on every OS and
Node version.

Benchmarking for the serialize family lives in [mas-bandwidth/schema](https://github.com/mas-bandwidth/schema)'s data-driven bench, which measures the generated codecs across every language on one corpus.

## License

[BSD 3-Clause](LICENSE), © Más Bandwidth LLC.
