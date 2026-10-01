# SQLite maintenance correctness correction

Scope: confirmed cold findings R1–R5, architectural F5 and handshake R7.
No deployment, live credentials, host access, publication, performance-query
rewrite or upstream-cleanup patch is included. The original private carrier
`0713feb768a420550f9b7e7670313e740fa652521d9cb2205c1c2cee8048da6f`
is NOT a corrected artifact and is not overwritten.

## Causal changes and durable falsifiers

| Finding | Change | Executable falsifier / negative control |
|---|---|---|
| R1 guard inode retirement | Published guard is permanent; existing authority cannot bootstrap a missing guard; old retirement intents/captures refuse before ordinary native opens. Explicit stopped recovery restores/locks only the recorded original inode, never overwrites a different public inode. | `bookkeeping-cold-maintenance.test.ts`: two real Node processes, ordinary close/retire race refusal, real SIGKILL intent, interrupted capture, foreign-public-inode refusal and restored exclusion. |
| R2 inspection drops OS locks | In-process inspection refuses while local bookkeeping owners exist, including main/guard hardlink alias directories; standalone CLI still works. | Same suite: child maintainer refused before AND after inspection/alias attempts, owner still reads READY; after close inspection/child maintenance succeed. |
| R3 stranded invalid imports | Exact row codecs/bindings/DDL/triggers/constraints run in disposable memory transaction before barriers and repeat under ownership. Historical PREPARED import may abort only with exact empty schema/provenance/rows/fences proof. | Cold/migration/export suites: ordinary scalar NUL key, fractional createdAt/messageCount, raw-byte preservation, no main/journal/barriers after refusal; historical empty PREPARED abort; nonempty fence refusal. |
| R4 fresh split authority | Fresh is the empty-input durable journal/barrier protocol under exclusive guard, with non-overwriting atomic legacy barriers BEFORE SQL publication. Unjournaled databases are not adopted. | Cold suite: real JSON lock writer positive control and denial with SQL owner; separate-process inspect; export; SIGKILL at PREPARED / first barrier / BARRIERS / main publication / READY, explicit resume and reopen. Exact-schema unjournaled database refuses without modification. |
| R5 JSON after terminal transition | Validate terminal journals, barrier release, absent active DB/sidecars, archive proof and retained sources; no journal-absence shortcut or history deletion. | Public runtime tests: active/incomplete refusal, fresh export → same-build JSON startup, historical abort → same-build JSON; reintroduced barrier / corrupted archive refusal. |
| F5 post-READY gate recovery | `export-json --writers-stopped` records/reuses inode-checked residue archive; resumes private gate captures as well as root retirement intents. Unknown is accepted only by explicit stopped-child testimony; live/indeterminate ledger owners still refuse. | Cold suite: unknown `go\n` refuses ordinary export, explicit export archives exact bytes; real SIGKILL at archive link/private capture resumes; extant SDK owner refuses without touching gate. |
| R7 late executor COMMIT | Forward combined handshake signal into SQL attachment admission; retain external cancellation and separate durable finish budget. | `bookkeeping-handshake-cancellation.test.ts`: real Node BEGIN IMMEDIATE writer held 1100ms, handshake 80ms; no executor COMMIT/SDK call after timeout; no-contention commits/executes once; external abort leaves no pending admission and later admission succeeds. Total finish duration is not asserted as handshake timeout. |

R6 portable contracts were incorporated from the separately accepted
`574b5ea977cedf921049150d0453cb396fbe5702`; they are not a runtime fix.

## Local observations / ceiling

Before changes, the independent source reproducers were copied into this own
worktree without editing their canonical review copies. Native guard probes
reproduced dual exclusive / lost exclusion, migration-rejection probes stranded
ordinary NUL/fractional inputs, and built Node entrypoints reproduced fresh
inspect/export and JSON-after-export refusal. The R7 busy case reproduced one
late executor COMMIT with no SDK call. Logs remain under
`.evidence/sqlite-code-review/*-before.log`.

After changes: Node22 typecheck and build exited 0; focused bookkeeping suites
passed 817 tests / 10442 assertions, 27 existing skips, zero failures. The
one-shot admission suite is intentionally isolated by `npm test`, not skipped
from final acceptance. The repository packaged smoke independently installs
candidate + explicit old JSON baseline: old public cache writer succeeds in a
legacy directory but is denied while fresh SQL owner lives; CLI invalid imports
refuse before authority changes; fresh CLI inspect/export, same-build JSON
restart, original guard recovery and stopped gate archive are asserted.

These are author observations on macOS with real local SQLite/process locks,
synthetic data and local SDK fixture only. They do NOT certify Linux kernel
locking, real model traffic, host transfer, foreign-incarnation cleanup or
production readiness. Parent cold review and Linux installed-package verifier
must evaluate the new digest; earlier acceptance of the old carrier does not
transfer. Full final-suite outcome and immutable new package identity belong
in the candidate handoff, not inferred from these focused observations.

Recovery commands and refusal boundaries: `docs/configuration.md` and CLI help.
Canonical negative probes: `scripts/e2e-session-bookkeeping-packaged.mjs` plus
the repository fixtures above. No operator should repair an intent by unlinking
public guards/barriers, changing recorded inode numbers, or pretending an
unknown/foreign process is dead.
