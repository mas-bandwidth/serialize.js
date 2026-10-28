# serialize.js — house rules

This repository is one of the **nine implementations** of the serialize
family (C, C++, C#, Dart, Elixir, Go, Java, JavaScript and Rust), a
**hand-port to native JavaScript** — no wasm in the product. All nine speak
ONE wire.

## The law

`STANDARD.md` at the repository root is a **verbatim vendored copy** of the
specification in mas-bandwidth/serialize. It is normative. Never edit it by
hand except to resync it byte-for-byte with upstream main; CI diffs it against
upstream on every push. Where this document and any code comment disagree,
STANDARD.md wins.

`conformance/` and `conformance-controls/` are the same: verbatim vendored
copies of the family's shared conformance corpus and of its negative
controls' `.expected` lists, diffed recursively against upstream by the same
CI job and against the pinned release by the interop job.
`tools/revendor.sh <tag>` copies all three from a released tag.
Never hand-edit a vector and never regenerate one from this port's output —
a suite that writes its own expectations proves only that the port agrees
with itself. `test/conformance.test.js` DISCOVERS the directory — it never
names a file — and runs every vector through `ReadStream` on both legs,
plus `WriteStream` where the vector states `writer = canonical` and
`MeasureStream` where it states `measure_at_least`, and the writer on a
`writer_input` float32. A refused vector must refuse for its STATED REASON.
An empty directory fails the run, and so does a vector whose operation,
parameter or step spelling the runner cannot drive: an operation nobody
implemented must be red rather than skipped. The runner itself lives in
`test/conformance-runner.js`, shared with `test/conformance-controls.test.js`,
which copies `src/` into `.controls/<rule>/` with one refusal rule deleted
(a needle and a patch, the reference's CMakeLists.txt shape) and requires
the failing vectors to equal `conformance-controls/<rule>.expected`
exactly. A needle that stops matching is a failure: update the needle,
never delete the control.

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

The family standard (STANDARD.md, "Writers are trusted; readers are not") makes the
caller responsible for well-formed writes. JavaScript has no compile-out,
so `src/mode.js` reads NODE_ENV **once at module load** and the write-path
classes export in one of two variants — the JS #ifdef:

- **CHECKED** (default): write misuse throws, ONE mechanism on every
  operation of WriteStream, MeasureStream and BitWriter, compressed_float
  included (IMPLEMENTING.md U9): a bad declaration, a value of the wrong
  type, and a value the declaration cannot carry (out of range, wider than
  its bits (U8), not finite, text that is not well-formed or holds U+0000,
  too long for its buffer). The always-on form of the family's
  checked-build assertions. An operation that does not fit the room left
  is write misuse too and throws before any bit is written (U9, U10).
  Write misuse never latches: a write or measure stream's error is always
  None. Develop and test here.
- **PRODUCTION** (`NODE_ENV=production`): per-op caller validation removed
  from WriteStream/MeasureStream/BitWriter, the C/C++ release shape. Every
  write keeps the room check, which throws as in checked. Output after any
  other misuse is unspecified (U3, U9; a lenient encoder's U+FFFD is never
  documented behaviour), never memory unsafety.
- **Reads validate everything in EVERY mode.** The wire is a trust
  boundary; ReadStream has no variants; ruling #8 content refusals always
  bind. **A read never throws** (U7): caller misuse on read (a bad
  declaration, a span outside its array, data or a destination of the wrong
  type) refuses as `value_out_of_range` before any bits move, and the
  failure state is checked first, so a failed stream keeps its first
  reason.
- **Read refusals are values**: serialize methods return `bool`, and a
  read stream carries a **sticky latched error** (serialize.cs's shape).
  Once a read has failed, every subsequent operation on it fails. A write
  or measure never latches (U6, U9).
- **Hostile input NEVER throws.** A doctored buffer produces `false` and a
  latched error, never an exception.
- `serializeEnd` on a write or measure is a no-op returning true (U12);
  `fail(reason)` is public on every stream: on read it latches the reason
  (anything off the closed list latches `rejected`), on write and measure it
  records nothing and returns false (U6, U14). `refusalName(error)` gives
  the family spelling, `'none'` for no refusal.
- Both modes speak ONE wire: `npm run test:production` re-runs the golden
  pins and property sweep under the production variants. Run BOTH legs
  before every commit.

Format 2.0: the wire carries only integers and bytes, and every value has
exactly one encoding. Every refusal names one reason from the standard's
closed list, `SerializeError`'s values spelled exactly: `past_end`,
`value_out_of_range`, `nonzero_padding`, `trailing_data`,
`non_finite_float`, `invalid_utf8`, `embedded_nul`, `non_canonical`, and
`rejected`, the caller's own refusal (`ReadStream.reject()`, or a nested
object whose function fails with nothing latched). The
stream latches the FIRST refusal's reason; later refusals are echoes.
Readers refuse past-end reads, out-of-range decoded values, set align
padding, NaN and infinities (on the RAW bits, before any conversion), a
non-finite compressed float decode, a NUL in a string (before UTF-8, over
the whole payload), invalid UTF-8, a non-canonical int_relative absolute
tier, and at `serializeEnd` trailing bytes (first) and set final padding.
There is no wstring. Every refusal is proven **both ways** in the tests: a
doctored vector that is refused, and an accept-boundary neighbor that is
accepted; every rule also has a reversed witness (its control, or the unit
test that goes red when the old behaviour is planted back).

Trailing bits: writers zero them, field reads never inspect them, and a
packet reader's `serializeEnd` refuses a set one. `measure()` is
a **conservative bound** — 7 bits charged per alignment-performing operation —
never exact.

## float32 discipline

- `Math.fround` at **every** float32 rounding step.
- `float` and `double` carry finite values only, bit exact via `DataView`:
  the finite rule tests raw bits, and there is no NaN payload handling.
- `compressed_float` uses the standard's two-rounding float32 quantization —
  fround each step. JS has no FMA hazard, but the pinned bit patterns must
  decode EXACTLY.

## BigInt boundaries

- 64-bit and 128-bit **value domains** use BigInt, exactly, end to end:
  never through a Number (the corpus pins 2^53 + 1, 2^63, 2^64 - 1 and the
  int128 extremes, and the int64-through-double control proves the runner
  sees a lossy decode).
- The hot bitpacker stays in **two-word 32-bit Number arithmetic**. BigInt
  never touches the per-bit hot path except for wide values.

## Read-side buffer contract

The reader prices its windows **inside the buffer** (serialize.c's stance):
there is no past-end allocation requirement on the caller's buffer. This is
the zero-slack option, which IMPLEMENTING.md ("The buffer contract") calls
the slower correct option: it costs a copy or window assembly at reset and a
compare per window load. The 8-byte slack contract has not been measured
against it on amd-3, so the choice does not yet stand on cost (ROADMAP,
issue #22). Document the contract the reader actually has wherever the read
API is described.

## Working discipline

- **Clip in often.** Commit AND push at every green sub-step — after each
  passing test group, never only at chunk end. Small commits, present-tense
  subjects stating what now works.
- Commit as Rowan:
  `git -c user.name="Rowan" -c user.email="rowan@mas-bandwidth.com" commit ...`
- Run `node --test`, `node production-tests.mjs` and `npm run lint` before
  every commit.
- `package.json`'s `version` is the one place this repository carries its
  version, and it must equal the tag the commit ships in: bump it in the
  release PR, before the tag is cut.
- Sibling implementations (READ-ONLY): where STANDARD.md is silent the C++
  repo's `serialize.h` breaks the tie and its tests hold the pinned
  vectors; serialize.go and serialize.cs show the checked-runtime family
  shape. A sibling is never a source for anything the standard states.
- Documentation is present-state only: README is a tight hub, no roadmaps,
  no promises — describe what exists now.
