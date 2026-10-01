# SQLite maintenance safety checks

The maintenance suites cover these safety boundaries:

| Contract | Check |
|---|---|
| A published maintenance guard retains one coordination inode. Recovery restores only the recorded identity and never overwrites a foreign public inode. | Real-process lock exclusion, refusal/cleanup races, SIGKILL intent/capture recovery and foreign-inode refusal. |
| Same-process inspection cannot revoke native lock exclusion. | Main/guard hardlink aliases refuse while local owners exist; another process remains excluded before and after inspection. Separate-process CLI inspection remains supported. |
| Invalid legacy data is refused before authority changes. | Scalar NUL and fractional values exercise the actual SQL row representation; source bytes remain unchanged. Aborting an old PREPARED database requires proof of an exactly empty owned schema and fences. |
| Fresh SQLite startup and migration share durable provenance and legacy-writer exclusion. | Real legacy JSON writers cannot pass the barriers; fresh inspect/export and crash recovery work without adopting unjournaled databases. |
| Valid terminal export/abort permits the same build to start in JSON mode. | Active or forged authority, reintroduced barriers and corrupted archives refuse startup. Recovery journals and archives remain intact. |
| Stopped-child attestation permits conservative gate archival, not deletion of unknown authority. | Explicit export archives exact bytes and resumes interrupted private captures; live/indeterminate ledger owners still refuse. |
| Executor handshake cancellation reaches SQL admission. | A real contending writer cannot cause late executor publication after the handshake timeout; uncontended execution and external cancellation retain their contracts. |

Run `npm test` for the full isolated suite. Focused maintenance coverage is in
`bookkeeping-cold-maintenance.test.ts`, `bookkeeping-migration.test.ts`,
`bookkeeping-export.test.ts`, `bookkeeping-runtime.test.ts` and
`bookkeeping-handshake-cancellation.test.ts`. The installed-package smoke is
`scripts/e2e-session-bookkeeping-packaged.mjs`; see [E2E](../../E2E.md#packaged-sqlite-bookkeeping-gate).

Record results against the exact final package, runtime and platform. Local
SQLite/process fixtures do not establish Linux kernel behavior or live model
traffic. A passing handshake cancellation check does not imply that the entire
durable finish phase is bounded by the handshake timeout.

Recovery commands and refusal boundaries are documented in
[configuration](../configuration.md#session-bookkeeping-maintenance) and CLI help.
Never repair an intent by unlinking public guards/barriers, editing recorded
inode numbers or treating an unobservable process as dead.
