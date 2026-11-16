/**
 * Unit tests for redeeming a ChatGPT seat's banked rate-limit reset.
 *
 * The redemption is the Codex integration's one sanctioned mutation, so the
 * tests pin the whole boundary around it: the exact request (fixed consume
 * URL, the usage read's identity, a body of exactly `credit_id` and
 * `redeem_request_id`), the outcome mapping from the vendor's words onto the
 * route's, the failure classes of the Claude path (a dispatched attempt whose
 * outcome is unknown is `indeterminate`, never reported as success or
 * failure), the refusal to send anything with an unusable token, and the
 * single-flight/request-ID ledger that replays a dispatched request ID
 * instead of re-sending it.
 *
 * Every token here is synthetic; the fetch is always injected.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { fetchCodexAccountUsage, type CodexCredentials } from "../proxy/codex/usage"
import {
  CODEX_RESET_CREDIT_ID_PATTERN,
  redeemCodexResetCredit,
  redeemCodexResetCreditOnce,
  resetCodexResetLedger,
  type CodexResetOutcomeResult,
} from "../proxy/codex/resetCredit"
import { getCodexUsage, invalidateCodexUsageForSeat, resetCodexUsageCache } from "../proxy/codex/service"
import type { CodexPoolAccount } from "../proxy/codex/pool"

const ACCOUNT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3"
const USER_ID = "user-ABC"
const ACCOUNT_USER_ID = `${USER_ID}__${ACCOUNT_ID}`
const CREDIT_ID = `RateLimitResetCredit_${"a1b2".repeat(8)}`
const INPUT = { creditId: CREDIT_ID, requestId: "Request-1" }

function makeToken(overrides: Record<string, unknown> = {}, expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")
  const body = Buffer.from(JSON.stringify({
    exp: expSeconds,
    "https://api.openai.com/auth": {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_account_user_id: ACCOUNT_USER_ID,
      chatgpt_user_id: USER_ID,
      chatgpt_plan_type: "pro",
      ...overrides,
    },
  })).toString("base64url")
  return `${header}.${body}.sig`
}

function credentials(overrides: Partial<CodexCredentials> = {}): CodexCredentials {
  return {
    accountId: ACCOUNT_ID,
    accountUserId: ACCOUNT_USER_ID,
    accessToken: makeToken(),
    email: "someone@example.com",
    ...overrides,
  }
}

const CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"

/** Records every request and answers the consume POST with `respond`. */
function consumeFetch(respond: (call: { url: string; init: RequestInit | undefined }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    return respond({ url, init })
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

function consume(answer: unknown): Response {
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
}

afterEach(() => {
  resetCodexResetLedger()
  resetCodexUsageCache()
})

describe("the exact redemption request", () => {
  test("posts the credit and request IDs to the fixed consume endpoint with the usage read's identity", async () => {
    const { impl, calls } = consumeFetch(() => consume({ outcome: "reset", windows_reset: ["primary_window"] }))
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })

    expect(result).toEqual({
      ok: true,
      outcome: { result: "reset", reason: null, resetsLeft: null, cleared: ["primary_window"], weeklyResetsAt: null, cooldownUntil: null },
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toBe(CONSUME_URL)
    expect(call!.init?.method).toBe("POST")
    expect(call!.init?.redirect).toBe("error")
    expect(JSON.parse(String(call!.init?.body))).toEqual({ credit_id: CREDIT_ID, redeem_request_id: "Request-1" })
    const headers = new Headers(call!.init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${credentials().accessToken}`)
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID)
    expect(headers.get("originator")).toBe("codex_cli_rs")
    expect(headers.get("openai-beta")).toBe("responses=experimental")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("user-agent")).toMatch(/^codex_cli_rs\/0\.155\.0 \(.+; .+\) unknown$/)
  })

  test("carries no ChatGPT-Account-ID header when the seat has none", async () => {
    const { impl, calls } = consumeFetch(() => consume({ result: "nothing_to_reset" }))
    await redeemCodexResetCredit(credentials({ accountId: null }), INPUT, { fetchImpl: impl })
    expect(calls[0]!.url).toBe(CONSUME_URL)
    expect(new Headers(calls[0]!.init?.headers).get("chatgpt-account-id")).toBeNull()
  })
})

describe("outcome mapping", () => {
  const cases: Array<[string, CodexResetOutcomeResult]> = [
    ["reset", "reset"],
    ["already_redeemed", "already_used"],
    ["nothing_to_reset", "not_limited"],
    ["no_credit", "unavailable"],
  ]

  for (const field of ["outcome", "result"]) {
    for (const [vendor, route] of cases) {
      test(`maps ${field}: ${vendor} to ${route}`, async () => {
        const { impl } = consumeFetch(() => consume({ [field]: vendor }))
        const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
        expect(result).toEqual({
          ok: true,
          outcome: { result: route, reason: null, resetsLeft: null, cleared: [], weeklyResetsAt: null, cooldownUntil: null },
        })
      })
    }
  }

  test("windows_reset keeps only strings, and its absence is an empty cleared list", async () => {
    const { impl } = consumeFetch(() => consume({ outcome: "reset", windows_reset: ["primary_window", 42, null, "secondary_window"] }))
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
    expect(result.ok && result.outcome.cleared).toEqual(["primary_window", "secondary_window"])
    const bare = await redeemCodexResetCredit(credentials(), { ...INPUT, requestId: "Request-2" }, {
      fetchImpl: consumeFetch(() => consume({ outcome: "reset", windows_reset: "primary_window" })).impl,
    })
    expect(bare.ok && bare.outcome.cleared).toEqual([])
  })
})

describe("failure classes", () => {
  test("a missing or expired token prevents every network call", async () => {
    for (const creds of [credentials({ accessToken: null }), credentials({ accessToken: makeToken({}, Math.floor(Date.now() / 1000) - 60) })]) {
      let calls = 0
      const result = await redeemCodexResetCredit(creds, INPUT, {
        fetchImpl: consumeFetch(() => { calls++; return consume({ outcome: "reset" }) }).impl,
      })
      expect(result).toMatchObject({ ok: false, status: 503, code: "no_token", indeterminate: false, dispatched: false })
      expect(calls).toBe(0)
    }
  })

  test("credentials that disagree with the account are refused before dispatch", async () => {
    let calls = 0
    const result = await redeemCodexResetCredit(credentials({ accountId: "bbbbbbbb-2222-4222-8222-bbbbbbb4d5e6" }), INPUT, {
      fetchImpl: consumeFetch(() => { calls++; return consume({ outcome: "reset" }) }).impl,
    })
    expect(result).toMatchObject({ ok: false, status: 503, code: "upstream_auth", indeterminate: false, dispatched: false })
    expect(calls).toBe(0)
  })

  test("an unreadable token is refused without dispatch", async () => {
    let calls = 0
    const result = await redeemCodexResetCredit(credentials({ accessToken: "not-a-jwt" }), INPUT, {
      fetchImpl: consumeFetch(() => { calls++; return consume({ outcome: "reset" }) }).impl,
    })
    expect(result).toMatchObject({ ok: false, code: "no_token", dispatched: false })
    expect(calls).toBe(0)
  })

  test("401 and 403 are upstream_auth: dispatched, definite, not indeterminate", async () => {
    for (const status of [401, 403]) {
      const { impl, calls } = consumeFetch(() => new Response("private upstream body", { status }))
      const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
      expect(result).toMatchObject({ ok: false, status: 502, code: "upstream_auth", indeterminate: false, dispatched: true })
      expect(calls).toHaveLength(1)
      // Upstream bodies are attacker-influenced text about a credential.
      expect(JSON.stringify(result)).not.toContain("private upstream body")
    }
  })

  test("429 is rate_limited, dispatched and definite", async () => {
    const { impl } = consumeFetch(() => new Response(null, { status: 429 }))
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
    expect(result).toMatchObject({ ok: false, status: 429, code: "rate_limited", indeterminate: false, dispatched: true })
  })

  test("5xx leaves the outcome unknown", async () => {
    const { impl } = consumeFetch(() => new Response("busy", { status: 503 }))
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
    expect(result).toMatchObject({ ok: false, status: 502, code: "reset_indeterminate", indeterminate: true, dispatched: true })
  })

  test("a lost connection after send leaves the outcome unknown", async () => {
    const { impl, calls } = consumeFetch(() => { throw new DOMException("fake timeout", "TimeoutError") })
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
    expect(result).toMatchObject({ ok: false, code: "reset_indeterminate", indeterminate: true, dispatched: true })
    expect(calls).toHaveLength(1)
  })

  test("unparseable JSON and unknown outcome values are invalid but dispatched", async () => {
    for (const answer of [() => new Response("not json"), () => consume({ outcome: "future_outcome" }), () => consume({}), () => consume(null), () => consume({ result: 7 })]) {
      const { impl, calls } = consumeFetch(answer)
      const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
      expect(result).toMatchObject({ ok: false, status: 502, code: "invalid_response", indeterminate: true, dispatched: true })
      expect(calls).toHaveLength(1)
    }
  })

  test("a definite non-ok status that is none of the special classes stays upstream_error", async () => {
    const { impl } = consumeFetch(() => new Response("no", { status: 400 }))
    const result = await redeemCodexResetCredit(credentials(), INPUT, { fetchImpl: impl })
    expect(result).toMatchObject({ ok: false, status: 502, code: "upstream_error", indeterminate: false, dispatched: true })
  })
})

describe("the credit list the route's ids come from", () => {
  test("keeps id and title of available credits and skips the rest", async () => {
    const soonest = "2026-11-20T00:00:00Z"
    const later = "2026-11-25T00:00:00Z"
    const { impl } = consumeFetch((call) =>
      call.url.includes("/wham/usage")
        ? Response.json({
          user_id: USER_ID, account_id: ACCOUNT_ID, email: "someone@example.com", plan_type: "pro",
          rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1800000000 } },
          rate_limit_reset_credits: { available_count: 2 },
        })
        : consume({
          available_count: 2,
          credits: [
            { id: CREDIT_ID, reset_type: "codex_rate_limits", is_supported_by_plan: true, status: "available", granted_at: "2026-11-01T00:00:00Z", expires_at: later, title: "Full reset", description: "Resets your rate limits" },
            { id: `RateLimitResetCredit_${"f".repeat(32)}`, status: "redeemed", expires_at: soonest, title: "Full reset" },
            { id: `RateLimitResetCredit_${"e".repeat(32)}`, status: "available", expires_at: soonest },
          ],
        }))
    const result = await fetchCodexAccountUsage(credentials(), { fetchImpl: impl })
    expect(result.usage?.resetCredits?.credits).toEqual([
      { status: "available", id: `RateLimitResetCredit_${"e".repeat(32)}`, title: null, expiresAt: Date.parse(soonest) },
      { status: "available", id: CREDIT_ID, title: "Full reset", expiresAt: Date.parse(later) },
    ])
  })

  test("the pattern the route accepts matches exactly the vendor's id shape", () => {
    expect(CODEX_RESET_CREDIT_ID_PATTERN.test(CREDIT_ID)).toBe(true)
    expect(CODEX_RESET_CREDIT_ID_PATTERN.test(`RateLimitResetCredit_${"A1".repeat(16)}`)).toBe(false)
    expect(CODEX_RESET_CREDIT_ID_PATTERN.test(`RateLimitResetCredit_${"a".repeat(31)}`)).toBe(false)
    expect(CODEX_RESET_CREDIT_ID_PATTERN.test("grant_1")).toBe(false)
  })
})

describe("a dispatched attempt refreshes the seat's cached usage", () => {
  function poolAccount(accessToken: string): CodexPoolAccount {
    return {
      accountId: ACCOUNT_ID, accountUserId: ACCOUNT_USER_ID, organizationId: null,
      email: "someone@example.com", accountLabel: null, planType: null, accessToken, expiresAt: null, enabled: true,
    }
  }

  function usageAnswer(): Response {
    return consume({
      user_id: USER_ID, account_id: ACCOUNT_ID, email: "someone@example.com", plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1800000000 } },
      rate_limit_reset_credits: { available_count: 1 },
    })
  }

  test("the next usage read after a dispatched redemption re-fetches, and a refused one does not", async () => {
    let usageReads = 0
    const reads = consumeFetch((call) => {
      if (call.url.includes("/wham/usage")) {
        usageReads++
        return usageAnswer()
      }
      if (call.url.includes("rate-limit-reset-credits")) return consume({ available_count: 1, credits: [] })
      return consume({ outcome: "reset" })
    })
    const pool = { path: "synthetic", accounts: [poolAccount(makeToken())] }
    const deps = { loadPool: () => ({ pool, error: null }), settings: {} }
    await getCodexUsage({ ...deps, fetchImpl: reads.impl })
    expect(usageReads).toBe(1)

    await redeemCodexResetCredit(credentials(), INPUT, {
      fetchImpl: consumeFetch(() => consume({ outcome: "reset" })).impl,
    })
    await getCodexUsage({ ...deps, fetchImpl: reads.impl })
    expect(usageReads).toBe(2)

    // A refusal before dispatch changed nothing upstream; the cache stands.
    await redeemCodexResetCredit(credentials({ accessToken: null }), INPUT, {
      fetchImpl: consumeFetch(() => consume({ outcome: "reset" })).impl,
    })
    await getCodexUsage({ ...deps, fetchImpl: reads.impl })
    expect(usageReads).toBe(2)

    // The direct invalidation drops only this seat's entries.
    invalidateCodexUsageForSeat(ACCOUNT_USER_ID)
    await getCodexUsage({ ...deps, fetchImpl: reads.impl })
    expect(usageReads).toBe(3)
  })
})

describe("single-flight and request-ID replay", () => {
  test("a repeated request ID with the same credit replays the settled outcome without an upstream call", async () => {
    const { impl, calls } = consumeFetch(() => consume({ outcome: "reset", windows_reset: ["primary_window"] }))
    const first = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    if (first.kind !== "settled") throw new Error("Expected a settled first redemption")
    expect(first.replayed).toBe(false)
    const again = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    expect(again).toEqual({ kind: "settled", replayed: true, result: first.result })
    expect(calls).toHaveLength(1)
  })

  test("a repeated request ID with a different credit is a conflict and sends nothing", async () => {
    const { impl, calls } = consumeFetch(() => consume({ outcome: "nothing_to_reset" }))
    await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    const conflict = await redeemCodexResetCreditOnce("seat-a", { ...INPUT, creditId: `RateLimitResetCredit_${"b".repeat(32)}` }, credentials(), { fetchImpl: impl })
    expect(conflict).toEqual({ kind: "request_id_conflict" })
    expect(calls).toHaveLength(1)
  })

  test("a second redemption while one is in flight sends nothing, per profile", async () => {
    const release = Promise.withResolvers<Response>()
    const posted = Promise.withResolvers<void>()
    let holds = 0
    const { impl, calls } = consumeFetch(() => {
      posted.resolve()
      // Only the first seat's redemption is held in flight.
      return holds++ === 0 ? release.promise : consume({ outcome: "nothing_to_reset" })
    })
    const first = redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    await posted.promise
    expect(await redeemCodexResetCreditOnce("seat-a", { ...INPUT, requestId: "Request-2" }, credentials(), { fetchImpl: impl })).toEqual({ kind: "in_progress" })
    // Another seat's redemption is not blocked.
    expect(await redeemCodexResetCreditOnce("seat-b", INPUT, credentials(), { fetchImpl: impl })).toMatchObject({ kind: "settled", replayed: false })
    release.resolve(consume({ outcome: "reset" }))
    expect(await first).toMatchObject({ kind: "settled", replayed: false, result: { ok: true } })
    expect(calls).toHaveLength(2)
  })

  test("indeterminate outcomes are remembered so a blind retry does not re-send", async () => {
    const { impl, calls } = consumeFetch(() => { throw new Error("Synthetic connection loss") })
    const first = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    expect(first).toMatchObject({ kind: "settled", replayed: false, result: { ok: false, indeterminate: true, dispatched: true } })
    const retry = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    expect(retry).toMatchObject({ kind: "settled", replayed: true, result: { ok: false, indeterminate: true } })
    expect(calls).toHaveLength(1)
  })

  test("failures before the mutation is sent are not remembered", async () => {
    const { impl, calls } = consumeFetch(() => consume({ outcome: "reset" }))
    const refused = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials({ accessToken: makeToken({}, Math.floor(Date.now() / 1000) - 60) }), { fetchImpl: impl })
    expect(refused).toMatchObject({ kind: "settled", replayed: false, result: { code: "no_token", dispatched: false } })
    const retry = await redeemCodexResetCreditOnce("seat-a", INPUT, credentials(), { fetchImpl: impl })
    expect(retry).toMatchObject({ kind: "settled", replayed: false, result: { ok: true } })
    expect(calls).toHaveLength(1)
  })
})
