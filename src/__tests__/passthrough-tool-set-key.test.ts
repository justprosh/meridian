import { describe, expect, it } from "bun:test"
import { computeToolSetKey, describeToolSetDelta } from "../proxy/passthroughTools"

describe("computeToolSetKey", () => {
  it("is stable across input ordering", () => {
    const a = computeToolSetKey([
      { name: "write", input_schema: { type: "object" } },
      { name: "read", input_schema: { type: "object" } },
      { name: "bash", input_schema: { type: "object" } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { type: "object" } },
      { name: "bash", input_schema: { type: "object" } },
      { name: "write", input_schema: { type: "object" } },
    ])
    expect(a).toBe(b)
  })

  it("is stable across property ordering in input_schema", () => {
    const a = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { properties: { path: { type: "string" } }, type: "object" } },
    ])
    expect(a).toBe(b)
  })

  it("changes when a tool's input schema changes", () => {
    const a = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ])
    const b = computeToolSetKey([
      { name: "read", input_schema: { type: "object", properties: { path: { type: "number" } } } },
    ])
    expect(a).not.toBe(b)
  })

  it("currently ignores description-only changes", () => {
    const first = [{ name: "read", description: "Read a file", input_schema: { type: "object" } }]
    const second = [{ name: "read", description: "Read a file from disk", input_schema: { type: "object" } }]
    const a = computeToolSetKey(first)
    const b = computeToolSetKey(second)
    // Characterization: descriptions are intentionally outside the current key.
    // A production follow-up must decide whether that should invalidate the MCP cache.
    expect(a).toBe(b)
  })

  it("changes when a tool is added", () => {
    const a = computeToolSetKey([{ name: "read" }])
    const b = computeToolSetKey([{ name: "read" }, { name: "write" }])
    expect(a).not.toBe(b)
  })

  it("changes when defer_loading flips", () => {
    const a = computeToolSetKey([{ name: "read", defer_loading: false }])
    const b = computeToolSetKey([{ name: "read", defer_loading: true }])
    expect(a).not.toBe(b)
  })

  it("treats missing schema as null consistently", () => {
    const a = computeToolSetKey([{ name: "read" }])
    const b = computeToolSetKey([{ name: "read", input_schema: null as any }])
    expect(a).toBe(b)
  })
})

describe("describeToolSetDelta", () => {
  it("names the tools a client added mid-conversation", () => {
    const line = describeToolSetDelta(["bash", "read"], ["bash", "grep", "read", "write"])
    expect(line).toBe("count=2->4 added=[grep,write]")
  })

  it("names the tools a client dropped", () => {
    const line = describeToolSetDelta(["bash", "grep", "read"], ["bash", "read"])
    expect(line).toBe("count=3->2 removed=[grep]")
  })

  it("reports both directions when a set is swapped wholesale", () => {
    // The shape a subagent used to produce under its parent's session key.
    const line = describeToolSetDelta(["a", "b"], ["c", "d"])
    expect(line).toContain("added=[c,d]")
    expect(line).toContain("removed=[a,b]")
  })

  it("calls an identical name list a schema-only change", () => {
    // The key already differed or this would not be logged at all, so silence
    // here would read as "nothing changed" — the one reading that is wrong.
    expect(describeToolSetDelta(["read"], ["read"])).toBe("count=1->1 schema-only")
  })

  it("counts the tail instead of printing an unbounded list", () => {
    const after = Array.from({ length: 20 }, (_, i) => `tool_${String(i).padStart(2, "0")}`)
    const line = describeToolSetDelta([], after)
    expect(line).toContain("count=0->20")
    expect(line).toContain("tool_11,+8]")
    expect(line).not.toContain("tool_12")
  })
})
