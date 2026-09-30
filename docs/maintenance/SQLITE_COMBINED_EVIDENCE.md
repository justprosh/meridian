# SQLite + SSE + GC integration evidence

Source integration (no release/version changes):

- GC full deletion budget / bounded handshake: `6706409` → `1b17ac9`.
- SSE quota failover / heartbeat: `1a2f6f8` → `89474a1`.
- SQL-aware settlements / uncertainty barrier: `6ac54c8`.

The SSE relay awaits durable release/block before terminal frames and before
outer completion. Publication, rollback, eviction and finalization keep their
SQL admission/await boundaries. Unknown publication COMMIT retains the turn
fence and fork and latches the no-replay exposure barrier, including when only
heartbeats were delivered. Unexpected relay bookkeeping failures use the typed
overload classification rather than generic API errors.

## Startup owner regression

The cold verifier's public two-start counterexample was an unreleased production
integration bug, not an accepted baseline exception. `connection.close()` used to
reject releasing any owner while a transaction/admission was active. Releasing
a nonfinal reference now leaves SQLite, locks and the maintenance guard intact;
the final owner still refuses close until all work joins.

`bookkeeping-runtime.test.ts` reproduced the old refusal, then verifies nonfinal
release and final-owner refusal during admission. The packaged smoke starts two
public `startProxyServer` instances in one Node process for both isolated HOME
default addressing and an explicit session directory. It asserts the first
instance's HTTP health before and after closing the second. Separate processes,
restart, export/rollback and shared maintenance exclusion remain covered too.

## Local observations (macOS arm64, Node 22.23.1)

All following commands exited 0 after the combined startup fix:

- `npm run typecheck`; `npm run build`.
- Focused runtime, HTTP COMMIT faults (stream/nonstream), admission audit,
  lifecycle differential, GC budgets and SSE parser/relay: 60 pass, 0 fail,
  598 assertions. The differential now expects full deletion budget on BOTH
  backends, not the former artificial JSON/SQL divergence.
- Independently installed fresh tarball →
  `scripts/e2e-session-bookkeeping-packaged.mjs`: PASS, including the two-start
  default/explicit regression.
- Independently installed fresh tarball →
  `scripts/e2e-sse-quota-failover-heartbeat.mjs` with
  `E2E_SSE_WORKING_FIXTURE=1`, model selectors `claude-fable-5-1` and
  `claude-opus-4-6`: PASS for each selector in both default JSON and explicitly
  selected SQLite. Each asserts headers/keepalive before the delayed refusal,
  one healthy answer, stream/nonstream telemetry and no premature terminal.

The integrated priority-routing suite separately passed 82 tests / 412 assertions
after async SSE settlement integration. It includes meaningful-content/tool
exposure, cancellation before response/publication and after publication/terminal,
and exact durable attempt release. These are mocked behavior tests, not real
credential/model evidence.

**Ceiling:** local fixture SSE proof does not establish real Fable/Opus calls or
Linux behavior. Parent-owned final combined-package Linux real-profile evidence,
cold review and final full-suite result remain acceptance gates. Separate SSE
subassembly evidence does not automatically certify this combined artifact.
Raw development logs are in `.evidence/portion-5/combined-*` and
`.evidence/portion-5/packaged-combined.log`; durable executable falsifiers are the
repository tests and packaged scripts above.
