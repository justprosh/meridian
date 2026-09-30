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

# Paired evidence run: requires candidate production activation (no test seams).
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
public-export closure of each root into a fresh immutable JS artifact, using Bun's
canonical Node-target/splitting/external flags and isolated copies of dependencies.
It does **not** import live TS in timed workers or borrow changing node_modules.
Each build records exact git SHA, dirty flag, source and emitted-JS SHA256, lockfile
SHA256, package/SDK/compiler versions. This is a built internal-API benchmark,
**not** the separate npm-tarball/package-install acceptance test. Emitted modules
and their hashes are recorded as well as the source closure. The external SDK
version must match between the independently pinned baseline and candidate.

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
has no WAL; SQLite reads back WAL/FULL pragmas and records file sizes plus a final
PASSIVE checkpoint. No ten-minute soak or full matrix is inferred from tests.

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

SQLite uses the real offline `migrateBookkeeping(...,{writersStopped:true})` on
the same synthetic legacy fixture, outside timing. Its one atomic import preserves
fences/history/store metadata (including the actual NUL meta key) through the
canonical codec. Production L/S/cache exports must then access that SQLite. No
backend test setter is called. A still-legacy facade encounters permanent barriers
and fails; JSON authority appearing after migration also fails. Read-only SQL
inspection uses `withBookkeepingRead` and the implementation's `readResource`.

Native BEGIN/COMMIT and critical-section metrics are observed through the existing
initialization `executeTransaction` option, forwarding `native.exec(sql)` exactly
once. Counts cover successful write transactions only. Admission wait and busy
attempts remain **null** until a production observer exists: no AST rewriting,
alternate SQL implementation or guessed counts. This observation gap blocks full
acceptance. Pragmas are read back and checked before timing.

GC service/intake ratio includes final drain in the deletion measurement (a favorable
bound) and uses an explicitly reported 20% margin. It is synthetic-only: a passed
stub cannot establish real SDK deletion throughput or release #213. A failed soak
ratio falsifies even the faster simulated deletion path and must be reported.

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

## Isolated Linux runner and private archive

Do not SSH or start work on a provisioning host until its owner explicitly says
ready. The runner has no remote commands and never accesses the old live VPS:

```sh
bash scripts/bench-bookkeeping-linux.sh /path/baseline BASELINE_SHA \
  /path/candidate CANDIDATE_SHA /path/private-evidence
node scripts/bench-bookkeeping-archive.mjs /path/private-evidence/run-...
```

Node22, ext4, exact clean source revisions and an exclusive measurement-directory
lock are required. The parent must also serialize this window against full tests;
the local directory lock cannot detect unrelated host load. Archives include
synthetic result files, emitted modules, build/lock manifests and hashes, but no
node_modules or production install tarball. No upload is performed. Archive URL
and retention remain null pending an explicit durable storage decision; do not
claim durable evidence merely because a local tar.gz exists.

`bench-sqlite-alternative.mjs` remains exploratory only; no production-like claim
depends on it. Its JSON GC timing is now honestly named whole-pass timing,
not the removed monkeypatched private claim critical section.
