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
  (group "v2.1-open" :title "Left open at serialize.js 2.1.2"
   :text "At 2.1.2 (2026-10-28) the port keeps the uniform rules of IMPLEMENTING.md (reference v2.1.1): write misuse, an operation that does not fit the room left included, throws and never latches (U9), copyString is serialize_copy_string (U15), and the bytes span is a documented language necessity (U15); each is proved in test/uniform-rules.test.js and test/uniform-rules-checked.test.js. Landed work is in git, so its items are gone from here. What stays open is below.")
 )

 :items
 (
  (item "issue-22" :group "github-issues" :area "serialize.js"
   :title "measure a capacity-reading BitReader: offer the 8-byte slack contract from ArrayBuffer spare capacity, as the Go port does with cap()"
   :text "The BitReader in src/bitpacker.js takes the zero-slack option: it requires no allocation past the data and pays for that with reset-time work plus a compare in the window load. The standard admits that shape only as the slower correct option, so the faster one should at least be measured before the choice stands on cost."
   :date "2026-10-14"
   :origin "mas-bandwidth/serialize.js issue #22, opened 2026-09-13 by rowan-claude; moved here 2026-10-14"
   :kept (:github-issue "22" :labels ""))
  (item "ledger-read-buffer-doc" :group "v2.1-open" :area "serialize.js"
   :title "Audit L: measure the zero-slack reader's per-load compare against the 8-byte slack contract on amd-3"
   :text "The zero-slack BitReader pays reset-time window assembly and a compare per window load, which IMPLEMENTING.md's buffer contract calls the slower correct option (speed rule). Same as issue-22 and java L3. Since 2.1.1 the read-buffer docs (CLAUDE.md, USAGE.md, the BitReader comment) state the contract the reader actually has and that it is unmeasured; the measurement is still owed. Timing runs only on amd-3, with nothing else running. Done when: the slack contract is measured against the zero-slack reader on amd-3, and the faster one ships with its contract documented."
   :date "2026-10-27"
   :origin "serialize-love AUDIT-LEDGER.md, heading js, 2026-10-27; docs half closed in 2.1.1")
  (item "u7-null-ref" :group "v2.1-open" :area "serialize.js"
   :title "U7: a read handed no ref holder (undefined or null) throws a TypeError from the language"
   :text "Every read assigns ref.value, so a caller that passes undefined or null as the holder gets a TypeError from the runtime, not a value_out_of_range refusal. Refusing it costs a check on every read on the hot path, which the speed rule says must be measured first. Done when: the per-read check is measured on amd-3 and either lands with a unit test, or the reference rules a missing holder a language-level error outside U7."
   :date "2026-10-27"
   :origin "2.1.1 U7 audit")
 ))
