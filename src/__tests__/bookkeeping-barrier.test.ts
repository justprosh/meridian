import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { BookkeepingBarrierReplacedError, releaseOwnBarrier } from "../proxy/session/bookkeeping/barrier"
import { barrierBytes } from "../proxy/session/bookkeeping/maintenanceJournal"

for (const dynamic of [false, true]) it(`preserves a ${dynamic ? "replaced" : "foreign"} barrier`, () => {
  const directory = mkdtempSync(join(tmpdir(), "barrier-test-"))
  const id = randomUUID()
  const path = join(directory, "sessions.json.lock")
  try {
    writeFileSync(path, dynamic ? barrierBytes(id) : "foreign")
    expect(() => releaseOwnBarrier(directory, "sessions.json", id, () => {
      renameSync(path, path + ".original")
      writeFileSync(path, "foreign")
    })).toThrow(BookkeepingBarrierReplacedError)
    expect(readFileSync(path, "utf8")).toBe("foreign")
    expect(existsSync(`${path}.releasing-${id}`)).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("resumes release from the private name", () => {
  const directory = mkdtempSync(join(tmpdir(), "barrier-test-"))
  const id = randomUUID()
  const path = join(directory, `sessions.json.lock.releasing-${id}`)
  try {
    writeFileSync(path, barrierBytes(id))
    releaseOwnBarrier(directory, "sessions.json", id)
    expect(existsSync(path)).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
