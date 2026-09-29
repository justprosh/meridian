import { afterEach, beforeEach, expect, it } from "bun:test"
import Database from "libsql"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  initializeSessionBookkeeping,
  withBookkeepingRead,
  withBookkeepingWrite,
  withBookkeepingWriteAsync,
  BookkeepingMaintenanceRequiredError,
  BookkeepingCommitUncertainError,
} from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { assertSupportedFilesystem } from "../proxy/session/bookkeeping/connection"
import { allocateResource, compareAndSwapResourceState } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { insertMapping, readMapping, validateMappingPins } from "../proxy/session/bookkeeping/mappings"
import { openForMaintenance } from "../proxy/session/bookkeeping/maintenance"
import type {
  CanonicalTranscriptLocator,
  TranscriptLocator,
  BookkeepingTransaction,
} from "../proxy/session/bookkeeping/types"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"

type AssertFalse<T extends false> = T
type RawLocatorRejected = AssertFalse<TranscriptLocator extends CanonicalTranscriptLocator ? true : false>
type MappingLocator = NonNullable<Parameters<typeof insertMapping>[2]["currentTranscript"]>
type RawMappingRejected = AssertFalse<TranscriptLocator extends MappingLocator ? true : false>

let directory: string, handle: BookkeepingHandle
let locator: CanonicalTranscriptLocator
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-review-"))
  handle = initializeSessionBookkeeping(directory)
  locator = canonicalizeLocator({ configDir: directory, sessionId: "c" })
})
afterEach(() => {
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
const fields = { state: "live" as const, createdAt: 1, updatedAt: 1, attempts: 0 }
const write = <T>(callback: (tx: BookkeepingTransaction) => T) =>
  withBookkeepingWrite(directory, { scope: "store" }, callback)

it("runtime allocator fences deletion/recreation without accepting caller-supplied generations", () => {
  const first = write((tx) => allocateResource(tx, locator, fields))
  write((tx) => tx.run("DELETE FROM resources WHERE key=?", first.key))
  const second = write((tx) => allocateResource(tx, locator, fields))
  expect(first.generation).not.toBe(second.generation)
  expect(write((tx) => compareAndSwapResourceState(tx, first.key, first.generation, 1, "retired", 2))).toBe(
    false,
  )
  const injected = { ...fields, generation: first.generation, rowVersion: 1 }
  expect(() => write((tx) => allocateResource(tx, locator, injected))).toThrow("cannot accept")
})

it("canonical symlink pin is the resource key and legacy payload mismatch fails startup", () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  const canonical = canonicalizeLocator({ configDir: alias, sessionId: "c" })
  const resource = write((tx) => allocateResource(tx, locator, fields))
  write((tx) =>
    insertMapping(tx, "key", {
      claudeSessionId: "c",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      currentTranscript: canonical,
    }),
  )
  expect(handle.reader.get("SELECT resource_key FROM mapping_pins")?.resource_key).toBe(resource.key)
  expect(resourceKey(canonical)).toBe(resource.key)
  validateMappingPins(handle.reader)
  write((tx) => {
    tx.run("UPDATE mappings SET current_locator_json=NULL")
    tx.run("DELETE FROM mapping_pins")
  })
  expect(withBookkeepingRead(directory, (reader) => readMapping(reader, "key"))?.currentTranscript).toEqual(
    canonical,
  )
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("metadata/payload mismatch")
})

for (const scope of ["write", "read"] as const) {
  it(`poisons on failed ${scope} rollback and preserves both errors`, () => {
    handle.close()
    let fail = true
    handle = initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "ROLLBACK" && fail) {
          fail = false
          throw new Error("rollback fault")
        }
        db.exec(sql)
      },
    })
    let caught: unknown
    const callback = () => {
      throw new Error("original callback fault")
    }
    try {
      if (scope === "write") write(callback)
      else withBookkeepingRead(directory, callback)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map(String)).toEqual([
      "Error: original callback fault",
      "Error: rollback fault",
    ])
    expect(write((tx) => tx.run("INSERT INTO fence_slots VALUES('store','next',1)"))).toBe(1)
  })
}

it("runtime rejects PREPARED and legacy names while maintenance opens only its expected phase", () => {
  handle.close()
  const db = new Database(handle.path)
  db.exec("UPDATE schema_meta SET phase='PREPARED'")
  db.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow(BookkeepingMaintenanceRequiredError)
  writeFileSync(join(directory, "sessions.json"), "{}")
  handle = openForMaintenance(directory, { expectPhase: "PREPARED" })
  expect(handle.reader.get("SELECT phase FROM schema_meta")?.phase).toBe("PREPARED")
})

it("startup checks the real canonical pin key, not just matching corrupted raw aliases", () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  write((tx) =>
    insertMapping(tx, "key", {
      claudeSessionId: "c",
      generationId: "g",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      currentTranscript: locator,
    }),
  )
  const raw = { sessionId: "c", configDir: alias }
  write((tx) => {
    tx.run("UPDATE mappings SET current_locator_json=?", JSON.stringify(raw))
    tx.run("UPDATE mapping_pins SET resource_key=?", resourceKey(raw))
  })
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("pin projection mismatch")
})

it("reader capability cannot perform writes or transaction-control and seam replacement is explicit error", () => {
  expect(() => initializeSessionBookkeeping(directory, { executeTransaction() {} })).toThrow("already open")
  write(() => {
    expect(() => handle.reader.get("SELECT 1")).toThrow("transaction reader")
    withBookkeepingRead(directory, (reader) => {
      expect("run" in reader).toBe(false)
      expect("afterCommit" in reader).toBe(false)
    })
  })
  for (const sql of [
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT a",
    "RELEASE a",
    "ATTACH 'x' AS a",
    "DETACH a",
    "PRAGMA user_version=2",
    "VACUUM",
  ]) {
    expect(() => write((tx) => tx.run(sql))).toThrow("transaction-control")
  }
})

it("filesystem allowlist rejects unverified transports and directory modes are not silently repaired", () => {
  const previous = process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
  delete process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
  try {
    for (const type of [0x65735546, 0x01021997, 0x6969]) {
      expect(() => assertSupportedFilesystem(type, "linux")).toThrow("unsupported")
    }
    for (const type of [0xef53, 0x58465342, 0x9123683e, 0x01021994]) {
      expect(() => assertSupportedFilesystem(type, "linux")).not.toThrow()
    }
    process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS = "1"
    expect(() => assertSupportedFilesystem(0x65735546, "linux")).not.toThrow()
  } finally {
    if (previous === undefined) delete process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
    else process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS = previous
  }
  handle.close()
  chmodSync(directory, 0o755)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("already be private")
  chmodSync(directory, 0o700)
})

for (const code of ["SQLITE_NOMEM", "SQLITE_CORRUPT", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "OTHER"]) {
  it(`treats COMMIT ${code} as unknown, but recovery does not scan all data`, async () => {
    handle.close()
    let fail = true
    handle = initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "COMMIT" && fail) {
          fail = false
          db.exec("COMMIT")
          throw Object.assign(new Error(code), { code })
        }
        db.exec(sql)
      },
    })
    await expect(
      withBookkeepingWriteAsync(directory, {}, (tx) => {
        tx.run("UPDATE bookkeeping_counts SET value=9 WHERE kind='mappings'")
      }),
    ).rejects.toBeInstanceOf(BookkeepingCommitUncertainError)
    // Deliberately damaged counts: fast recovery validates format, not the full data set.
    expect(write(() => 42)).toBe(42)
    handle.close()
    expect(() => initializeSessionBookkeeping(directory)).toThrow("counters")
  })
}

it("two simultaneous initializers publish a complete schema and remove dead bootstrap temporary files", async () => {
  handle.close()
  for (const name of readdirSync(directory)) rmSync(join(directory, name), { recursive: true, force: true })
  const build = await buildNodeFixture("bookkeeping-bootstrap.ts", "bootstrap.mjs", directory)
  expect(build.success).toBe(true)
  const script = join(directory, "bootstrap.mjs")
  const children = [0, 1].map(() =>
    spawn("node", [script, directory], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  )
  const exited = children.map(
    (child) =>
      new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve)
        child.once("error", reject)
      }),
  )
  const ready = children.map((child, index) => Promise.race([
    new Promise<void>((resolve) => child.once("message", () => resolve())),
    exited[index]!.then(code => { throw new Error(`initializer exited before ready: ${code}`) }),
  ]))
  const timer = setTimeout(() => children.forEach((child) => child.kill("SIGTERM")), 10000)
  try {
    await Promise.all(ready)
    children.forEach((child) => child.send("start"))
    expect(await Promise.all(exited)).toEqual([0, 0])
  } finally {
    clearTimeout(timer)
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.allSettled(exited)
  }
  const orphan = spawnSync("node", [
    "--input-type=module",
    "-e",
    `
    import{writeFileSync,linkSync}from'node:fs';
    writeFileSync(process.argv[1]+'/session-bookkeeping.sqlite.tmp-'+process.pid+'-abcd','');
    linkSync(process.argv[1]+'/session-bookkeeping.sqlite',
      process.argv[1]+'/session-bookkeeping.sqlite.tmp-'+process.pid+'-dcba');
  `,
    directory,
  ])
  expect(orphan.status).toBe(0)
  handle = initializeSessionBookkeeping(directory)
  expect(readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false)
  expect(handle.reader.get("PRAGMA user_version")?.user_version).toBe(1)
}, 15000)

it("a holder exits and releases its transaction when its IPC parent disconnects", async () => {
  const build = await buildNodeFixture("bookkeeping-contention.ts", "holder.mjs", directory)
  expect(build.success).toBe(true)
  const child = spawn("node", [join(directory, "holder.mjs"), directory, "holder"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let stderr = ""
  child.stderr?.on("data", chunk => { stderr += String(chunk) })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve); child.once("error", reject)
  })
  const timer = setTimeout(() => child.kill("SIGTERM"), 4000)
  try {
    await Promise.race([
      new Promise<void>(resolve => child.once("message", () => resolve())),
      exited.then(() => { throw new Error(`holder exited before lock: ${stderr}`) }),
    ])
    child.disconnect()
    expect(await exited).toBe(0)
    expect(stderr).toBe("")
    expect(write(() => "admitted")).toBe("admitted")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGTERM")
    await exited.catch(() => undefined)
  }
})
