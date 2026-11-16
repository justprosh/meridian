/**
 * Redeeming a ChatGPT seat's banked rate-limit reset.
 *
 * NOTE: agent-specific, like the usage read beside it. The endpoint is
 * undocumented and known from the Codex CLI's own strings (0.155):
 * `POST /backend-api/wham/rate-limit-reset-credits/consume` with a JSON body
 * `{credit_id, redeem_request_id}`, answering an outcome among `reset`,
 * `nothing_to_reset`, `no_credit` and `already_redeemed`. The field carrying
 * the outcome has not been observed on the wire, so both `outcome` and
 * `result` are accepted; `windows_reset`, when present, names the windows the
 * reset cleared.
 *
 * The usage module's rules hold here unchanged: the request identity is
 * exactly `usage.ts`'s (`codexRequestHeaders`), the origin is fixed — an
 * operator-supplied host would be a way to aim a bearer token at an arbitrary
 * host — and a ChatGPT token is NEVER refreshed, because refresh tokens are
 * single-use. An expired or mismatched credential is refused before anything
 * is sent: a redemption against the wrong account is not a failure but a
 * misfire, and there is no retry that could make it right.
 *
 * Failure classes mirror the Claude reset path (`../oauthUsage`), whose
 * result shape this module reproduces structurally rather than importing:
 * Codex must not depend on the Claude-specific usage module. A dispatched
 * attempt whose outcome cannot be determined is reported `indeterminate`, and
 * the caller replays request IDs through `redeemCodexResetCreditOnce` instead
 * of retrying. Every dispatched attempt drops the seat's cached usage, so the
 * next read is fresh rather than serving the pre-reset windows.
 */

import type { CodexCredentials } from "./usage"
import { codexRequestHeaders, usableToken } from "./usage"
import { invalidateCodexUsageForSeat } from "./service"
import { createResetGate, type ResetAttempt } from "../resetLedger"

/** Fixed by construction, as in `usage.ts`: a configurable host would aim the bearer token elsewhere. */
const CHATGPT_ORIGIN = "https://chatgpt.com"
const CONSUME_URL = `${CHATGPT_ORIGIN}/backend-api/wham/rate-limit-reset-credits/consume`
const DEFAULT_TIMEOUT_MS = 10_000

/** The shape of a redeemable credit id, as the credit list states it. */
export const CODEX_RESET_CREDIT_ID_PATTERN = /^CodexRateLimitResetCredit_[0-9a-f]{32}$/

export interface CodexResetInput {
  /** The credit to redeem: a `CODEX_RESET_CREDIT_ID_PATTERN` match. */
  creditId: string
  /** This attempt's id; the caller replays it instead of retrying. */
  requestId: string
}

export interface CodexResetOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: number
}

/** Why a redemption produced no outcome. The route's vocabulary is Claude's. */
export type CodexResetFailureCode =
  | "no_token"
  | "upstream_auth"
  | "rate_limited"
  | "upstream_error"
  | "invalid_response"
  | "reset_indeterminate"

export type CodexResetOutcomeResult = "reset" | "already_used" | "not_limited" | "unavailable"

export type CodexResetResult =
  | {
    ok: false
    status: 429 | 502 | 503
    code: CodexResetFailureCode
    message: string
    indeterminate: boolean
    /** The mutation POST was handed to fetch; its outcome is then tied to the request ID. */
    dispatched: boolean
  }
  | {
    ok: true
    outcome: {
      result: CodexResetOutcomeResult
      reason: string | null
      resetsLeft: number | null
      cleared: string[]
      weeklyResetsAt: number | null
      cooldownUntil: number | null
    }
  }

/** The vendor's outcome word, mapped onto the route's result vocabulary. */
const VENDOR_OUTCOMES: Record<string, CodexResetOutcomeResult> = {
  reset: "reset",
  already_redeemed: "already_used",
  nothing_to_reset: "not_limited",
  no_credit: "unavailable",
}

interface ConsumeOutcome {
  result: CodexResetOutcomeResult
  cleared: string[]
}

/**
 * The outcome of a consume answer: the first of `outcome`/`result` that names
 * a known value, and the string entries of `windows_reset` (everything else
 * is dropped — metadata must not turn into window names).
 */
function parseOutcome(body: unknown): ConsumeOutcome | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  let result: CodexResetOutcomeResult | null = null
  for (const field of ["outcome", "result"]) {
    const value = record[field]
    if (typeof value === "string" && value in VENDOR_OUTCOMES) {
      result = VENDOR_OUTCOMES[value]!
      break
    }
  }
  if (result === null) return null
  const windows = record.windows_reset
  return {
    result,
    cleared: Array.isArray(windows) ? windows.filter((entry): entry is string => typeof entry === "string") : [],
  }
}

function failure(
  status: Extract<CodexResetResult, { ok: false }>["status"],
  code: CodexResetFailureCode,
  message: string,
  indeterminate: boolean,
  dispatched: boolean,
): CodexResetResult {
  return { ok: false, status, code, message, indeterminate, dispatched }
}

export async function redeemCodexResetCredit(
  credentials: CodexCredentials,
  input: CodexResetInput,
  options: CodexResetOptions = {},
): Promise<CodexResetResult> {
  const doFetch = options.fetchImpl ?? fetch
  const usable = usableToken(credentials, options.now ?? Date.now())
  if ("error" in usable) {
    if (usable.error === "identity_mismatch") {
      return failure(503, "upstream_auth", "The seat's credentials do not match its account; nothing was sent", false, false)
    }
    return failure(503, "no_token", `The seat's access token cannot be used (${usable.error}); nothing was sent`, false, false)
  }

  // Everything past this point has been dispatched; whatever comes back, the
  // seat's cached usage is stale and the next read must re-fetch.
  const afterDispatch = (result: CodexResetResult): CodexResetResult => {
    if (credentials.accountUserId) invalidateCodexUsageForSeat(credentials.accountUserId)
    return result
  }

  let response: Response
  try {
    response = await doFetch(CONSUME_URL, {
      method: "POST",
      headers: { ...codexRequestHeaders(usable.token, credentials.accountId), "Content-Type": "application/json" },
      // A bearer credential must never be replayed to a redirect target.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: JSON.stringify({ credit_id: input.creditId, redeem_request_id: input.requestId }),
    })
  } catch {
    return afterDispatch(failure(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true, true))
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return afterDispatch(failure(502, "upstream_auth", "Upstream rejected the seat's access token", false, true))
    }
    if (response.status === 429) {
      return afterDispatch(failure(429, "rate_limited", "Upstream rate limited the request", false, true))
    }
    if (response.status >= 500) {
      return afterDispatch(failure(502, "reset_indeterminate", "Reset outcome is unknown; do not automatically retry", true, true))
    }
    return afterDispatch(failure(502, "upstream_error", "Upstream request failed", false, true))
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return afterDispatch(failure(502, "invalid_response", "Reset response was invalid; outcome is unknown", true, true))
  }
  const outcome = parseOutcome(body)
  if (!outcome) {
    return afterDispatch(failure(502, "invalid_response", "Reset response was invalid; outcome is unknown", true, true))
  }
  return afterDispatch({
    ok: true,
    outcome: {
      result: outcome.result,
      reason: null,
      resetsLeft: null,
      cleared: outcome.cleared,
      weeklyResetsAt: null,
      cooldownUntil: null,
    },
  })
}

const resetGate = createResetGate<CodexResetResult>()

/** What one redemption attempt produced, as the route answers it. */
export type CodexResetAttempt = ResetAttempt<CodexResetResult>

/** Test-only / shutdown helper — forgets every remembered outcome. */
export function resetCodexResetLedger(): void {
  resetGate.clear()
}

/**
 * The route's entry point, with the same single-flight and request-ID replay
 * semantics as the Claude path: at most one redemption per profile at a time,
 * and a dispatched request ID replays its remembered outcome instead of
 * reaching chatgpt.com again.
 */
export async function redeemCodexResetCreditOnce(
  profileId: string,
  input: CodexResetInput,
  credentials: CodexCredentials,
  options: CodexResetOptions = {},
): Promise<CodexResetAttempt> {
  return resetGate.once(
    profileId,
    { requestId: input.requestId, grantId: input.creditId },
    () => redeemCodexResetCredit(credentials, input, options),
  )
}
