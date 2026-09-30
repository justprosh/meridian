# Session bookkeeping: reproducible PR evidence

Node **22** only. No network, tokens, real SDK inference, production directories or
transcript contents. Run performance commands **sequentially**; do not compare two
concurrently running backends. This harness is not a production backend switch.

```sh
export PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH"
# Only when node_modules is absent:
npm ci --ignore-scripts
node scripts/bench-bookkeeping.test.mjs

# Small restricted matrix: 12 points (two modes × GC off/on × three repeats).
node scripts/bench-session-bookkeeping.mjs --backend json --package-root . \
  --matrix N=2000,M=2500,K=5 --rounds 1 \
  --synopsis docs/maintenance/evidence/sqlite-bookkeeping

# Future paired acceptance run; currently SQLite deliberately refuses (see below).
node scripts/bench-session-bookkeeping.mjs --backend json --package-root /path/to/baseline \
  --compare-root /path/to/feature --soak-minutes 10 \
  --synopsis docs/maintenance/evidence/sqlite-bookkeeping

# Assert interruption rather than counting a truncated matrix as success:
node scripts/bench-session-bookkeeping.mjs --backend json --package-root . \
  --matrix N=2000,M=2500,K=5 --rounds 1 --repeats 1 --interrupt-after-ms 1
# Expected exit 1. matrix.md names EVERY INCOMPLETE point; tests assert this exit.
```

`--backend sqlite --package-root /path/to/feature` selects SQLite alone;
`--compare-root` adds the opposite backend. Roots are source package checkouts with
their own installed dependencies. The driver separately compiles the transitive
public-export closure of each root into a fresh immutable JS artifact, using that
root's TypeScript and node_modules. It does **not** import live TS in timed workers.
Each build records exact git SHA, dirty flag, source and emitted-JS SHA256, lockfile
SHA256, package/SDK/compiler versions. This is a built internal-API benchmark,
**not** the separate npm-tarball/package-install acceptance test.

The loader only resolves extensionless imports/erases types for the exploratory
microbenchmark; it never patches source functions. Timing private functions via
AST rewriting has been removed. Production code is unchanged.

## What a complete run means

The default matrix is the required paired sizes **N/M = 6400/2500 and 12000/5000**,
plus the small control **2000/2500**; K=5/10/20/40, D=2000 ms, burst and closed-loop
(`steady`), GC off and on. It is not the old exploratory Cartesian N×M matrix.
All combinations of these dimensions are generated and machine-checked: 144
points per backend, **288 paired points** with three repeats. Burst defaults to
one turn per conversation; closed-loop to three sequential turns per conversation.
The backend order reverses each repetition: JSON/SQLite, SQLite/JSON, JSON/SQLite.

`--matrix N=...,M=...,K=...` restricts sizes/concurrency, not GC/modes/repetitions.
`--rounds N` overrides turns; `--repeats N` defaults to 3. Values below 3 are useful
only for harness debugging and cannot establish PR acceptance. Finishing a
restricted matrix does not mean the full PR matrix passed.

With `--soak-minutes 10`, add K=20/N=6400/M=2500 **GC off and matched GC on** for each
backend and repetition: 12 additional paired points. Soak uses closed-loop turns
until the wall duration expires, then joins in-flight turns and drains GC. It is
reported in a separate section with throughput, p95/p99, due backlog endpoints,
timestamped GC deferred counts, RSS/filesize timeline, and runtime metrics. JSON
has no WAL; SQLite WAL/checkpoint metrics remain blocked with the adapter.
No ten-minute soak or full matrix was executed in this hardening work.

The driver has no silent global time-budget cutoff. `--point-timeout-ms` defaults
to soak duration + 300000 ms. SIGINT/SIGTERM, timeout, missing worker output,
nonzero worker exit, duplicate/unexpected result, failed assertion, failed GC,
or attempted/completed mismatch produces **exit 1** and named `INCOMPLETE` rows.
All planned points are persisted before workers start. Each run has a fresh
directory: old successes cannot fill a missing point. Exit 0 proves only that
the **requested** matrix completed its harness assertions; acceptance is a
separate, explicit `NOT_ESTABLISHED` verdict while external gates remain open.

## Workload and matched fixture

The per-turn path is resumed, non-streaming, managed-fork, non-priority. Both
backends must execute this same orchestration, with real lifecycle/store/cache
exports and harmless gated Node children. Baseline anchors at `022d37a`:

|Step|server.ts|Public calls|
|---|---|---|
|Mapping/generation|2518–2530|adapter lookup, getStoredSessionGeneration|
|Source attachment|3084–3100|attachPinnedTranscript → attachSharedTranscriptLocator|
|Journal/reserve|3105–3106|registerLiveTranscript, prepareForkForPublication|
|Writer journal|930–932|ensureTranscriptJournaled twice|
|Lease/physical executor|933–947|acquireActiveTranscriptLease, createSdkProcessGate → attachActiveTranscriptExecutor|
|Synthetic model|950–951|Node child with D=2000ms timer|
|Join/release|953–966|closeAndJoin, releaseJoinedTranscriptLease|
|Commit fork|1671–1676; 4687|commitFork|
|Publication|4692–4722|publishPinnedTranscript → storeSession|
|Pins|768–783|adapter pins plus active source/target pins|

Each active conversation has a distinct source, and sequential turns. Not
modeled: priority, rollback, streaming, cancellation, inference semaphore,
network, multiprocess contention or the outer per-conversation coordinator.
This workload does not replace the semantic/fault suites.

Both GC-off/on seed **exactly the same state mix**: min(1000, floor(N/2)) retired,
the rest live, no prepared. Mappings reference only live resources. Synthetic
UUIDs are deterministic by index; timestamps are relative to each seed, canonical
paths/generation keys necessarily belong to that run's private directory.
History mixture: 55% ~6KB, 30% ~12KB, 10% ~40KB, 5% ~80KB total mapping payload.
Capacity headroom is identical: maxOwned/maxPending=100000; store limit=20000.

GC starts at workload admission and every 10s, coalescing outstanding passes.
The deletion stub takes 2s and succeeds; at most 8 deletes/pass with 30s budget.
There is no deliberate failure injection in the performance matrix. A failed
deletion invalidates the point. The 8-delete bound leaves headroom beneath the
pass deadline; the old 16×2s exceeded a 30s pass even before bookkeeping overhead.
An explicitly retained handle surrounds workload and drain, because collector
join timers intentionally unref themselves. A child-process test proves a sole
unref timer actually drains; GC steady is also covered by the small matrix.

Seeding, artifact build, initial validation, before/after inspection, and cleanup
are outside per-turn timing. Throughput excludes final GC drain; loop/timeline
include it (labelled in JSON). RSS/file sizes are sampled every second without
injecting full-document reads into the hot path. Due-age/count is inspected before
and after; GC returns timestamped deferred counts after each pass. No open-arrival
service-rate/overload guarantee is inferred from closed-loop soak.

## Adapter contract / portion-2 handoff

`bench-bookkeeping-adapter.mjs` is the sole storage inspection boundary:

|Member|Contract|
|---|---|
|L, S, storeSession, createSdkProcessGate|Public production exports from the chosen artifact|
|seed(N,M)|Equivalent synthetic fixture; completed before timing|
|lookup(key), entries(), pins()|Public mapping/pin projections; no SQLite JSON-file fallback|
|inspect()|resource/mapping row counts, history byte distribution, states/errors, GC due count/age|
|sizes()|Stat-only storage/WAL/SHM bytes; no opening a live SQLite file|
|metrics()|Observed BEGIN/COMMIT, queue wait, critical-section time, busy attempts, checkpoint, pragmas|
|assert(expected)|Every expected mapping still exists and references the expected nondeleted generation|
|close()|Release handle/registry reference after joins|

JSON is implemented through current public store APIs and an adapter-owned
read-only sidecar projection (legacy lifecycle has no public resource inspector).
Workload/tests never parse its files directly. Inspection preserves all mapping
keys, compares final published IDs and lifecycle generations, refuses deleting/
deleted current resources, checks mapping count/history bytes, and proves resource
row growth by at least the successful turn count. Assertions cover observed
schedule, **not** arbitrary ABA or crash/deletion interleavings.

SQLite intentionally fails early with a named interface gap, never benchmarks
the still-JSON facade under a SQLite label. Current engine exports are checked:

- `database`: initializeSessionBookkeeping / Async, withBookkeepingWriteAsync,
  withBookkeepingRead (and closeSessionBookkeeping for the eventual handle).
- `resourceImport`: importResource(tx, resource).
- `mappings`: readSessionTranscriptPins(reader).
- Current `insertMapping(tx,key,entry)` is explicitly a fixture insertion that
  increments slots, **not** a fence-preserving legacy importer. Do not substitute
  it silently for the remaining migration contract.

Required continuation after portions 2–5:
1. Supply a checked fixture/import API accepting the in-memory seed
   (`seed(...,{persist:false})`). Canonicalize locators outside the transaction.
2. Initialize the registry before serving and import resource/lease/fence,
   mapping/history/pin/priority state in **one** withBookkeepingWriteAsync
   transaction, outside the measured window. No N per-row commits, no temporary
   JSON authority, no bypass of migrated-directory barriers.
3. Bind activated lifecycle/store/cache exports to that same directory/handle.
   Provide entries/lookup/pins and aggregate inspector via withBookkeepingRead;
   never read SQLite as JSON or materialize its backing file.
4. Supply explicit production test seams for actual transaction counts/admission
   timings and busy attempts; observer callbacks must not change transaction
   boundaries. Read back WAL/FULL/foreign_keys/busy_timeout=0/wal_autocheckpoint=0
   pragmas; report PASSIVE frames separately from physical WAL bytes.
5. Replace the deliberate refusal with this adapter; exercise equivalence,
   counts/history, and negatives before any performance claim.

Private transaction/queue metrics are currently **null**, not invented zeroes
or inferred “10 lifecycle/2 store writes”. This missing observation blocks full
§8 acceptance. Neither a null nor a microbenchmark estimate is PR evidence.

## Metrics and PR gates

- Per-turn overhead is wall latency minus configured D, including child startup
  and scheduling. Actual SDK-stub duration is reported separately.
- p50/p95/**p99**/max use nearest-lower order statistics. Small samples are not
  confidence intervals; compare all three paired repetitions.
- Event-loop histogram and independently **armed timer lag** are separate fields.
  The timer is armed before the first operation; a unit test blocks synchronously
  for 80ms before yielding and requires the lag probe to see the stall.
- Before/after histories and row counts, attempted/completed/failed, GC outcomes,
  observed semantic assertions, throughput and RSS/sizes are retained.

Required acceptance (not waived by a green smoke):
1. Complete paired matrix, >=3 alternating repeats; each backend's 10-minute
   K20 soak both off/on. No unexpected lock/capacity/GC errors with headroom.
2. **>=2× lower p95 overhead at production K20/K40**, including both large sizes;
   material throughput improvement. No p99/max tail regression on the small
   control. Do not lower the threshold after measuring without explicit review.
3. Zero lost mappings, ABA and unsafe deletion: harness observations **and** the
   independent semantic, physical multiprocess and crash/fault suites.
4. GC due backlog bounded for arrival below measured service rate; deliberately
   excessive arrival must be explicit overload, not silent loss/unbounded RSS.
   This closed-loop harness alone cannot establish that open-arrival claim.
5. Record actual transaction counts/critical/admission metrics; FULL, not NORMAL.
   Additional Linux hub-disk **ext4/FULL** point needs separate server permission.
   Mac/APFS does not satisfy it. No server was accessed here.
6. Final packaged E2E, migration/export/rollback and platform-specific safety
   gates remain separate. No general SQLite speedup claim follows from micro SQL.

## Evidence and privacy

`--artifacts DIR` defaults to `.evidence/bench-harden/runs`, always a fresh run.
Plan, hardware/FS numeric type/load/runtime/build manifest, matrix, worker JSON,
large logs and SHA256SUMS.json live there. Build-manifest hashes cover every source
and emitted module. An artifact archive must include emitted modules plus pinned
dependency restoration and publish an immutable URL/retention policy in the PR.
No environment dump, real transcript, credential or session data is collected.

`--synopsis docs/maintenance/evidence/sqlite-bookkeeping` writes **sanitized JSON
and markdown** suitable for committing. Paths/stacks/raw logs/timelines are not
copied into it. The synopsis explicitly distinguishes requested coverage from
full acceptance and carries artifact hashes with archiveUrl/retention **null**
until uploaded. `.evidence/` alone is not durable PR evidence.

`bench-sqlite-alternative.mjs` remains exploratory only; no production-like claim
depends on it. Its JSON GC timing is now honestly named whole-pass timing,
not the removed monkeypatched private claim critical section.
