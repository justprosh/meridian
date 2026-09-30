# SQLite benchmark adapter — provisional local observations

Graph: r161 #200, #202, #206, #213. This is a harness handoff, not full performance acceptance.

|Observation|Outcome|Limit|
|---|---|---|
|Node22 harness command `node scripts/bench-bookkeeping.test.mjs`|19 passed locally after fourth correction; first three findings cold-approved at 4e106939|Fourth-delta cold review still required|
|Linux runner shell syntax and branch diff whitespace check|exit 0|No Linux execution inferred|
|Canonical Bun-built SQL adapter on pre-activation candidate `58d45d2`|exit 1: `Production store facade is not activated`|Diagnostic dirty candidate, deliberately not accepted as SQL performance evidence|
|Paired production-sized runs and ten-minute K20 soaks|NOT_ESTABLISHED|Await exact clean production activation candidate and exclusive measurement window|
|Linux ext4/FULL point|NOT_ESTABLISHED|Provisioning host must receive explicit ready permission first|
|Real SDK deletion throughput ≥ intake with margin|NOT_ESTABLISHED|Synthetic SDK cannot release #213|
|Archive URL and retention|NOT_ESTABLISHED|Private archive tooling does not publish or make local files durable|

Additional local development-only observations on a dirty capture of `2dece9c`
plus authored activation sources: production `initializeProxyBookkeeping` succeeded,
N200/M100/K2/D10ms completed 2/2 turns, mappings stayed 100, resources grew 200→202.
WAL/FULL/busy_timeout=0/autocheckpoint=0 were observed, with 14 successful write
transactions. A real SDK0.2.141 deletion-child diagnostic deleted 8 synthetic files
through canonical gates/import/delete, committed 8 tombstones, reported no notFound
or GC failure, and kept all mapping pins. This is not a clean accepted build or
performance calibration. No SDK inference or Anthropic API call was involved.

The adapter invokes the implementation's offline migration and runtime APIs. No
SQLite backend test setter, alternate database implementation, AST instrumentation
or JSON fallback is used. Migration must preserve full mapping/history and lifecycle
fence slots before timing; production facades must access the migrated database.
WAL/FULL, foreign keys, busy_timeout=0 and disabled auto-checkpoint are read back.

Build artifacts use canonical Bun Node-target/splitting/external flags with separate
internal production API entrypoints, source/emitted hashes and isolated dependencies.
This is not the npm tarball/package-install gate. The same SDK and synthetic model
and deletion workloads are required in each sequentially paired backend run.

Native transaction observation forwards the existing executeTransaction option
once to native.exec; it does not alter rollback or uncertain COMMIT handling.
Admission wait is still unavailable and reported null; native BEGIN attempts and
BUSY/LOCKED failures are observed directly, without guessing a zero.
GC service/intake uses an explicit 20% margin and records the measurement/drain
windows. `--gc-sdk real` is available for Linux evidence with physical file/tombstone
proof, while simulated results never establish real deletion throughput.

Cold-review corrections: conservation permits observed production tombstone
pruning (257 canonical deletions leave 256 tombstones and one pruned key), while
refusing unexplained resource loss. GC-on hub.1 `022d37a` clips claimed deletion
budgets; hub.2 `47b6e51` and SQL `c08b456` preserve full claimed-child timeout.
Therefore old-baseline GC ratios are combined version comparisons, not SQL-only
gains. Manifest/synopsis policies are explicit; targeted hub.2 K20/K40 controls
remain required. Benchmark 8/10s is a stress scheduler, not production trigger
topology. The 16/60s quantity describes only the periodic trigger, never an
overall production service ceiling or acceptance gate (fourth review correction).
Timeout/interrupt passes cancellation into production gates and drains GC; a
positive IPC JOIN receipt is required. Missing receipt or any timeout stops the
matrix. Unknown executors retain fixtures/fences. Focused production-gate test
checks termination of a 60-second child after timeout using its recorded PID.
No final SQL candidate performance has been measured by this revision.

Fourth correction's canonical local probe on clean `08172801` used actual
`createProxyServer().sweepSessionGc` and real SDK0.2.141 children. Two successful
mapping-republication-boundary invocations deleted 32 files in 4.232s on the final local rerun, directly
refuting the former 16/60s overall-ceiling claim. Startup/periodic/shutdown boundary
invocations brought the total to 80 physical deletions/80 committed tombstones;
mapped files remained intact and simultaneous calls shared the same promise.
The periodic invocation waited the actual 60s default. This was manual boundary
invocation with synthetic grace=0, no HTTP/model/fork intake, not stability proof.
Production stability remains NOT_ESTABLISHED; stress measurements never upgrade it.

The machine verdict remains NOT_ESTABLISHED. It checks paired full-turn and overhead
p95 ratios, small-point tails and GC service separately, without lowering thresholds
after observing results. Raw artifacts stay private; synopsis removes raw errors,
GC error text, resource error keys and sampling timelines.
