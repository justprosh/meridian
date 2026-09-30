import { afterEach, beforeEach, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import {
  bookkeepingMode, initializeProxyBookkeeping, retainProxyBookkeeping, admitSessionStoreWrite,
} from "../proxy/session/bookkeeping/runtime"
import { initializeSessionBookkeeping, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { activeStoreBackend } from "../proxy/session/bookkeeping/storeBackend"
import { activeLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleBackend"
import { setSessionStoreDir, storeSharedSession, lookupSharedSession, readSessionTranscriptPins } from "../proxy/sessionStore"

let directory: string
const handles: BookkeepingHandle[] = []
let saved: string | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-runtime-"))
  saved = process.env.MERIDIAN_BOOKKEEPING
  process.env.MERIDIAN_BOOKKEEPING = "sqlite"
  setSessionStoreDir(directory)
})
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close()
  setSessionStoreDir(null)
  if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
  else process.env.MERIDIAN_BOOKKEEPING = saved
  rmSync(directory, { recursive: true, force: true })
})

it("requires explicit initialization for synchronous embedders and validates the mode", () => {
  expect(() => retainProxyBookkeeping()).toThrow("initializeSessionBookkeeping")
  expect(() => bookkeepingMode({ MERIDIAN_BOOKKEEPING: "typo" })).toThrow("json or sqlite")
  expect(bookkeepingMode({})).toBe("json")
})

it("installs both complete ports and retains the connection until the last owner closes", async () => {
  const initialized = await initializeProxyBookkeeping()
  if (!initialized) throw new Error("SQL startup missing")
  handles.push(initialized)
  const retained = retainProxyBookkeeping()
  if (!retained) throw new Error("SQL retention missing")
  handles.push(retained)
  expect(activeStoreBackend()).toBeDefined()
  expect(activeLifecycleBackend()).toBeDefined()
  expect(() => setSessionStoreDir(directory)).toThrow("proxies are running")
  initialized.close()
  expect(await admitSessionStoreWrite(() => storeSharedSession("key", "sdk"))).not.toBe(false)
  expect(lookupSharedSession("key")?.claudeSessionId).toBe("sdk")
  expect(readSessionTranscriptPins()).toEqual([])
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  retained.close()
  expect(activeStoreBackend()).toBeUndefined()
  expect(activeLifecycleBackend()).toBeUndefined()
  const reopened = initializeSessionBookkeeping(directory)
  handles.push(reopened)
  expect(reopened.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(1)
})

it("does not import legacy data implicitly and permits only explicit offline migration", async () => {
  process.env.MERIDIAN_BOOKKEEPING = "json"
  storeSharedSession("legacy", "sdk-legacy")
  const bytes = readFileSync(join(directory, "sessions.json"), "utf8")
  process.env.MERIDIAN_BOOKKEEPING = "sqlite"
  await expect(initializeProxyBookkeeping()).rejects.toThrow("offline migration")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(bytes)
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  await migrateBookkeeping(directory, { writersStopped: true })
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("SQL startup missing")
  handles.push(handle)
  expect(lookupSharedSession("legacy")?.claudeSessionId).toBe("sdk-legacy")
  handle.close()
  process.env.MERIDIAN_BOOKKEEPING = "json"
  expect(() => retainProxyBookkeeping()).toThrow("export-json")
})

it("refuses corrupt SQLite rather than creating JSON or a fresh database", async () => {
  writeFileSync(join(directory, "session-bookkeeping.sqlite"), "not sqlite", { mode: 0o600 })
  await expect(initializeProxyBookkeeping()).rejects.toThrow()
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  expect(readFileSync(join(directory, "session-bookkeeping.sqlite"), "utf8")).toBe("not sqlite")
})

it("pays a large limit reduction in bounded pre-listen pages without hydrating a full store", async () => {
  const sessions = Object.fromEntries(Array.from({ length: 270 }, (_, index) => [`key-${index}`, {
    claudeSessionId: `sdk-${index}`, createdAt: 1, lastUsedAt: index + 1, messageCount: 0,
  }]))
  writeFileSync(join(directory, "sessions.json"), JSON.stringify(sessions), { mode: 0o600 })
  await migrateBookkeeping(directory, { writersStopped: true })
  const previous = process.env.MERIDIAN_MAX_STORED_SESSIONS
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
  try {
    const handle = await initializeProxyBookkeeping()
    if (!handle) throw new Error("SQL startup missing")
    handles.push(handle)
    expect(handle.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(2)
    expect(lookupSharedSession("key-268")?.claudeSessionId).toBe("sdk-268")
    expect(lookupSharedSession("key-269")?.claudeSessionId).toBe("sdk-269")
    expect(lookupSharedSession("key-0")).toBeUndefined()
    expect(handle.reader.get("SELECT sum(counter) AS n FROM fence_slots WHERE namespace='store'")?.n).toBe(268)
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSIONS
    else process.env.MERIDIAN_MAX_STORED_SESSIONS = previous
  }
})

it("async-admits real production store operations against another Node writer without blocking timers", async () => {
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("SQL startup missing")
  handles.push(handle)
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout=0'); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    process.stdin.resume(); process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) });
  `, handle.path], { stdio: ["pipe", "pipe", "pipe"] })
  const exit = once(child, "exit")
  const ticks: number[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const [bytes] = await once(child.stdout, "data")
    expect(String(bytes)).toContain("locked")
    timer = setInterval(() => ticks.push(performance.now()), 5)
    const started = performance.now()
    await expect(admitSessionStoreWrite(() => storeSharedSession("blocked", "sdk"), { lockWaitMs: 150 }))
      .rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(performance.now() - started).toBeGreaterThanOrEqual(140)
    expect(ticks.length).toBeGreaterThanOrEqual(20)
    expect(lookupSharedSession("blocked")).toBeUndefined()
    child.stdin.write("release")
    expect((await exit)[0]).toBe(0)
    expect(await admitSessionStoreWrite(() => storeSharedSession("after", "sdk"))).not.toBe(false)
  } finally {
    if (timer) clearInterval(timer)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await exit
    }
  }
})
