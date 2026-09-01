# BitWriter single-word staging — ROUND-LOG

The runtime half of schema's js READS round (schema#237's §3 report,
issue #10 here). One line per unit: what landed, the measurement that
justified it, the decision taken.

Base: `origin/main` @ 5fc0b19.

## The instrument, first — A/A NULL before any number

A paired instrument (scratch, not committed: `wpair.mjs`) loads two RUNTIME
checkouts as arms, each arm's timing loop built from its own source text so
the two never share a SharedFunctionInfo or a feedback vector. One path per
invocation, arm order rotated by round parity, the max over 7 measured rounds
(BENCH-STANDARD §2.2) after two discarded warmup rounds in both orders.

The workload is BENCH-STANDARD.md §1.4, family `bits`: the 16-width table
(1, 32, 7, 13, 3, 25, 8, 19, 4, 28, 11, 16, 2, 30, 6, 22 — 227 bits/group)
filling a 65536-byte buffer, the estate's ONE bitpacker workload. A second
path exercises `writeBytes`, whose word granularity this change moves.

Every pair run passes a wire gate before it times anything: both arms write
the same 65,518 bytes byte-identically, each reads back exactly what it
wrote, and each arm's READER re-reads the other arm's buffer.

**A/A null** — both arms `origin/main`, the second a copy on a different path:

| path | A/A null (B/A on the max) | band |
|---|---|---|
| bits | 0.9965, 0.9973, 1.0113 | **±1.1%** |
| bytes | 0.9978, 0.9979 | **±0.2%** |

## Units

- **UNIT 1 — the single-word 32-bit staging form** (issue #10). The writer
  staged into a two-lane 64-bit scratch (`#scratchLo`/`#scratchHi`,
  `#scratchBits` in [0,63]) and flushed a pair of little-endian 32-bit words
  every 64 bits. Each merge carried a data-dependent lane split (`s < 32`),
  a nested `s > 0` guard inside it, and the 64-bit flush branch. The
  single-word form keeps ONE 32-bit staging word with `#scratchBits` in
  [0,31]: one shift-or, one add, one flush branch storing one word — the
  exact form schema's generated flat tier retired the two-lane staging for
  in #237 (1.44x on its primitive micro).

  **Byte-equivalence, stated**: an LSB-first packer into consecutive
  little-endian 32-bit words emits the identical byte stream either way — the
  old form's pair of `setUint32(base)`/`setUint32(base+4)` IS two consecutive
  32-bit words. The invariant is that the staging word's bits at and above
  `scratchBits` are zero; `value << s` contributes bits [s, min(s+bits, 32)),
  a JavaScript shift drops the rest, and the flush recovers the dropped high
  bits as the next word's low bits. `spill === 0` is the single case where
  the recovery shift would be 32 — a no-op in JavaScript, not zero — and it
  is taken as a literal zero. With `s` in [0,31] no shift here is ever the
  mod-32 no-op the two-lane form needed guards for.

  **Scope, exactly as the issue named it**: the four fused copies
  (`CheckedBitWriter.writeBits` / `.tryWriteBits`,
  `ProductionBitWriter.writeBits` / `.tryWriteBits` — the file's own KEEP THE
  FOUR COPIES IDENTICAL rule holds, applied by one scripted edit that refuses
  unless it finds exactly four), plus the flush and reset invariants, plus
  `writeBytes`, whose "the scratch is empty at a word boundary" argument now
  holds every 32 bits rather than every 64 (head and tail through the scratch
  drop from ≤7 bytes to ≤3, and the bulk copy unit is 4 bytes).

  **flushBits keeps the memory behaviour** — see UNIT 2, which is where that
  claim was actually made true.

  Paired numbers, 3 invocations each, 4096 passes × 7 rounds, measured on the
  branch as it now stands (UNIT 2's unconditional pairing store included):

  | path | ratio | null |
  |---|---|---|
  | **bits** | **1.1743, 1.1809, 1.1816** | ±1.1% |
  | **bytes** | **1.3594, 1.3605** | ±0.2% |

  Before UNIT 2 these read 1.1832 / 1.2177 / 1.1825 and 1.3694 / 1.3801 /
  1.3871; the pairing store costs one unconditional branch per packet, which
  is the difference. The figures above are the ones that describe the branch.

- **UNIT 2 — the flush pairs its 8-byte span for EVERY bit count** (review
  condition on #11). UNIT 1's flush zeroed the odd word's partner from inside
  `if (this.#scratchBits !== 0)`. That guard is false exactly when the last
  write ended on a 32-bit boundary — the merge had already stored the word and
  left `scratchBits` at 0 — so for `bitsWritten ≡ 32 (mod 64)` the flush did
  nothing at all and the second half of the 8-byte span kept whatever the
  caller's buffer held before. `main` always wrote the full span.

  Payload bytes were never affected; the exposure is a reused dirty buffer
  whose consumer reads past `bytesWritten()` — 4 stale bytes on a transmitted
  8-byte-aligned buffer — and, just as much, the class doc's "bytes past the
  end of the written data are only ever written as zeros" being false.

  The fix is the reviewer's: the pairing store moves OUTSIDE the guard. After
  the guard the cursor is at word `ceil(bitsWritten / 32)` on both paths —
  the partial word was stored, or there was none to store — so an odd index
  means the span's second half has never been written, on either path. The
  store does not advance the cursor, so a second `flushBits` is a no-op
  rather than a walk off the end. Both class copies moved.

  **Reproduced before it was fixed**, against `origin/main` as the reference:
  a tail oracle writes k bits into a 0xff-prefilled buffer for every k in
  [0, 384] and compares the WHOLE buffer with the same write through main.
  Unfixed: **6 divergent counts — k = 32, 96, 160, 224, 288, 352, every one
  past `bytesWritten()`, never payload.** Fixed: 0 divergent across all 385.

  **The missing test class is now in the repo**: `test/writer-tail-span.test.js`
  pins k = 32 and k = 96 by name, sweeps every k in [0, 384], covers the
  `writeBytes` bulk-copy cursor, and pins flush idempotence — asserting the
  full shape (packet bytes, zeros to `8*ceil(k/64)`, untouched 0xff beyond),
  so over-zeroing fails it as loudly as under-zeroing. It joins
  `production-tests.mjs` under that file's stated membership rule: it asserts
  no dev-only caller validation, and both class copies carry the flush.
  Negative control: with the store back inside the guard the file reports
  **9 failures and exits 1 in BOTH modes**.

  Gates: `node --test` 290 tests, 0 fail; `node production-tests.mjs` 129
  tests, 0 fail — both include the golden-wire battery. STANDARD.md
  untouched, so the vendored-copy job is unaffected.

## Pairing with schema

schema's js legs run green against this checkout through the §3.5
`SERIALIZE_JS` override — the generated flat tier imports nothing, so the
pairing that matters is the runtime tier's cross-validation gate (bytes,
fields and verdicts, 64 variants) inside the bench runner, plus `test/js` in
both NODE_ENV modes. schema CI pins a serialize.js TAG
(`SERIALIZE_JS_TAG: v1.1.0`); bumping that pin after this lands is the named
landing follow-on, not part of either PR.
