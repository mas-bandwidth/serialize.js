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

  **flushBits keeps the memory behaviour**: it stores the one pending 32-bit
  word and, when that leaves the cursor on an odd 4-byte word, zeroes the
  next one — so the bytes past the written data are still only ever written
  as zeros over the same 8-byte span, the buffer-length contract (a multiple
  of 8) is unchanged, and a reader that loads 64 bits at the tail sees the
  memory it always did.

  Paired numbers, 3 invocations each, 4096 passes × 7 rounds:

  | path | before (max) | after (max) | ratio | null |
  |---|---|---|---|---|
  | **bits** | 6.49–6.68 K passes/s | 7.88–7.91 | **1.1832, 1.2177, 1.1825** | ±1.1% |
  | **bytes** | — | — | **1.3694, 1.3801, 1.3871** | ±0.2% |

  Gates: `node --test` 285 tests, 0 fail; `node production-tests.mjs` 124
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
