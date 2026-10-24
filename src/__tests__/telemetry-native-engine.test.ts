import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildNodeFixture, unexpectedNodeSqliteStderr } from "./fixtures/bookkeeping-support"

it("uses qualified Node SQLite for telemetry and refuses unsafe engines before persistent open", async () => {
  for (const mode of ["unsafe", "unsafe-import", "unsafe-fallback", "setup-failure", "prepare-failure", "native"]) {
    const directory = mkdtempSync(join(tmpdir(), "telemetry-native-"))
    try {
      const build = await buildNodeFixture("telemetry-native-runtime.ts", "actor.mjs", directory)
      expect(build.success, String(build.logs)).toBe(true)
      const actor = spawnSync("node", [join(directory, "actor.mjs"), mode, directory], { encoding: "utf8", timeout: 10000 })
      expect(actor.status, actor.stdout + actor.stderr).toBe(0)
      const stderr = unexpectedNodeSqliteStderr(actor.stderr)
      if (mode === "unsafe-fallback") expect(stderr).toMatch(/^\[telemetry\].*falling back to in-memory telemetry: .*WAL-reset fix.*\n$/)
      else expect(stderr).toBe("")
      const report = JSON.parse(actor.stdout)
      if (mode.startsWith("unsafe")) expect(report).toEqual({ refused: true, files: [] })
      else if (mode.endsWith("failure")) expect(report.closed).toBe(true)
      else {
        expect(report.namedBinding).toBe(true)
        expect(report.readonly).toBe(true)
        expect(report.engine.sourceId.length).toBeGreaterThan(64)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
