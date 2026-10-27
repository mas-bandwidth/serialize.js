; The serialize.js roadmap: the data ROADMAP.md is generated from.
; Same shape as nova-sprint's docs/roadmap.sexp (internal/roadmapdoc's package comment):
; data, never evaluated. Edit this file, then regenerate ROADMAP.md with nova-sprint's
; generator, from a nova-sprint checkout:
;   go build -o /tmp/roadmap ./tools/roadmap && (cd <this repo> && /tmp/roadmap --file docs/roadmap.sexp --out ROADMAP.md)
; Never edit ROADMAP.md by hand. Created 2026-10-14 when this repository's open GitHub issues and
; unfinished pull requests were moved into it.
(roadmap "v1"
 :title "serialize.js roadmap"
 :text "Planned work for serialize.js. The items below were open GitHub issues and pull requests, moved here on 2026-10-14 when roadmaps became the standard for future work (Glenn, 2026-10-14). Each item names its issue or pull request; the branches of moved pull requests are kept to resume from. Landed work is in git."

 :groups
 (
  (group "github-issues" :title "Moved from GitHub issues on 2026-10-14"
   :text "Open GitHub issues of mas-bandwidth/serialize.js, recorded here on 2026-10-14 when roadmaps became the standard for future work (Glenn, 2026-10-14). Each item names its issue; the issue is closed with a pointer here.")
  (group "v2.1-open" :title "Left open at serialize.js 2.1.0"
   :text "Reference v2.1.0's uniform rules (IMPLEMENTING.md U1 to U16) and the 2026-10-27 audit findings for this port, deferred when the 2.1 wrap-up order (Glenn, 2026-10-27) limited 2.1.0 to the re-vendor and the rejected reason (U2, landed). Each rule is unaudited here until its item closes: none is claimed kept or broken.")
 )

 :items
 (
  (item "issue-22" :group "github-issues" :area "serialize.js"
   :title "measure a capacity-reading BitReader: offer the 8-byte slack contract from ArrayBuffer spare capacity, as the Go port does with cap()"
   :text "The BitReader in src/bitpacker.js takes the zero-slack option: it requires no allocation past the data and pays for that with reset-time work plus a compare in the window load. The standard admits that shape only as the slower correct option, so the faster one should at least be measured before the choice stands on cost."
   :date "2026-10-14"
   :origin "mas-bandwidth/serialize.js issue #22, opened 2026-09-13 by rowan-claude; moved here 2026-10-14"
   :kept (:github-issue "22" :labels ""))
  (item "u1" :group "v2.1-open" :area "serialize.js"
   :title "U1: write buffers are a multiple of 8 bytes"
   :text "Check that WriteStream and BitWriter require and check a length that is a multiple of 8, and that every doc says 8, never 4. Done when: a unit test cites U1 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U1 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u3" :group "v2.1-open" :area "serialize.js"
   :title "U3: the writer never sends bytes that differ from the caller's value"
   :text "Check that string writes and measures use a strict UTF-8 codec: a lone surrogate is write misuse and is never replaced. Done when: a unit test cites U3 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U3 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u4" :group "v2.1-open" :area "serialize.js"
   :title "U4: check UTF-8 and NUL on every string write"
   :text "Check that the checked write path refuses ill-formed UTF-8 and U+0000 on string write and measure. Done when: a unit test cites U4 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U4 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u5" :group "v2.1-open" :area "serialize.js"
   :title "U5: int bounds are int32"
   :text "Check that a min or max outside int32 is caught on the caller's value before narrowing on write and measure, and refused as value_out_of_range on read. Done when: a unit test cites U5 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U5 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u6" :group "v2.1-open" :area "serialize.js"
   :title "U6: a measure stream refuses nothing"
   :text "Check that measure misuse follows the write-misuse mechanism and a measure never latches a read refusal. Done when: a unit test cites U6 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U6 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u7" :group "v2.1-open" :area "serialize.js"
   :title "U7: a reader never traps, and a refusal is a value"
   :text "Check that read-side caller misuse (negative byte count, string buffer size below 1, bad declarations) returns false with value_out_of_range rather than throwing, with the failure state checked first. ReadStream misuse currently throws RangeError in several validators (validateBits and others). Done when: a unit test cites U7 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U7 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u8" :group "v2.1-open" :area "serialize.js"
   :title "U8: over-wide values on write are caught in the checked build"
   :text "Check that the checked write path catches a value that does not fit its bit width rather than masking it. See ledger item ledger-bits-overwide. Done when: a unit test cites U8 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U8 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u9" :group "v2.1-open" :area "serialize.js"
   :title "U9: one write-misuse mechanism per implementation"
   :text "Check that every operation, compressed_float included, uses the same write-misuse mechanism, and that fail or reject on a write or measure returns false and never throws in production. reject() follows this since 2.1.0; a public fail(reason) is U14. Done when: a unit test cites U9 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U9 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u10" :group "v2.1-open" :area "serialize.js"
   :title "U10: a write checks room for the whole operation before writing any of it"
   :text "Check that bytes and string check the room for field, align and payload before the first bit, so no length or align bits are written ahead of a payload that does not fit. Done when: a unit test cites U10 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U10 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u11" :group "v2.1-open" :area "serialize.js"
   :title "U11: a writer's buffer is unspecified until flush"
   :text "Check that every doc that describes WriteStream says flush is required. Done when: a unit test cites U11 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U11 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u12" :group "v2.1-open" :area "serialize.js"
   :title "U12: end on a write or measure stream is a no-op returning true"
   :text "Check serializeEnd on WriteStream and MeasureStream in both variants. The checked variants return false after a latched error today, which needs a ruling against U12. Done when: a unit test cites U12 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U12 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u13" :group "v2.1-open" :area "serialize.js"
   :title "U13: re-initialising a stream is optional"
   :text "Check that reset() is documented as clearing the latch on every stream that has one. Done when: a unit test cites U13 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U13 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u14" :group "v2.1-open" :area "serialize.js"
   :title "U14: the refusal-name function and a public fail(reason)"
   :text "Add a public fail(reason) on ReadStream that records rejected for no reason or a reason outside the closed list, and expose or document the refusal-name function with none for no refusal. Done when: a unit test cites U14 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U14 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u15" :group "v2.1-open" :area "serialize.js"
   :title "U15: the allowed extras, and nothing else"
   :text "Audit the public surface against U15's list, and add serialize_copy_string and compressed_float_precomputed if they are missing. Done when: a unit test cites U15 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U15 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "u16" :group "v2.1-open" :area "serialize.js"
   :title "U16: caller declarations validated on every stream before any bits move"
   :text "Check bits counts, fixed point bounds, ranged min <= max, string buffer_size >= 1 and the precomputed compressed_float constants on read (value_out_of_range, never a throw) and on write and measure (the write-misuse mechanism). Done when: a unit test cites U16 and is green, with a red-first test and fix if the port broke the rule, or a one-line note that the port already keeps it."
   :date "2026-10-27"
   :origin "IMPLEMENTING.md U16 at mas-bandwidth/serialize v2.1.0; deferred by the 2.1 wrap-up order, 2026-10-27")
  (item "ledger-bits-overwide" :group "v2.1-open" :area "serialize.js"
   :title "Audit M: checked build masks over-wide bits on write"
   :text "serializeBits(256, 8) writes 0 in the checked build instead of being caught (U8). Reproducer: /Volumes/nova/ai/rowan/working/serialize-love/audit2/serialize.js/audit-repro/bits-overwide.mjs. Run it first and confirm it fails before fixing. Done when: the reproducer is a unit test that is red on the old code and green on the fix, in the checked build."
   :date "2026-10-27"
   :origin "serialize-love AUDIT-LEDGER.md, heading js, 2026-10-27; deferred by the 2.1 wrap-up order")
  (item "ledger-overlap" :group "v2.1-open" :area "serialize.js"
   :title "Audit L: overlapping src/dst buffers corrupt copies of 64 bytes or fewer"
   :text "Copies of 64 bytes or fewer through overlapping source and destination buffers corrupt the data. Reproducer: /Volumes/nova/ai/rowan/working/serialize-love/audit2/serialize.js/audit-repro/overlap.mjs. Run it first and confirm it fails before fixing, or record that the overlap is caller misuse and document it. Done when: the reproducer is a unit test that is green, or the contract is documented and the reproducer is recorded as misuse."
   :date "2026-10-27"
   :origin "serialize-love AUDIT-LEDGER.md, heading js, 2026-10-27; deferred by the 2.1 wrap-up order")
  (item "ledger-read-buffer-doc" :group "v2.1-open" :area "serialize.js"
   :title "Audit L: read-buffer doc stale; zero-slack reader does a per-op compare"
   :text "The read-buffer documentation is stale, and the zero-slack BitReader pays a compare per window load, which IMPLEMENTING.md's buffer contract calls the slower correct option (speed rule). Same as roadmap item issue-22 and java L3. Timing runs only on amd-3. Done when: the slack contract is measured against the zero-slack reader on amd-3, the faster one ships, and the read-buffer docs state the contract the reader actually has."
   :date "2026-10-27"
   :origin "serialize-love AUDIT-LEDGER.md, heading js, 2026-10-27; deferred by the 2.1 wrap-up order")
 ))
