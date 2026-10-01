# Bootstrap link-window / NAME_MAX correction

OpusA F1 consists of two composable availability defects, reproduced before
changes in this writer worktree from the independent synthetic probes:

- SIGKILL during private retirement after temp→public link leaves public main
  PREPARED, first guard, or fresh main with nlink=2. Before: CLI refuses repeatedly
  before cleanup; direct API cleanup fails ENAMETOOLONG.
- Legacy intent resume rewrites an already-long intent using another derived
  temporary name. Before: basename 66/73 fails; 60/65 resumes.

## Changes / refusal boundaries

Atomic writes use fixed-basename private temporaries, never a name derived from
the destination intent. Capture/intent generation preserves legacy grammar for
names fitting NAME_MAX and otherwise uses a basename-bound SHA256 + operation
UUID + private nonce. Every generated UTF-8 basename is ≤255 bytes. Readers
accept pending legacy names and validate the source binding of short names.
No-clobber capture, inode equality and private-only deletion remain unchanged.

Inspect classifies bootstrap aliases read-only, without auxiliary SQLite inode
opens/closes or cleanup. It reports `kind=bootstrap-alias`, with the original
owner's observed verdict; diagnostic phase is not READY certification.
Explicit `recover-bootstrap --writers-stopped` (also recovery-before-transition
for migrate/export with that flag) takes the original guard EXCLUSIVE before
cleanup. The first-guard link window validates dead-owner identity, matching
public/private inode and guard schema using native SQLite without an auxiliary
fd, then locks before alias retirement. Legacy bootstrap retirement intents are
treated as native aliases during this proven recovery, so closing a resumed
auxiliary descriptor cannot revoke the new guard lock.

Live, indeterminate/missing owner, PID/name mismatch, foreign inode or invalid
guard format fails closed even with stopped attestation. Same-process owners
still prohibit inspection/recovery; no randomly linked database is adopted and
the public main/guard inode is never removed or exchanged. This does not change
checkpoint scheduling, deletion budgets or performance queries.

## Executable observations (author, macOS / Node22 local kernel)

- Original `window-kill-probe` copied into own evidence directory: after change,
  CLI migration returns READY for all three windows; prior repetitions returned
  3/4 forever. Existing database-prepared/no-kill negative controls still pass.
- Original `namemax-probe`: 60/65/66/73 all resume to zero remaining files.
- `bookkeeping-bootstrap-recovery.test.ts`: real Node SIGKILL at the actual
  retirement-intent window, read-only before/after hashes, CLI-only READY,
  public inode unchanged/nlink=1; table of guard temp, exported main/WAL,
  candidate and maximum-byte Unicode names; live/ambiguous/foreign controls.
- First-guard retirement callback spawns a REAL competing Node maintainer:
  exclusive is refused during cleanup, succeeds after the owner releases.
- Focused bootstrap/private-retirement/schema/review/crash/CLI suites:
  293 pass, 0 fail, 5448 assertions; typecheck exit 0.

Logs: `.evidence/opusA-review/{window,namemax}-{before,after-initial}.log`
and `focus-final.log`. Durable probes are the repository tests and the packaged
smoke's three static link-window crash cases. They do not prove Linux kernel
behavior, real model traffic or production readiness. Final combined artifact
must include the separately coordinated OpusB checkpoint fix before final gate,
independent OpusA rerun and affected Linux installed-package acceptance. Earlier
19ad/1f57 artifacts remain intact and are not claimed fixed for this case.

The coordinated checkpoint change is now included from source
`7a4fd2bce4309314e61c6d1e5a8ef7821212759f`: PASSIVE gets a bounded FIFO-head
opportunity outside BEGIN, retaining pending ownership until settlement.
Later write admissions cannot overtake that opportunity. GC's result is
published independently of checkpoint outcome; checkpoint deferral/failure has
distinct diagnostics and frame-count debt. External readers/writers can still
prevent WAL progress, so neither this mechanism nor focused tests claim that
every sweep shrinks WAL. Offline TRUNCATE remains exclusive and unchanged.

## Nonregular-path integration follow-up

Runtime follow-up `d052795d4937d2af790fbf866ff8fb594eece39f` must accompany A:
only regular published files may receive the bootstrap-alias recovery hint.
Directories, symlinks and FIFOs remain nonregular-file refusals before native
open, without inode changes. Alias/ownership/OS-lock guards are not loosened.

Exact unchanged `bookkeeping-schema.test.ts` was re-run on own immutable source
snapshots and the corrected head under Node22/APFS: f464 and clean rebase 754
fail at the directory assertion; d052 passes. The two failing connection files
are byte-identical; the schema test is byte-identical in ALL three heads. This
is an omitted late runtime follow-up, not a Node version, directory nlink or
test-surface discrepancy. The original standalone Node counterexample observes
directory nlink=2/mode=755 in both snapshots, but its wrong-class assertion no
longer reproduces on d052. Raw records: `.evidence/type-classification/`.

The additional table regression covers plain directory, directory with child
(nlink>2), symlink and FIFO; both historical snapshots fail the directory cases
and the corrected head passes all four without touching targets. Existing real
recoverable nlink=2, live/unknown/foreign-owner and cross-process exclusion
controls remain separate tests, not replaced by this negative-path table.
