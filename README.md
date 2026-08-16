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
