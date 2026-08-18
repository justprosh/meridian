/**
 * Tests for the OpenCode plugin's agent-mode header (plugin/meridian.ts).
 *
 * OpenCode >= 1.17 passes `agent` to the chat.headers hook as the agent
 * NAME (a string); older versions passed the full `{ name, mode }` object.
 * The plugin must classify subagents correctly in both shapes — a string
 * agent silently mapped to "primary" sends subagent traffic out at the
 * primary 1M tier, burning rate-limit budget and (field-observed) tripping
 * Anthropic's extra-usage metering on fresh subagent sessions.
 */
import { describe, it, expect } from "bun:test"
import MeridianPlugin from "../../plugin/meridian"

type Hooks = Awaited<ReturnType<typeof MeridianPlugin>>

async function instance(cfgAgents?: Record<string, { mode?: string }>): Promise<Hooks> {
  const hooks = await MeridianPlugin({})
  if (cfgAgents) await hooks.config?.({ agent: cfgAgents })
  return hooks
}

async function headersFor(
  hooks: Hooks,
  agent: unknown,
  providerID = "anthropic",
): Promise<Record<string, string>> {
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      sessionID: "ses_test",
      agent: agent as any,
      model: { providerID },
      message: { id: "msg_test" },
    },
    output,
  )
  return output.headers
}

describe("plugin/meridian.ts agent-mode header", () => {
  it("legacy object agent: reads mode directly", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, { name: "explore", mode: "subagent" })
    expect(h["x-opencode-agent-mode"]).toBe("subagent")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("string agent: built-in subagents resolve to subagent", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "explore"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: built-in primaries resolve to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "build"))["x-opencode-agent-mode"]).toBe("primary")
    expect((await headersFor(hooks, "plan"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: user-defined subagent from config resolves to subagent", async () => {
    const hooks = await instance({ "code-reviewer": { mode: "subagent" } })
    expect((await headersFor(hooks, "code-reviewer"))["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("string agent: config override of a built-in wins", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("string agent: unknown names fall back to primary", async () => {
    const hooks = await instance()
    expect((await headersFor(hooks, "mystery-agent"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it('mode "all" is normalized to primary', async () => {
    const hooks = await instance({ flexible: { mode: "all" } })
    expect((await headersFor(hooks, "flexible"))["x-opencode-agent-mode"]).toBe("primary")
    const legacy = await headersFor(hooks, { name: "flexible", mode: "all" })
    expect(legacy["x-opencode-agent-mode"]).toBe("primary")
  })

  it("session and request headers are always set for anthropic requests", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "explore")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-opencode-request"]).toBe("msg_test")
  })

  it("non-anthropic providers get no headers", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "title", "openrouter")
    expect(Object.keys(h)).toHaveLength(0)
  })

  it("agent names are sanitized to printable ASCII", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "expl\u200bore\u2728")
    expect(h["x-opencode-agent-name"]).toBe("explore")
  })

  it("config hook state is per plugin instance", async () => {
    const a = await instance({ shared: { mode: "subagent" } })
    const b = await instance()
    expect((await headersFor(a, "shared"))["x-opencode-agent-mode"]).toBe("subagent")
    expect((await headersFor(b, "shared"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire drops agents removed from config", async () => {
    const hooks = await instance({ temp: { mode: "subagent" } })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("subagent")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "temp"))["x-opencode-agent-mode"]).toBe("primary")
  })

  it("config hook re-fire restores built-in mode when an override is removed", async () => {
    const hooks = await instance({ general: { mode: "primary" } })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("primary")
    await hooks.config?.({ agent: {} })
    expect((await headersFor(hooks, "general"))["x-opencode-agent-mode"]).toBe("subagent")
  })
})

/**
 * title/summary run in the PARENT session and fire in parallel with the user's
 * real turn, so sending the session id makes them race it for the per-session
 * turn lease — the loser gets 400 session_turn_conflict. They must go out
 * without the session header AND with x-meridian-source, which is what keeps
 * the proxy's fingerprint fallback from gluing them back onto the session.
 */
describe("plugin/meridian.ts parent-session one-shots", () => {
  it("title is detached from the session and declares a parallel stream", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "title")
    expect(h["x-opencode-session"]).toBeUndefined()
    expect(h["x-meridian-source"]).toBe("subagent-title")
    expect(h["x-opencode-request"]).toBe("msg_test")
    expect(h["x-opencode-agent-name"]).toBe("title")
    expect(h["x-opencode-agent-mode"]).toBe("subagent")
  })

  it("summary is detached from the session and declares a parallel stream", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "summary")
    expect(h["x-opencode-session"]).toBeUndefined()
    expect(h["x-meridian-source"]).toBe("subagent-summary")
  })

  it("legacy object agent shape is detached too", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, { name: "title", mode: "subagent" })
    expect(h["x-opencode-session"]).toBeUndefined()
    expect(h["x-meridian-source"]).toBe("subagent-title")
  })

  it("primary agents keep the session header and get no source header", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "build")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-meridian-source"]).toBeUndefined()
  })

  it("compaction keeps the session header — the proxy needs it for lineage", async () => {
    const hooks = await instance()
    const h = await headersFor(hooks, "compaction")
    expect(h["x-opencode-session"]).toBe("ses_test")
    expect(h["x-meridian-source"]).toBeUndefined()
  })

  it("subagent-mode agents with their own session id keep the session header", async () => {
    const hooks = await instance()
    for (const agent of ["general", "explore"]) {
      const h = await headersFor(hooks, agent)
      expect(h["x-opencode-session"]).toBe("ses_test")
      expect(h["x-meridian-source"]).toBeUndefined()
    }
  })
})
