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

## Checked-runtime shape (the Go/C#/Rust side of the family)

JavaScript has no compile-out, so like Go, checks run in **every** build:

- **Writes keep their checks.** There is no NDEBUG to strip them into.
- **Reads validate everything.** The wire is a trust boundary.
- **Errors are values**: serialize methods return `bool`, and the stream
  carries a **sticky latched error** (serialize.cs's shape). Once a stream
  has failed, every subsequent operation on it fails.
- **Hostile input NEVER throws.** A doctored buffer produces `false` and a
  latched error, never an exception.

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
