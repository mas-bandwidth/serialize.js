# serialize.js

[![CI](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml/badge.svg)](https://github.com/mas-bandwidth/serialize.js/actions/workflows/ci.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

![serialize.js logo with a packed row of colored blocks](images/serialize.png)

A bitpacking serialization library for **JavaScript**. One of the nine
implementations of the serialize family, wire compatible with the
[C++](https://github.com/mas-bandwidth/serialize),
[C](https://github.com/mas-bandwidth/serialize.c),
[C#](https://github.com/mas-bandwidth/serialize.cs),
[Dart](https://github.com/mas-bandwidth/serialize.dart),
[Elixir](https://github.com/mas-bandwidth/serialize.elixir),
[Go](https://github.com/mas-bandwidth/serialize.go),
[Java](https://github.com/mas-bandwidth/serialize.java) and
[Rust](https://github.com/mas-bandwidth/serialize.rs) libraries — the same
values produce the same bytes in every one, so a stream written by one reads
in any other.

If this library helps you, **[please support it](https://www.patreon.com/MasBandwidth/membership)**

## Getting it

serialize.js ships as source today. The implementation is ready and the package
is not yet published, and the npm name is still to be decided: the bare name
`serialize` on npm belongs to an unrelated package — a flow-control utility,
latest 0.1.3 — so it is not ours to take. The `"name": "serialize"` in
`package.json` is a local placeholder, not a published identity. Choosing the
scoped name and pushing the package is a separate round.

To use it now, vendor the source. It is pure JavaScript, zero dependencies, no
build step — `src/` is what runs:

```sh
git clone https://github.com/mas-bandwidth/serialize.js.git   # or add it as a submodule
```

then import the entry point by path:

```js
import { WriteStream, ReadStream, MeasureStream } from './serialize.js/src/index.js';
```

Node 20 or newer, ESM only. Pin a release tag rather than tracking `main`. The
newest is on the [releases page](https://github.com/mas-bandwidth/serialize.js/releases):
a release states a format version, and two endpoints interoperate only when they
carry the same one.

## The surface

The complete family operation set, on three streams sharing one
bool-returning serialize surface — `WriteStream`, `ReadStream` and
`MeasureStream` — so a single serialize function writes, reads and
measures. [USAGE.md](USAGE.md) teaches every operation by example.

- **Raw bits**: `serializeBits` (1–32), `serializeBits64` (1–64, BigInt),
  `serializeAlign`.
- **The end**: `serializeEnd` — a packet reader calls it after the last
  field of the packet's top-level object; it refuses a whole byte left over
  (`trailing_data`) and a set bit in the final byte's padding
  (`nonzero_padding`). Writes and measures emit nothing.
- **Ranged integers**: `serializeInt`, `serializeInt64`,
  `serializeInt128` — offset from min in exactly the bit length of the
  range, unsigned-domain arithmetic so ranges wider than 2^63/2^127 are
  exact, zero bits for a degenerate range. 64- and 128-bit values are
  BigInt end to end, never a Number.
- **Unsigned helpers and bool**: `serializeUint8` / `16` / `32` (Number),
  `serializeUint64` / `serializeUint128` (BigInt), `serializeBool`.
- **Floats**: `serializeFloat` and `serializeDouble`, finite values only —
  NaN and the infinities are refused on read (`non_finite_float`), tested
  on the raw bits, and latched by the checked writer; negative zero and the
  subnormals travel bit exact. `serializeCompressedFloat` quantizes in
  float32 with the standard's two roundings on each side and refuses a
  non-finite decode.
- **Bytes and strings**: `serializeBytes` (aligned bulk copy, count
  agreed, not transmitted); `serializeString` (UTF-8 on the wire; a read
  refuses a zero byte as `embedded_nul` before it refuses malformed UTF-8
  as `invalid_utf8`, through a fatal decoder that never substitutes U+FFFD
  or strips a byte order mark; the checked writer refuses U+0000 and lone
  surrogates rather than letting `TextEncoder` launder them).
- **The relative integer**: `serializeIntRelative` — the flag ladder for
  strictly increasing sequences over the non-negative int32 domain, 0 to
  2^31 - 1, one bit for a difference of 1, no wrapping. Every tier's
  reconstruction is checked against the domain on read, and the absolute
  tier refuses a difference a bounded tier carries (`non_canonical`).
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

Every refusal has a reason from the standard's closed list — `past_end`,
`value_out_of_range`, `nonzero_padding`, `trailing_data`,
`non_finite_float`, `invalid_utf8`, `embedded_nul`, `non_canonical` — the
values of `SerializeError`, and `stream.error` holds the first one.

## Conformance

[STANDARD.md](STANDARD.md) — vendored verbatim from
[mas-bandwidth/serialize](https://github.com/mas-bandwidth/serialize) and
diffed against upstream by CI on every push — is the authority. This
library implements **format version 2.0**: the wire carries only integers
and bytes, and every value has exactly one encoding.

[`conformance/`](conformance) is vendored and diffed the same way: it is
the family's shared corpus, covering every operation the standard defines.
`test/conformance.test.js` discovers the directory rather than naming its
files and runs every vector in it on both legs — an accepted vector must
yield its value and consume its stated bits, a `writer = canonical` vector
must re-emit its whole stream byte for byte, a `measure_at_least` vector
must price at or above its floor, a `writer_input` vector must emit its
bytes from the stated float32, and a refused vector must refuse for its
stated reason, leave the caller's scalar destination untouched and leave
the stream terminal. A
vector whose operation, parameter or step spelling the runner cannot drive
fails the run rather than being skipped. Nothing there is regenerated from
this port's own codec.

[`conformance-controls/`](conformance-controls) is vendored the same way,
and `test/conformance-controls.test.js` proves the runner responds: a
vector whose operation has no runner must be red, and for each of fifteen
refusal rules a copy of the library with that one rule deleted must fail
exactly the vectors the rule's `.expected` list names, no more and no
fewer.

[`interop/`](interop) takes it further: the CI `interop` job builds the C++
reference and runs it head to head with this port. Both halves write the
same boundary message — every operation the standard defines, at its
boundary values — and the files must be byte identical; each then decodes
the other's bytes and re-encodes them exactly; both must refuse every
truncation of the other's stream, and the stream with one byte more; and
both run the corpus. The wire
exchange is pinned to a released tag of the reference, so "compatible with
C++" means the same thing here as in every other port; the corpus is driven
by the reference at the commit the corpus itself is vendored from. The
release candidate in this repository exchanges bytes with the reference on
every push, so wire compatibility is measured rather than asserted.

Around the corpus the suite pins the family's golden vectors byte for
byte: the 106-byte golden message STANDARD.md prints, covering every
operation class in one stream and ending with its end, the
discriminating compressed-float vectors (bit patterns, not tolerances),
the string pins, every relative-integer tier, and the fixed point shapes
at every group count. Around the pins sit the doctrine batteries: field
reads indifferent to the bits after them and the end refusing them,
past-end poison, a sabotage sweep proving every bit of the golden stream
is load bearing (so the battery itself can fail), refusal proofs both
ways for
every operation, and a fixed-seed property sweep of randomized op
programs holding write == read and measure >= write across the whole
surface.

## Design

This is a **hand-port to native JavaScript** — no wasm. Errors are values —
bool-returning serialize methods plus a sticky latched stream error — and
hostile input never throws.

The check model is the family standard's (STANDARD.md, "Writers are
trusted; readers are not"): **the caller is responsible for well-formed
writes**, with
writer contracts asserted in a **checked build** — the standard's term
for a build with assertions enabled — and compiled to zero in release.
JavaScript has no compiler to strip code, so the write path forks **once,
at module load**, on `NODE_ENV` — the JS `#ifdef`:

- **Checked** (the default): caller misuse throws, invalid values latch —
  the always-on form of the family's checked-build assertions. Develop and
  test here.
- **Production** (`NODE_ENV=production`): the caller is trusted, exactly as
  a C/C++ release build trusts it. Per-operation caller validation is gone
  from `WriteStream`, `MeasureStream` and `BitWriter`; every write keeps
  the sticky-error gate and the buffer-end check, whose false latches
  `PastEnd` — a message that does not fit is a runtime condition, not a
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
npm run lint              # ESLint at a pinned release through npx, zero warnings
```

`npm test` is nothing more than `node --test` — the runner's default matcher
picks up every `*.test.js` under `test/`. (A bare directory argument stopped
being accepted by Node 22's runner, so the invocation stays argument-free.)
The production leg runs `production-tests.mjs`, which spawns the same runner
with `NODE_ENV=production` pinned over every test file that asserts no
dev-only caller validation, plus `test/production/` — where each dev assert
is proven **absent**: calls that throw or latch in dev pass through in
production, and overflow still latches. CI runs both legs on every OS and
Node version, and lint as its own failing check.

### Fuzzing

`fuzz/` holds a coverage-guided fuzz harness on [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js),
the two passes of the reference's `fuzz.cpp`. Jazzer.js is pinned in
`fuzz/package.json` and its own lockfile, so the library package itself
keeps zero dependencies.

```
cd fuzz && npm ci
npx jazzer read.fuzz.js corpus/read --sync -- -max_total_time=60
npx jazzer roundtrip.fuzz.js corpus/roundtrip --sync -- -max_total_time=60
```

`read.fuzz.js` feeds arbitrary bytes through every read primitive: each read
returns true with a value inside its contract, or false with a reason from
the closed list, its destination untouched and every later call an echo;
nothing throws, and the same bytes read through a view over a larger buffer
give identical results. `roundtrip.fuzz.js` writes values generated from the
input, measures and reads them back: any asymmetry, or a measure below the
bits written, is a finding. `SERIALIZE_FUZZ_SABOTAGE=int-relative-tier`
fuzzes a copy of `src/` with a planted writer asymmetry instead, the
negative control. CI runs both targets for 60 s and requires the negative
control to be caught on every push; `nightly-fuzz.yml` runs them for an hour
a day on a cached corpus, the round trip under both write-path variants.

Benchmarking for the serialize family lives in [mas-bandwidth/schema](https://github.com/mas-bandwidth/schema)'s data-driven bench, which measures the generated codecs across every language on one corpus.

## License

[BSD 3-Clause](LICENSE), © Más Bandwidth LLC.
