# SQLite benchmark adapter — provisional local observations

Graph: r161 #200, #202, #206, #213. This is a harness handoff, not full performance acceptance.

|Observation|Outcome|Limit|
|---|---|---|
|Node22 harness command `node scripts/bench-bookkeeping.test.mjs`|14 passed locally; prior 13-test revision also passed on Linux|Author-run, cold verdict still required|
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

The machine verdict remains NOT_ESTABLISHED. It checks paired full-turn and overhead
p95 ratios, small-point tails and GC service separately, without lowering thresholds
after observing results. Raw artifacts stay private; synopsis removes raw errors,
GC error text, resource error keys and sampling timelines.
