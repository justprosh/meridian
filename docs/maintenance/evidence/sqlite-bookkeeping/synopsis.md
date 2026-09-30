# Session bookkeeping evidence

Coverage: 12/12; COMPLETE
PR acceptance: NOT_ESTABLISHED


- Requires both backends, full matrix >=3 repeats, 10-minute matched soaks and Linux/ext4 FULL evidence
- Semantic/fault suites are independent gates; this workload does not prove all ABA/deletion schedules
- Queue/critical-section/BEGIN/COMMIT metrics require explicit production test seams, currently unavailable

## Matrix

|Point|Status|turns|p95/p99 overhead ms|turn/s|GC due before/after|history bytes before/after|
|---|---|---:|---:|---:|---:|---:|
|json-N2000-M2500-K5-burst-gc0-r0|OK|5|1971.01/1971.01|1.22|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-burst-gc1-r0|OK|5|2054.02/2054.02|1.18|1000/992|35286250/35276650|
|json-N2000-M2500-K5-steady-gc0-r0|OK|5|2055.39/2055.39|1.19|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-steady-gc1-r0|OK|5|2055.98/2055.98|1.19|1000/992|35286250/35276650|
|json-N2000-M2500-K5-burst-gc0-r1|OK|5|1915.22/1915.22|1.23|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-burst-gc1-r1|OK|5|2058.04/2058.04|1.19|1000/992|35286250/35276650|
|json-N2000-M2500-K5-steady-gc0-r1|OK|5|2549.29/2549.29|1.05|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-steady-gc1-r1|OK|5|2248.11/2248.11|1.14|1000/992|35286250/35276650|
|json-N2000-M2500-K5-burst-gc0-r2|OK|5|2079.89/2079.89|1.17|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-burst-gc1-r2|OK|5|2865.35/2865.35|0.99|1000/992|35286250/35276650|
|json-N2000-M2500-K5-steady-gc0-r2|OK|5|1946.77/1946.77|1.22|1000/1000|35286250/35276650|
|json-N2000-M2500-K5-steady-gc1-r2|OK|5|2034.88/2034.88|1.20|1000/992|35286250/35276650|

## Soak (K=20, matched GC)

|Point|Status|turns|p95/p99 overhead ms|turn/s|GC due before/after|history bytes before/after|
|---|---|---:|---:|---:|---:|---:|

Full artifacts contain histogram + armed timer lag, row counts, sizes/WAL and RSS timeline.
Null metrics are unavailable, not zero. No speedup or semantic-suite acceptance is inferred from a smoke run.
Archive the artifact directory with SHA256SUMS.json and record an immutable URL + retention before PR acceptance.
