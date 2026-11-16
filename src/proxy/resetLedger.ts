/**
 * Single-flight with a request-ID ledger for quota-redemption mutations.
 *
 * A redemption spends a scarce, account-held grant, and the vendor does not
 * promise to deduplicate the mutation, so the caller owns both guards:
 *
 * - At most one redemption per scope (a profile) may be in flight; any other
 *   for that scope is answered `in_progress` without an upstream call.
 * - Once a mutation has been dispatched, its settled outcome — confirmed,
 *   rejected or uncertain — is remembered by (scope, requestId), bounded and
 *   for a bounded time. A repeat with the same requestId and grantId replays
 *   that outcome without reaching the vendor again; the same requestId with a
 *   different grantId is a conflict. A blind client retry after a lost
 *   response must not spend a second grant, which is exactly what replaying
 *   the uncertain outcomes is for. Failures before dispatch are not
 *   remembered, since nothing was sent.
 *
 * Shared by the Claude path (`oauthUsage.ts`) and the ChatGPT seat path
 * (`codex/resetCredit.ts`); the two keep separate gate instances, so one
 * provider's ledger never replays into the other's.
 *
 * The ledger lives in memory: a restart forgets it, and callers are expected
 * to re-read the vendor's inventory rather than trust a remembered outcome
 * across restarts.
 */

/**
 * What a redemption attempt produced: the settled result (fresh or replayed),
 * the reason nothing was sent, or a request ID reused for another grant.
 */
export type ResetAttempt<R> =
  | { kind: "settled"; result: R; replayed: boolean }
  | { kind: "in_progress" }
  | { kind: "request_id_conflict" }

const LEDGER_MAX_ENTRIES = 256
const LEDGER_TTL_MS = 15 * 60_000

/** The two identifiers a caller owns: which grant, and which attempt. */
export interface ResetGateIds {
  requestId: string
  grantId: string
}

/**
 * A gate whose results carry an `ok` flag; failures additionally carry
 * `dispatched`, the marker that the mutation was handed to fetch and its
 * outcome is therefore tied to the request ID.
 */
export function createResetGate<R extends { ok: boolean }>() {
  /** Redemption currently running per scope. */
  const inflightByScope = new Map<string, ResetGateIds>()
  /** Settled, dispatched outcomes keyed by scope + request ID, oldest first. */
  const ledger = new Map<string, { grantId: string; result: R; settledAt: number }>()

  function entryKey(scope: string, requestId: string): string {
    return `${scope}\u0000${requestId}`
  }

  function prune(now: number): void {
    for (const [key, entry] of ledger) {
      if (now - entry.settledAt < LEDGER_TTL_MS && ledger.size <= LEDGER_MAX_ENTRIES) break
      ledger.delete(key)
    }
  }

  async function once(scope: string, ids: ResetGateIds, run: () => Promise<R>): Promise<ResetAttempt<R>> {
    const key = entryKey(scope, ids.requestId)
    prune(Date.now())
    const settled = ledger.get(key)
    if (settled) {
      return settled.grantId === ids.grantId
        ? { kind: "settled", result: settled.result, replayed: true }
        : { kind: "request_id_conflict" }
    }
    const running = inflightByScope.get(scope)
    if (running) {
      return running.requestId === ids.requestId && running.grantId !== ids.grantId
        ? { kind: "request_id_conflict" }
        : { kind: "in_progress" }
    }
    inflightByScope.set(scope, { requestId: ids.requestId, grantId: ids.grantId })
    try {
      const result = await run()
      // Successes are remembered; of the failures, exactly those after the
      // mutation was sent — an uncertain one may already have taken effect,
      // and a definite one answers a request ID the vendor has seen.
      const dispatched = (result as { dispatched?: boolean }).dispatched === true
      if (result.ok || dispatched) {
        ledger.set(key, { grantId: ids.grantId, result, settledAt: Date.now() })
        prune(Date.now())
      }
      return { kind: "settled", result, replayed: false }
    } finally {
      inflightByScope.delete(scope)
    }
  }

  /** Test-only / shutdown helper — forgets every remembered outcome. */
  function clear(): void {
    inflightByScope.clear()
    ledger.clear()
  }

  return { once, clear }
}
