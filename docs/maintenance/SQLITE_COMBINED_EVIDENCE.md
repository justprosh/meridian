# SQLite, SSE and GC integration checks

## Contracts

- SSE dispatch settles durable priority claims before terminal frames and outer
  completion. An uncertain publication COMMIT retains the turn fence and fork,
  preventing replay even if the client has received only keepalives.
- Releasing a nonfinal runtime owner leaves SQLite and the maintenance guard
  intact. The final owner cannot close during a transaction or admission.
- A claimed deletion retains its full execution and handshake budgets; the
  sweep deadline only prevents the next claim.

## Reproducible checks

`bookkeeping-runtime.test.ts`, `bookkeeping-server.test.ts`,
`priority-routing-integration.test.ts`, `session-lifecycle-gc-budgets.test.ts`
and `sse-failure-sniff.test.ts` cover these contracts. Run the full suite with
`npm test`; targeted runs alone are not the full gate.

For independently installed package checks, see the [packaged bookkeeping
gate](../../E2E.md#packaged-sqlite-bookkeeping-gate) and [delayed SSE
refusal](../../E2E.md#delayed-refusal-after-an-sse-heartbeat).

Record results for the exact candidate package and baseline, including runtime,
platform, artifact digests and exit codes. Fixture-only SSE runs do not establish
live subscription or client behavior. Results for a separate SSE package do not
certify a combined SQLite/SSE package. Cross-platform acceptance and comparative
performance require their own measurements; this document claims neither.
