import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"

let directory: string
beforeAll(() => {
  const build = spawnSync("npm", ["run", "build"], { encoding: "utf8", timeout: 180000 })
  expect(build.status, build.stdout + build.stderr).toBe(0)
}, 190000)
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-cli-")))
  writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
  writeFileSync(join(directory, "session-gc.json"), '{"version":1,"resources":{}}', { mode: 0o600 })
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
function cli(command: string, flags: string[] = [], crash?: string) {
  return spawnSync("node", ["dist/session-bookkeeping.js", command, "--session-dir", directory, "--json", ...flags],
    { encoding: "utf8", timeout: 15000, env: { ...process.env,
      ...(crash ? { MERIDIAN_BOOKKEEPING_TEST_CRASH: crash } : {}) } })
}
function success(command: string, flags: string[] = []) {
  const result = cli(command, flags)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
it("packaged CLI completes legacy → ready → exported → ready with stable inspection", () => {
  const names = readdirSync(directory).sort()
  expect(success("inspect").phase).toBe("legacy")
  expect(readdirSync(directory).sort()).toEqual(names)
  expect(cli("migrate").status).toBe(2)
  expect(cli("export-json").status).toBe(3)
  expect(cli("abort-migration").status).toBe(3)
  expect(readdirSync(directory).sort()).toEqual(names)
  const first = success("migrate", ["--writers-stopped"])
  expect(first.phase).toBe("ready")
  expect(cli("abort-migration").status).toBe(4)
  expect(first.timings.phases.length).toBeGreaterThan(2)
  expect(success("migrate", ["--writers-stopped"]).migration_id).toBe(first.migration_id)
  expect(success("inspect").phase).toBe("ready")
  expect(success("export-json").phase).toBe("exported")
  expect(success("export-json").phase).toBe("exported")
  const second = success("migrate", ["--writers-stopped"])
  expect(second.migration_id).not.toBe(first.migration_id)
  expect(second.archived_cycles).toBe(1)
  expect(second.cycle_number).toBe(2)
})
it("read-only inspect coexists with an actual live runtime guard", () => {
  success("migrate", ["--writers-stopped"])
  const guardName = "session-bookkeeping-maintenance.sqlite"
  const guardBefore = readFileSync(join(directory, guardName)).toString("base64")
  const handle = initializeSessionBookkeeping(directory)
  try {
    const files = readdirSync(directory).sort()
    const before = { [guardName]: guardBefore, ...Object.fromEntries(files
      .filter((name) => !name.endsWith("-shm") && name !== guardName)
      .map((name) => [name, readFileSync(join(directory, name)).toString("base64")])) }
    expect(success("inspect").phase).toBe("ready")
    expect(readdirSync(directory).sort()).toEqual(files)
    // Do not open/close the guard inode in the holder process: POSIX would drop its record locks.
    expect(cli("export-json").status).toBe(4)
    for (const [name, value] of Object.entries(before)) {
      expect(readFileSync(join(directory, name)).toString("base64")).toBe(value)
    }
  } finally { handle.close() }
})
it("aborts a SIGKILL at BARRIERS and starts the next cycle", () => {
  const crashed = cli("migrate", ["--writers-stopped"], "BARRIERS")
  expect(crashed.signal).toBe("SIGKILL")
  expect(success("inspect").phase).toBe("barriers")
  expect(success("abort-migration").phase).toBe("aborted")
  expect(success("inspect").phase).toBe("aborted")
  expect(success("migrate", ["--writers-stopped"]).archived_cycles).toBe(1)
})
it("classifies a foreign barrier as corruption without removing it", () => {
  success("migrate", ["--writers-stopped"])
  writeFileSync(join(directory, "sessions.json.lock"), "foreign")
  expect(cli("export-json").status).toBe(5)
  expect(readFileSync(join(directory, "sessions.json.lock"), "utf8")).toBe("foreign")
})

it("reports candidate incarnation verdicts and refuses a live candidate before migration", () => {
  const incarnation = captureProcessIncarnation()!
  const path = join(directory, "sessions.json.lock.candidate-test")
  const owner = { pid: process.pid, token: "test", hostname: "test", incarnation }
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600 })
  expect(success("inspect").candidates[0].verdict).toBe("live")
  expect(cli("migrate", ["--writers-stopped"]).status).toBe(3)
  expect(readdirSync(directory).some((name) => name.endsWith(".sqlite"))).toBe(false)
  writeFileSync(path, JSON.stringify({ ...owner,
    incarnation: { ...incarnation, bootId: "00000000-0000-0000-0000-000000000001" } }))
  expect(success("inspect").candidates[0].verdict).toBe("dead-incarnation")
  expect(success("migrate", ["--writers-stopped"]).phase).toBe("ready")
  writeFileSync(path, JSON.stringify(owner))
  expect(success("migrate", ["--writers-stopped"]).phase).toBe("ready")
})
