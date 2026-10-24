import { createRequire } from "node:module"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runInstanceImport } from "../../proxy/instanceImport/importer"
import { createSqliteStores } from "../../telemetry/sqlite"
import { NativeDatabase, bookkeepingEngineInfo } from "../../proxy/session/bookkeeping/nativeDatabase"

const require = createRequire(import.meta.url)
const mode = process.argv[2]!
const directory = process.argv[3]!
const path = join(directory, "telemetry.sqlite")
if (mode === "unsafe" || mode === "unsafe-import" || mode === "unsafe-fallback") {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite")
  const Original = sqlite.DatabaseSync
  sqlite.DatabaseSync = class extends Original {
    constructor(filename: string) {
      if (filename !== ":memory:") throw new Error("persistent open before engine qualification")
      super(filename)
    }
    override prepare(sql: string) {
      if (sql.includes("sqlite_version()")) return super.prepare("SELECT '3.45.1' AS version, 'unsafe-control' AS sourceId")
      return super.prepare(sql)
    }
  }
  if (mode === "unsafe-import") {
    const source = join(directory, "source.json")
    writeFileSync(source, '{"version":1,"accounts":[]}')
    const before = readdirSync(directory).sort()
    const lines: string[] = []
    const result = await runInstanceImport({
      from: { configDir: join(directory, "source"), storePath: source, telemetryPath: path },
      to: { configDir: join(directory, "destination"), storePath: join(directory, "destination.json"), telemetryPath: join(directory, "destination.sqlite") },
      apply: true, renames: new Map(), log: line => { lines.push(line) },
    })
    if (result.exitCode === 0 || !lines.join(" ").includes("WAL-reset fix")) throw new Error(`import accepted: ${lines}`)
    if (JSON.stringify(before) !== JSON.stringify(readdirSync(directory).sort())) throw new Error("import mutated files before refusal")
    console.log(JSON.stringify({ refused: true, files: [] }))
    process.exit(0)
  }
  if (mode === "unsafe-fallback") {
    process.env.MERIDIAN_TELEMETRY_PERSIST = "1"
    process.env.MERIDIAN_TELEMETRY_DB = path
    const { telemetryStore } = await import("../../telemetry/index")
    if (telemetryStore.describe().kind !== "memory" || existsSync(path)) throw new Error("unsafe persistent fallback opened database")
    console.log(JSON.stringify({ refused: true, files: [] }))
    process.exit(0)
  }
  let error = ""
  try { createSqliteStores(path, 7).close() } catch (failure) { error = String(failure) }
  if (!error.includes("WAL-reset fix") || existsSync(path)) throw new Error(`unsafe engine accepted: ${error}`)
  console.log(JSON.stringify({ refused: true, files: readdirSync(directory).filter(name => name.includes("sqlite")) }))
} else if (mode === "prepare-failure") {
  createSqliteStores(path, 7).close()
  const sqlite = require("node:sqlite") as typeof import("node:sqlite")
  const Original = sqlite.DatabaseSync
  const legacy = new Original(path)
  legacy.exec("ALTER TABLE metrics DROP COLUMN sdk_queue_wait_ms")
  legacy.close()
  let closed = false
  sqlite.DatabaseSync = class extends Original {
    override exec(sql: string) {
      if (sql.startsWith("ALTER TABLE")) throw new Error("injected ALTER lock refusal")
      super.exec(sql)
    }
    override close() { super.close(); closed = true }
  }
  let rejected = false
  try { createSqliteStores(path, 7) } catch (error) { rejected = String(error).includes("sdk_queue_wait_ms") }
  if (!rejected || !closed) throw new Error("legacy schema was accepted without compiling retained statements or closing its owner")
  console.log(JSON.stringify({ closed: true }))
} else if (mode === "setup-failure") {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite")
  const Original = sqlite.DatabaseSync
  let closed = false
  sqlite.DatabaseSync = class extends Original {
    private readonly persistent: boolean
    constructor(filename: string) { super(filename); this.persistent = filename !== ":memory:" }
    override exec(sql: string) {
      if (this.persistent && sql.includes("CREATE TABLE")) throw new Error("injected schema failure")
      super.exec(sql)
    }
    override close() { super.close(); if (this.persistent) closed = true }
  }
  let rejected = false
  try { createSqliteStores(path, 7) } catch (error) { rejected = String(error).includes("injected schema failure") }
  if (!rejected || !closed) throw new Error("setup failure leaked native owner")
  console.log(JSON.stringify({ closed: true }))
} else {
  const stores = createSqliteStores(path, 7)
  try {
    stores.diagnostics.log({ level: "info", category: "session", message: "native named binding", requestId: "native-id" })
    const rows = stores.diagnostics.getRecent({ category: "session", since: 0, limit: 1 })
    if (rows[0]?.requestId !== "native-id") throw new Error("named telemetry binding lost data")
    const reader = new NativeDatabase(path, { readonly: true })
    try {
      if (reader.prepare("SELECT count(*) AS n FROM diagnostic_logs").get()?.n !== 1) throw new Error("missing diagnostic row")
      let rejected = false
      try { reader.exec("DELETE FROM diagnostic_logs") } catch { rejected = true }
      if (!rejected) throw new Error("readonly connection accepted write")
    } finally { reader.close() }
    console.log(JSON.stringify({ engine: bookkeepingEngineInfo(), namedBinding: true, readonly: true }))
  } finally { stores.close() }
}
