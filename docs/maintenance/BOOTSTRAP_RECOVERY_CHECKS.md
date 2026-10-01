# Bootstrap link-window and filename-bound recovery

## Recovery contract

A crash after linking a temporary SQLite inode to its public name can leave
two links. `inspect` reports the owned residue as `kind: "bootstrap-alias"`
without opening/closing that SQLite inode or repairing it. The diagnostic phase
is not a READY certification while bootstrap aliases remain.

Stop and drain all writers, then use the explicit recovery command:

```sh
meridian-bookkeeping inspect --session-dir /path/to/session-directory --json
meridian-bookkeeping recover-bootstrap --session-dir /path/to/session-directory --writers-stopped --json
```

Migration and export with the stopped-writer flag also recover these aliases
before their normal phase checks. Recovery proves original owner death and
public/private inode identity, takes the original guard exclusively, and retires
only the private aliases. Live, unknown/missing ownership, PID/name mismatch,
foreign inode or invalid guard format refuses even with stopped attestation.
Same-process owners also refuse inspection/recovery. Never unlink a public
SQLite name or substitute a different guard.

Atomic metadata writes use fixed-basename private temporaries rather than
deriving another name from a long intent path. Captures/intents preserve legacy
grammar where it fits NAME_MAX; otherwise a basename-bound SHA256 and operation
UUID/private nonce keep generated UTF-8 basenames within 255 bytes. Pending
legacy names remain readable; short names retain source binding, inode checks,
no-clobber capture and private-only deletion.

## Reproducible checks

Run `bookkeeping-bootstrap-recovery.test.ts` for real Node SIGKILL in main,
first-guard and fresh bootstrap link windows, then CLI-only recovery. It checks
read-only inspection, unchanged public inode, restored single-link state,
competing-maintainer exclusion, and live/ambiguous/foreign controls. Its filename
table includes boundary lengths, actual guard/export/candidate names and
maximum-byte Unicode names. The installed-package smoke also contains the
three static link-window crash cases; see [E2E](../../E2E.md#packaged-sqlite-bookkeeping-gate).

Only regular published files can receive a bootstrap-alias recovery hint.
The same suite also checks a directory, directory with a child, symlink and
FIFO at the main DB path: each must be rejected as nonregular before native
open or alias classification, leaving its inode and unrelated target bytes
unchanged. These refusal controls supplement, rather than replace, the real
recoverable two-link, live/unknown/foreign-owner and cross-process exclusion
cases. The unchanged `bookkeeping-schema.test.ts` checks the existing regular-
file refusal contract too. Directory link count alone is not alias provenance.

Record final package identity, runtime/platform and exit codes. Local fixtures
do not certify Linux kernel behavior, live model traffic or deployment safety.
Filename-bound recovery does not establish bounded WAL growth or change
checkpoint/deletion budgets. See [configuration](../configuration.md#session-bookkeeping-maintenance)
and CLI help for recovery/refusal boundaries.
