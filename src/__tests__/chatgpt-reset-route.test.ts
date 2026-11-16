/**
 * The quota-reset route end to end, with chatgpt.com and api.anthropic.com
 * mocked: a ChatGPT seat's credit id reaches the Codex consume endpoint with
 * exactly `{credit_id, redeem_request_id}`, a Claude profile's grant id still
 * goes the Claude way, and neither shape can reach the other provider.
 *
 * Modeled on chatgpt-gateway.test.ts's environment: a follow-external pool
 * file for the ChatGPT seat, and a file-backed Claude credential directory —
 * platform overridden to linux and the store redirected into this test's own
 * directory (modelsMock's `createOwnedCredentialStore`, as
 * priority-routing-integration.test.ts does) so no test touches the host's
 * Keychain or `~/.claude`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { createOwnedCredentialStore } from "./modelsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "chatgpt-reset-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

const CREDIT_ID = `CodexRateLimitResetCredit_${"a1b2".repeat(8)}`
const ACCOUNT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3"
const SEAT = `user-ABC__${ACCOUNT_ID}`
const CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const RESET_URL = "https://api.anthropic.com/api/organizations/00000000-0000-4000-8000-000000000001/reset_rate_limits"

interface RecordedCall { url: string; method: string; authorization: string | null; body: unknown }
let consumeCalls: RecordedCall[] = []
let claudeResetCalls: RecordedCall[] = []
let consumeAnswer: () => Response = () => Response.json({ outcome: "reset", windows_reset: ["5h"] })

const realFetch = globalThis.fetch

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const call = (): RecordedCall => ({
    url, method: init?.method ?? "GET",
    authorization: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null,
  })
  if (url === CONSUME_URL) {
    consumeCalls.push(call())
    return Promise.resolve(consumeAnswer())
  }
  if (url === "https://api.anthropic.com/api/oauth/profile") {
    return Promise.resolve(Response.json({ organization: { uuid: "00000000-0000-4000-8000-000000000001" } }))
  }
  if (url === "https://platform.claude.com/v1/oauth/token") {
    // Nothing in these tests may refresh a Claude token; the seeded one is fresh.
    return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }))
  }
  if (url === RESET_URL) {
    claudeResetCalls.push(call())
    return Promise.resolve(Response.json({ result: "reset", cleared: ["five_hour"] }))
  }
  // The model catalog reads chatgpt.com hourly off the request path; answer
  // it and anything else on that host without dispatching further.
  if (url.startsWith("https://chatgpt.com/")) return Promise.resolve(new Response("{}", { status: 503 }))
  return Promise.reject(new Error(`unexpected network call in test: ${url}`))
}

function seatToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")
  const body = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_account_user_id: SEAT,
      chatgpt_user_id: "user-ABC",
      chatgpt_plan_type: "pro",
    },
  })).toString("base64url")
  return `${header}.${body}.sig`
}

let dir: string
let claudeDir: string
let storeOverride: { mockRestore(): void } | undefined
const priorConfigDir = process.env.MERIDIAN_CONFIG_DIR
const savedKey = process.env.MERIDIAN_API_KEY

interface TestApp {
  fetch(input: Request): Response | Promise<Response>
}

async function createApp(): Promise<TestApp> {
  const { createProxyServer } = await import("../proxy/server")
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [{ id: "work", claudeConfigDir: claudeDir }],
    defaultProfile: "work",
    silent: true,
  })
  return app
}

async function chatGptProfileId(app: TestApp): Promise<string> {
  const list = await app.fetch(new Request("http://localhost/profiles/list"))
  expect(list.status).toBe(200)
  const body = await list.json() as { profiles: Array<{ id: string; type: string }> }
  const seat = body.profiles.find(profile => profile.type === "chatgpt")
  expect(seat).toBeDefined()
  return seat!.id
}

function resetRequest(profile: string, grantId: string, requestId = "Request-1"): Request {
  return new Request("http://localhost/v1/usage/quota/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, grantId, requestId }),
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-reset-route-"))
  claudeDir = join(dir, "claude-profile")
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fake-claude-token", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000 },
  }))
  process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
  delete process.env.MERIDIAN_API_KEY
  process.env.MERIDIAN_CHATGPT_CREDENTIALS = "follow-external"
  process.env.MERIDIAN_CODEX_POOL_PATH = join(dir, "oc-codex-multi-auth-accounts.json")
  writeFileSync(process.env.MERIDIAN_CODEX_POOL_PATH, JSON.stringify({
    version: 3,
    activeIndex: 0,
    accounts: [{
      accountId: ACCOUNT_ID, accountUserId: SEAT, email: "seat@example.test", refreshToken: "synthetic-refresh",
      accessToken: seatToken(), expiresAt: Date.now() + 3_600_000, addedAt: 1, lastUsed: 1,
    }],
  }))
  consumeCalls = []
  claudeResetCalls = []
  consumeAnswer = () => Response.json({ outcome: "reset", windows_reset: ["5h"] })
  globalThis.fetch = mockFetch as typeof fetch
  const tokens = await import("../proxy/tokenRefresh")
  // The SDK mock's token module serves an empty store to everything; these
  // tests own their credential files instead, within this test's directory.
  tokens.setCredentialStorePlatformForTests("linux")
  tokens.stopBackgroundRefresh()
  tokens.resetInflightRefresh()
  storeOverride = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options =>
    createOwnedCredentialStore(dir, options?.claudeConfigDir ?? join(dir, "store-default")))
  const { resetOAuthUsageCache } = await import("../proxy/oauthUsage")
  const { resetCodexResetLedger } = await import("../proxy/codex/resetCredit")
  const { resetCodexUsageCache } = await import("../proxy/codex/service")
  const { saveSettings } = await import("../settings")
  resetOAuthUsageCache()
  resetCodexResetLedger()
  resetCodexUsageCache()
  saveSettings({ integrations: undefined })
})

afterEach(async () => {
  globalThis.fetch = realFetch
  storeOverride?.mockRestore()
  storeOverride = undefined
  const tokens = await import("../proxy/tokenRefresh")
  tokens.setCredentialStorePlatformForTests(null)
  tokens.stopBackgroundRefresh()
  if (savedKey !== undefined) process.env.MERIDIAN_API_KEY = savedKey
  else delete process.env.MERIDIAN_API_KEY
  delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  delete process.env.MERIDIAN_CODEX_POOL_PATH
  if (priorConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
  else process.env.MERIDIAN_CONFIG_DIR = priorConfigDir
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe("POST /v1/usage/quota/reset — ChatGPT seats", () => {
  it("sends a seat's credit id to the consume endpoint with exactly credit_id and redeem_request_id", async () => {
    const app = await createApp()
    const profileId = await chatGptProfileId(app)

    const res = await app.fetch(resetRequest(profileId, CREDIT_ID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      profile: profileId, grantId: CREDIT_ID, requestId: "Request-1",
      result: "reset", reason: null, resetsLeft: null, cleared: ["5h"], weeklyResetsAt: null, cooldownUntil: null,
      replayed: false,
    })
    expect(consumeCalls).toHaveLength(1)
    expect(consumeCalls[0]).toMatchObject({
      url: CONSUME_URL,
      method: "POST",
      body: { credit_id: CREDIT_ID, redeem_request_id: "Request-1" },
    })
    expect(consumeCalls[0]!.authorization).toMatch(/^Bearer ey/)
    // The grant never touched Anthropic.
    expect(claudeResetCalls).toHaveLength(0)
  })

  it("replays a dispatched request id without a second consume call", async () => {
    const app = await createApp()
    const profileId = await chatGptProfileId(app)
    const first = await app.fetch(resetRequest(profileId, CREDIT_ID))
    expect(first.status).toBe(200)
    const second = await app.fetch(resetRequest(profileId, CREDIT_ID))
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ result: "reset", replayed: true })
    expect(consumeCalls).toHaveLength(1)
  })

  it("refuses a credit id for an unknown profile, and for a Claude profile", async () => {
    const app = await createApp()
    const unknown = await app.fetch(resetRequest("nobody", CREDIT_ID))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: "profile_not_found" })
    const claude = await app.fetch(resetRequest("work", CREDIT_ID))
    expect(claude.status).toBe(400)
    expect(await claude.json()).toMatchObject({ code: "not_oauth" })
    expect(consumeCalls).toHaveLength(0)
    expect(claudeResetCalls).toHaveLength(0)
  })
})

describe("POST /v1/usage/quota/reset — Claude profiles keep the Claude path", () => {
  it("sends a Claude grant id to Anthropic's reset endpoint, never to chatgpt.com", async () => {
    const app = await createApp()
    const res = await app.fetch(resetRequest("work", "fake-grant"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      profile: "work", grantId: "fake-grant", requestId: "Request-1",
      result: "reset", cleared: ["five_hour"], replayed: false,
    })
    expect(claudeResetCalls).toHaveLength(1)
    expect(claudeResetCalls[0]).toMatchObject({
      url: RESET_URL,
      method: "POST",
      authorization: "Bearer fake-claude-token",
      body: { program: "cedar_ember", grant_id: "fake-grant", request_id: "Request-1" },
    })
    expect(consumeCalls).toHaveLength(0)
  })

  it("refuses a ChatGPT seat addressed with a Claude-format grant id", async () => {
    const app = await createApp()
    const profileId = await chatGptProfileId(app)
    const res = await app.fetch(resetRequest(profileId, "fake-grant"))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "not_oauth" })
    expect(claudeResetCalls).toHaveLength(0)
    expect(consumeCalls).toHaveLength(0)
  })
})
