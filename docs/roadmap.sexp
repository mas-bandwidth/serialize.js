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
 )

 :items
 (
  (item "issue-22" :group "github-issues" :area "serialize.js"
   :title "measure a capacity-reading BitReader: offer the 8-byte slack contract from ArrayBuffer spare capacity, as the Go port does with cap()"
   :text "The BitReader in src/bitpacker.js takes the zero-slack option: it requires no allocation past the data and pays for that with reset-time work plus a compare in the window load. The standard admits that shape only as the slower correct option, so the faster one should at least be measured before the choice stands on cost."
   :date "2026-10-14"
   :origin "mas-bandwidth/serialize.js issue #22, opened 2026-09-13 by rowan-claude; moved here 2026-10-14"
   :kept (:github-issue "22" :labels ""))
 ))
