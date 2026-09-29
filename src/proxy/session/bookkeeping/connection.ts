import Database from "libsql"
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statfsSync,
  unlinkSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { dirname, join, resolve } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { SessionLifecycleCorruptError, SessionLifecycleLockError } from "../lifecycleErrors"
import { initializeBookkeepingSchema, validateBookkeepingSchema, pragmaValue } from "./schema"
import { captureMappingPinsValidation } from "./mappings"
import { validateResourceRows } from "./resources"
import type { BookkeepingReader, SqlRow, SqlValue } from "./types"

export const BOOKKEEPING_FILENAME = "session-bookkeeping.sqlite"
export class BookkeepingBusyError extends SessionLifecycleLockError {}
export class BookkeepingMaintenanceRequiredError extends SessionLifecycleCorruptError {}
export interface BookkeepingInitializeOptions {
  executeTransaction?: (db: Database.Database, sql: string) => void
}
export interface Connection {
  db?: Database.Database
  path: string
  refs: number
  pending: number
  scope: "read" | "write" | undefined
  poisoned?: boolean
  phase: string
  executeTransaction?: BookkeepingInitializeOptions["executeTransaction"]
}
const registry = new Map<string, Connection>()
const directories = new Map<string, string>()

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}
export function busy(error: unknown): boolean {
  return /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(errorCode(error) ?? "")
}
export function getBookkeepingLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const parse = (raw: string | undefined, fallback: number): number => {
    const value = raw?.trim() ? Number(raw) : fallback
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback
  }
  const gc =
    env.MERIDIAN_SESSION_GC_LOCK_WAIT_MS ??
    env.CLAUDE_PROXY_SESSION_GC_LOCK_WAIT_MS ??
    env.SESSION_GC_LOCK_WAIT_MS
  return Math.max(
    parse(gc, 2000),
    parse(env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS ?? env.CLAUDE_PROXY_SESSION_LOCK_TIMEOUT_MS, 10_000),
  )
}

export function assertSupportedFilesystem(type: number, platform = process.platform): void {
  const APFS = 26,
    HFS = 17,
    EXT = 0xef53,
    XFS = 0x58465342,
    BTRFS = 0x9123683e,
    TMPFS = 0x01021994
  const allowed = platform === "darwin" ? [APFS, HFS] : platform === "linux" ? [EXT, XFS, BTRFS, TMPFS] : []
  if (!allowed.includes(type >>> 0) && process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS !== "1") {
    throw new Error(
      `unsupported bookkeeping filesystem ${platform}/${type}; ` +
        "operator may explicitly set BOOKKEEPING_ALLOW_UNVERIFIED_FS=1",
    )
  }
}

function ownedFd(path: string, directory = false, bootstrapLink = false): number {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new Error(`not an owned regular path: ${path}`, { cause: error })
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!directory && stat.isFile() && stat.nlink === 2 && path.endsWith(BOOKKEEPING_FILENAME)) {
      throw new BookkeepingBusyError("bootstrap publication is unlinking its temporary name")
    }
    const linksOkay = stat.nlink === 1 || (bootstrapLink && stat.nlink === 2)
    if (
      (directory ? !stat.isDirectory() : !stat.isFile() || !linksOkay) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(`not an owned regular path: ${path}`)
    if (directory) {
      if ((stat.mode & 0o777) !== 0o700)
        throw new Error(`bookkeeping directory must already be private (0700): ${path}`)
    } else {
      fchmodSync(fd, 0o600)
      if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error(`bookkeeping file permissions: ${path}`)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
function checkFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      closeSync(ownedFd(path + suffix))
    } catch (error) {
      if (suffix && errorCode(error) === "ENOENT") continue
      throw error
    }
  }
}
export function closeNative(db: Database.Database): void {
  try {
    if (db.inTransaction) db.exec("ROLLBACK")
  } finally {
    db.close()
  }
}
export function database(connection: Connection): Database.Database {
  if (!connection.db) throw new Error("bookkeeping connection is closed")
  return connection.db
}
export function checkParameters(parameters: SqlValue[]): void {
  if (parameters.some((value) => typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new RangeError("bookkeeping numbers must be safe integers")
  }
}
export function getRow(db: Database.Database, sql: string, parameters: SqlValue[]): SqlRow | undefined {
  checkParameters(parameters)
  const row = db.prepare(sql).get(...parameters) as SqlRow | undefined
  if (row) delete row._metadata
  return row
}
export function assertRead(sql: string): void {
  const pragmas =
    "journal_mode|synchronous|foreign_keys|busy_timeout|wal_autocheckpoint|user_version|application_id"
  if (
    !/^\s*(SELECT\b|EXPLAIN QUERY PLAN\b)/i.test(sql) &&
    !new RegExp(`^\\s*PRAGMA (${pragmas})\\s*$`, "i").test(sql)
  ) {
    throw new Error("bookkeeping reader cannot mutate")
  }
}
function pragmas(db: Database.Database, journal: "WAL" | "DELETE"): void {
  const values = [
    ["busy_timeout=0", 0],
    ["wal_autocheckpoint=0", 0],
    ["foreign_keys=ON", 1],
    [`journal_mode=${journal}`, journal.toLowerCase()],
    ["synchronous=FULL", 2],
  ] as const
  for (const [setting, expected] of values) {
    db.pragma(setting)
    if (pragmaValue(db, setting.split("=")[0]!) !== expected) throw new Error(`pragma refused: ${setting}`)
  }
}

function cleanupOrphans(path: string): void {
  const directory = dirname(path)
  for (const name of readdirSync(directory)) {
    const match = /^session-bookkeeping\.sqlite\.tmp-(\d+)-[a-f0-9-]+$/.exec(name)
    if (!match) continue
    try {
      process.kill(Number(match[1]), 0)
      continue
    } catch (error) {
      if (errorCode(error) !== "ESRCH") continue
    }
    const temporary = join(directory, name)
    try {
      const fd = ownedFd(temporary, false, true)
      try {
        const stat = fstatSync(fd)
        if (stat.nlink === 2) {
          const main = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const target = fstatSync(main)
            if (target.ino !== stat.ino || target.dev !== stat.dev)
              throw new Error("foreign bootstrap hardlink")
          } finally {
            closeSync(main)
          }
        }
        unlinkSync(temporary)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue
      throw error
    }
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        closeSync(ownedFd(temporary + suffix))
        unlinkSync(temporary + suffix)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
    }
  }
}

function bootstrap(path: string): void {
  cleanupOrphans(path)
  if (existsSync(path)) return
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  closeSync(openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
  let db: Database.Database | undefined
  try {
    db = new Database(temporary)
    pragmas(db, "DELETE")
    db.exec("BEGIN IMMEDIATE")
    initializeBookkeepingSchema(db, true)
    db.exec("COMMIT")
    closeNative(db)
    db = undefined
    const fd = ownedFd(temporary)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  } finally {
    if (db) closeNative(db)
    unlinkSync(temporary)
    syncDirectoryDurablySync(dirname(path))
  }
}

function openDatabase(path: string, phase: string, full: boolean): Database.Database {
  checkFiles(path)
  const db = new Database(path)
  try {
    pragmas(db, "WAL")
    db.exec("BEGIN")
    const meta = db.prepare("SELECT phase FROM schema_meta").get() as { phase: string } | undefined
    if (meta?.phase !== phase)
      throw new BookkeepingMaintenanceRequiredError(`bookkeeping phase is not ${phase}`)
    validateBookkeepingSchema(db, phase, full)
    let validatePins: (() => void) | undefined
    if (full) {
      const reader: BookkeepingReader = {
        get: (sql, ...params) => getRow(db, sql, params),
        all: (sql, ...params) => db.prepare(sql).all(...params) as SqlRow[],
      }
      validatePins = captureMappingPinsValidation(reader)
      validateResourceRows(reader)
    }
    db.exec("COMMIT")
    validatePins?.()
    checkFiles(path)
    return db
  } catch (error) {
    closeNative(db)
    throw error
  }
}
export function recover(connection: Connection): void {
  if (!connection.poisoned) return
  connection.db = openDatabase(connection.path, connection.phase, false)
  connection.poisoned = false
}
export function poison(connection: Connection): unknown | undefined {
  connection.poisoned = true
  const db = connection.db
  connection.db = undefined
  try {
    if (db) closeNative(db)
  } catch (error) {
    return error
  }
}
export function executeTransaction(connection: Connection, sql: string): void {
  if (connection.executeTransaction) connection.executeTransaction(database(connection), sql)
  else database(connection).exec(sql)
}
export function connectionFor(directory: string): Connection {
  const known = directories.get(resolve(directory))
  if (!known && [...registry.values()].some((connection) => connection.scope)) {
    throw new Error("cross-database publication is forbidden")
  }
  const path = known ?? join(realpathSync.native(resolve(directory)), BOOKKEEPING_FILENAME)
  const connection = registry.get(path)
  if (!connection)
    throw new BookkeepingMaintenanceRequiredError("initializeSessionBookkeeping before admission")
  return connection
}
export interface BookkeepingHandle {
  readonly path: string
  readonly reader: BookkeepingReader
  close(): void
}

/** Internal opening primitive; expectPhase is exposed only by maintenance.ts, not database.ts. */
export function openHandle(
  directory: string,
  options: BookkeepingInitializeOptions = {},
  expectPhase?: string,
): BookkeepingHandle {
  if ([...registry.values()].some((connection) => connection.scope)) {
    throw new Error("cannot initialize bookkeeping inside a transaction")
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonical = realpathSync.native(resolve(directory))
  closeSync(ownedFd(canonical, true))
  assertSupportedFilesystem(Number(statfsSync(canonical).type))
  const path = join(canonical, BOOKKEEPING_FILENAME)
  let connection = registry.get(path)
  if (connection) {
    if (options.executeTransaction) throw new Error("cannot change executor on an already open connection")
    if (connection.scope) throw new Error("cannot initialize bookkeeping inside a transaction")
    if (connection.phase !== (expectPhase ?? "READY"))
      throw new BookkeepingMaintenanceRequiredError("phase mismatch")
  } else {
    if (expectPhase === undefined) {
      for (const name of ["sessions.json", "session-gc.json", "sessions.json.lock", "session-gc.json.lock"]) {
        if (existsSync(join(canonical, name))) {
          throw new BookkeepingMaintenanceRequiredError("legacy bookkeeping requires offline migration")
        }
      }
      bootstrap(path)
    }
    try {
      const db = openDatabase(path, expectPhase ?? "READY", true)
      connection = {
        db,
        path,
        refs: 0,
        pending: 0,
        scope: undefined,
        phase: expectPhase ?? "READY",
        executeTransaction: options.executeTransaction,
      }
      registry.set(path, connection)
    } catch (error) {
      if (error instanceof BookkeepingBusyError || busy(error)) {
        throw new BookkeepingBusyError("bookkeeping startup busy; retry admission", { cause: error })
      }
      if (error instanceof SessionLifecycleCorruptError) throw error
      throw new SessionLifecycleCorruptError(`bookkeeping startup failed: ${String(error)}`, { cause: error })
    }
  }
  connection.refs++
  directories.set(resolve(directory), path)
  directories.set(canonical, path)
  let owned: Connection | undefined = connection
  function readable(): Database.Database {
    if (!owned) throw new Error("bookkeeping handle is closed")
    if (owned.scope === "write") throw new Error("use the transaction reader inside a write")
    return database(owned)
  }
  return {
    path,
    reader: {
      get(sql, ...params) {
        assertRead(sql)
        return getRow(readable(), sql, params)
      },
      all(sql, ...params) {
        assertRead(sql)
        checkParameters(params)
        return readable()
          .prepare(sql)
          .all(...params) as SqlRow[]
      },
    },
    close() {
      if (!owned) return
      if (owned.scope || owned.pending) throw new Error("cannot close during transaction/admission")
      const closing = owned
      owned = undefined
      if (--closing.refs === 0) {
        const db = closing.db
        closing.db = undefined
        registry.delete(path)
        for (const [alias, target] of directories) if (target === path) directories.delete(alias)
        if (db) closeNative(db)
      }
    },
  }
}

export function initializeSessionBookkeeping(
  directory: string,
  options: BookkeepingInitializeOptions = {},
): BookkeepingHandle {
  return openHandle(directory, options)
}
export function closeSessionBookkeeping(handle: BookkeepingHandle): void {
  handle.close()
}

/** Startup admission for concurrent fresh-directory publication; no blocking retry loop. */
export async function initializeSessionBookkeepingAsync(
  directory: string,
  options: BookkeepingInitializeOptions = {},
): Promise<BookkeepingHandle> {
  const deadline = performance.now() + getBookkeepingLockWaitMs()
  while (true) {
    try {
      return initializeSessionBookkeeping(directory, options)
    } catch (error) {
      const remaining = deadline - performance.now()
      if (!(error instanceof BookkeepingBusyError) || remaining <= 0) throw error
      await delay(Math.min(remaining, 20 + Math.random() * 10))
    }
  }
}
