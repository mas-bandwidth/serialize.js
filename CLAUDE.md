# serialize.js — house rules

This repository is the **sixth implementation** of the serialize family
([C++](https://github.com/mas-bandwidth/serialize),
[C](https://github.com/mas-bandwidth/serialize.c),
[Go](https://github.com/mas-bandwidth/serialize.go),
[C#](https://github.com/mas-bandwidth/serialize.cs),
[Rust](https://github.com/mas-bandwidth/serialize.rs)), a **hand-port to
native JavaScript** — no wasm in the product. All six speak ONE wire.

## The law

`STANDARD.md` at the repository root is a **verbatim vendored copy** of the
specification in mas-bandwidth/serialize. It is normative. Never edit it by
hand except to resync it byte-for-byte with upstream main; CI diffs it against
upstream on every push. Where this document and any code comment disagree,
STANDARD.md wins.

## Platform crystal

- **Zero third-party dependencies**, including test frameworks. Node's
  built-in `node:test` and `node:assert` are the entire harness.
- ESM (`"type": "module"`), **no build step**, Node 20+.
- `npm test` = `node --test` (argument-free: Node 22's runner rejects a bare
  directory positional, and the default matcher finds every `*.test.js`).
  That command must be green before every commit. Never push red.
- A green run prints test names and nothing else, the family's convention.
  The production spine's skips are silent under the dev sweep;
  `SERIALIZE_TEST_VERBOSE=1` restores them with their reason.

## Check model: two variants, selected at module load

The family standard (STANDARD.md, "Writes assume trusted data") makes the
caller responsible for well-formed writes. JavaScript has no compile-out,
so `src/mode.js` reads NODE_ENV **once at module load** and the write-path
classes export in one of two variants — the JS #ifdef:

- **CHECKED** (default): caller misuse throws, invalid write values latch —
  the always-on form of the family's debug asserts. Develop and test here.
- **PRODUCTION** (`NODE_ENV=production`): per-op caller validation removed
  from WriteStream/MeasureStream/BitWriter, the C/C++ release shape. Every
  write keeps the sticky-error gate and the buffer-end check (its false
  latches Overflow). Misuse yields wire garbage, never memory unsafety.
- **Reads validate everything in EVERY mode.** The wire is a trust
  boundary; ReadStream has no variants; ruling #8 content refusals always
  bind.
- **Errors are values**: serialize methods return `bool`, and the stream
  carries a **sticky latched error** (serialize.cs's shape). Once a stream
  has failed, every subsequent operation on it fails.
- **Hostile input NEVER throws.** A doctored buffer produces `false` and a
  latched error, never an exception.
- Both modes speak ONE wire: `npm run test:production` re-runs the golden
  pins and property sweep under the production variants. Run BOTH legs
  before every commit.

Readers refuse: past-end reads, out-of-range decoded values, invalid UTF-8,
interior NULs, wstring groups above 0xFFFF, and unpaired / misordered /
dangling surrogates. Every refusal is proven **both ways** in the tests: a
doctored vector that is refused, and an accept-boundary neighbor that is
accepted.

Trailing bits: writers zero them, readers never inspect them. `measure()` is
a **conservative bound** — 7 bits charged per alignment-performing operation —
never exact.

## float32 discipline

- `Math.fround` at **every** float32 rounding step.
- `float` and `double` ride bit-transparently via `DataView`.
- `compressed_float` uses the standard's two-rounding float32 quantization —
  fround each step. JS has no FMA hazard, but the pinned bit patterns must
  decode EXACTLY.

## BigInt boundaries

- 64-bit and 128-bit **value domains** use BigInt.
- The hot bitpacker stays in **two-word 32-bit Number arithmetic**. BigInt
  never touches the per-bit hot path except for wide values.

## Read-side buffer contract

The reader prices its windows **inside the buffer** (serialize.c's stance):
there is no past-end allocation requirement on the caller's buffer.
STANDARD.md treats this as an implementation contract; both stances conform.
Document it wherever the read API is described.

## Working discipline

- **Clip in often.** Commit AND push at every green sub-step — after each
  passing test group, never only at chunk end. Small commits, present-tense
  subjects stating what now works.
- Commit as Rowan:
  `git -c user.name="Rowan" -c user.email="rowan@mas-bandwidth.com" commit ...`
- Run `node --test` before every commit.
- Reference implementations (READ-ONLY): the C++ repo's `serialize.h` is
  canonical and its tests hold the pinned vectors; serialize.go and
  serialize.cs show the checked-runtime family shape.
- Documentation is present-state only: README is a tight hub, no roadmaps,
  no promises — describe what exists now.
