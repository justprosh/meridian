import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { BookkeepingBusyError, initializeSessionBookkeeping, withBookkeepingWrite }
  from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { withStoreRead, withStoreWrite } from "../proxy/session/bookkeeping/storeScope"
import { activeStoreBackend } from "../proxy/session/bookkeeping/storeBackend"
import {
  getSessionStoreDir, readSessionTranscriptPins, setSessionStoreBackendForTest, setSessionStoreDir, storeSharedSession,
} from "../proxy/sessionStore"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

let directory: string
let handles: BookkeepingHandle[]
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-seam-")))
  handles = []
  setSessionStoreBackendForTest(null)
})
afterEach(() => {
  setSessionStoreBackendForTest(null)
  setSessionStoreDir(null)
  for (const handle of handles.reverse()) handle.close()
  rmSync(directory, { recursive: true, force: true })
})

it("keeps JSON as the default and returns copied locators from the additive pin API", () => {
  setSessionStoreDir(directory)
  expect(activeStoreBackend()).toBeUndefined()
  storeSharedSession("key", "session", 0, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { configDir: directory, sessionId: "session" })
  const pins = readSessionTranscriptPins()
  expect(pins).toEqual([{ configDir: directory, sessionId: "session" }])
  pins[0]!.configDir = "/changed"
  expect(readSessionTranscriptPins()[0]!.configDir).toBe(directory)
  expect(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8")).key.claudeSessionId).toBe("session")
})

it("joins an explicit publication once, reads its writes, and defers hooks until commit", () => {
  const statements: string[] = []
  handles.push(initializeSessionBookkeeping(directory, { executeTransaction: (db, sql) => {
    statements.push(sql)
    db.exec(sql)
  } }))
  let committed = false
  withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(directory, (tx) => {
      tx.run("INSERT INTO fence_slots VALUES('store','abcd',1)")
      tx.afterCommit(() => { committed = true })
    })
    expect(withStoreRead(directory, (reader) => reader.get("SELECT counter FROM fence_slots")?.counter)).toBe(1)
    expect(committed).toBe(false)
  })
  expect(committed).toBe(true)
  expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
})

it("discards hooks and staged changes when the publication returns false", () => {
  handles.push(initializeSessionBookkeeping(directory))
  let hooks = 0
  expect(withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(directory, (tx) => {
      tx.run("INSERT INTO fence_slots VALUES('store','abcd',1)")
      tx.afterCommit(() => { hooks++ })
    })
    return false
  })).toBe(false)
  expect(hooks).toBe(0)
  expect(withStoreRead(directory, (reader) => reader.get("SELECT count(*) AS n FROM fence_slots")?.n)).toBe(0)
})

it("refuses facade identity changes in read/write scopes and releases the guard after failure", () => {
  handles.push(initializeSessionBookkeeping(directory))
  setSessionStoreDir(directory)
  for (const scope of ["read", "write"]) {
    const check = () => {
      expect(() => setSessionStoreDir(null)).toThrow("cannot change session store identity")
      expect(() => setSessionStoreBackendForTest(null)).toThrow("cannot change session store identity")
      expect(getSessionStoreDir()).toBe(directory)
      throw new Error("rollback")
    }
    expect(() => scope === "read" ? withStoreRead(directory, check) : withStoreWrite(directory, check))
      .toThrow("rollback")
  }
  setSessionStoreDir(null)
  setSessionStoreBackendForTest(null)
})

it("rejects cross-database store admission before mutation", () => {
  const other = join(directory, "other")
  handles.push(initializeSessionBookkeeping(directory), initializeSessionBookkeeping(other))
  let entered = false
  expect(() => withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(other, () => { entered = true })
  })).toThrow("cross-database publication")
  expect(entered).toBe(false)
})

it("does not fall back to JSON inside an SQL publication when no SQL backend was installed", () => {
  handles.push(initializeSessionBookkeeping(directory))
  setSessionStoreDir(directory)
  expect(() => withStoreWrite(directory, () => storeSharedSession("key", "session")))
    .toThrow("JSON session store cannot run inside a bookkeeping transaction")
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
})

it("returns typed overload without sleeping when a real child holds BEGIN IMMEDIATE", async () => {
  const handle = initializeSessionBookkeeping(directory)
  handles.push(handle)
  expect(Object.values(handle.reader.get("PRAGMA busy_timeout")!)).toEqual([0])
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(handle.path)});
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    process.on('disconnect', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`busy holder exited before ready: ${code}: ${stderr}`)
    })])
    const sleeping = spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("sync sleep forbidden") })
    let entered = false
    const start = performance.now()
    try {
      try {
        withStoreWrite(directory, () => { entered = true })
        throw new Error("busy mutation unexpectedly admitted")
      } catch (error) {
        expect(error).toBeInstanceOf(BookkeepingBusyError)
        expect(error).toBeInstanceOf(SessionLifecycleLockError)
      }
      expect(sleeping).not.toHaveBeenCalled()
      expect(entered).toBe(false)
      writeBenchArtifact("store-scope-busy.json", { elapsedMs: performance.now() - start, entered, busyTimeout: 0 })
    } finally { sleeping.mockRestore() }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      if (child.connected) child.disconnect()
      else child.kill("SIGKILL")
      await exited
    }
  }
}, 20000)

const baseline = spawnSync("git", ["show", "d0d92c4:src/proxy/sessionStore.ts"], { encoding: "utf8" })
const contractTest = baseline.status === 0 ? it : it.skip
if (baseline.status !== 0) console.warn("SKIP ledger syntax comparison: baseline d0d92c4 unavailable")
contractTest("preserves every existing function signature and JSON body after removing dispatch", () => {
  const parse = (text: string) => ts.createSourceFile("store.ts", text, ts.ScriptTarget.Latest, true)
  const old = parse(baseline.stdout)
  const current = parse(readFileSync("src/proxy/sessionStore.ts", "utf8"))
  const printer = ts.createPrinter({ removeComments: true })
  const functions = (file: ts.SourceFile) => new Map(file.statements.filter(ts.isFunctionDeclaration)
    .map((node) => [node.name!.text, node]))
  const now = functions(current)
  for (const [name, previous] of functions(old)) {
    const next = now.get(name)!
    expect(next, name).toBeDefined()
    const signature = (node: ts.FunctionDeclaration, file: ts.SourceFile) =>
      printer.printNode(ts.EmitHint.Unspecified, ts.factory.createFunctionTypeNode(node.typeParameters,
        node.parameters, node.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword)), file)
    expect(signature(next, current), name).toBe(signature(previous, old))
    let statements = [...next.body!.statements]
    if (statements[0]?.getText(current).startsWith("const backend = activeStoreBackend()")) {
      statements = statements.slice(2)
    }
    if (name === "setSessionStoreDir") statements = statements.slice(1)
    const body = (rows: readonly ts.Statement[], file: ts.SourceFile) =>
      printer.printNode(ts.EmitHint.Unspecified, ts.factory.createBlock(rows, true), file)
    expect(body(statements, current), name).toBe(body(previous.body!.statements, old))
  }
  const moved = parse(readFileSync("src/proxy/session/bookkeeping/storeTypes.ts", "utf8"))
  const declarations = (file: ts.SourceFile) => new Map(file.statements
    .filter((node): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)).map((node) => [node.name.text, node]))
  const oldTypes = declarations(old)
  let matched = 0
  for (const [name, next] of declarations(moved)) {
    const previous = oldTypes.get(name)
    if (!previous) continue
    const text = (node: ts.Node, file: ts.SourceFile) =>
      printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, "")
    expect(text(next, moved), name).toBe(text(previous, old))
    matched++
  }
  expect(matched).toBe(10)
})
