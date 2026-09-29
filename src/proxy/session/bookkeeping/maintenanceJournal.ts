import { randomUUID, createHash } from "node:crypto"
import {
  closeSync, constants, existsSync, fsyncSync, fstatSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { errorCode, ownedFd } from "./storagePaths"

export const JOURNAL_NAME = "session-bookkeeping-migration.json"
export const SOURCE_NAMES = ["session-gc.json", "sessions.json"] as const
export type SourceName = typeof SOURCE_NAMES[number]
export type MigrationPhase = "PREPARED" | "BARRIERS" | "IMPORTED" | "READY"
export interface SourceIdentity {
  path: SourceName
  existed: boolean
  dev: number | null
  ino: number | null
  digest: string | null
  bytes: number
}
export interface MigrationJournal {
  format: "meridian-bookkeeping-migration"
  version: 1
  targetVersion: 1
  id: string
  phase: MigrationPhase
  sources: SourceIdentity[]
  finalSources?: SourceIdentity[]
}
export const digestBytes = (value: string) => createHash("sha256").update(value).digest("hex")

/** Atomic file publication; callers hold the exclusive maintenance guard. */
export function writeDurably(path: string, value: string): void {
  const temporary = `${path}.write-${randomUUID()}`
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    syncDirectoryDurablySync(dirname(path))
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
  }
}

export function observeSource(directory: string, path: SourceName): { identity: SourceIdentity; raw?: string } {
  const file = join(directory, path)
  try {
    const fd = ownedFd(file)
    try {
      const stat = fstatSync(fd)
      const raw = readFileSync(fd, "utf8")
      return { raw, identity: { path, existed: true, dev: stat.dev, ino: stat.ino,
        digest: digestBytes(raw), bytes: Buffer.byteLength(raw) } }
    } finally { closeSync(fd) }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return { identity: { path, existed: false, dev: null, ino: null, digest: null, bytes: 0 } }
  }
}

function validSources(value: unknown): value is SourceIdentity[] {
  if (!Array.isArray(value) || value.length !== 2) return false
  return value.every((entry: unknown, index) => {
    if (!entry || typeof entry !== "object") return false
    const row = entry as Record<string, unknown>
    return row.path === SOURCE_NAMES[index] && typeof row.existed === "boolean"
      && typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes >= 0
      && (row.existed ? typeof row.dev === "number" && Number.isSafeInteger(row.dev)
        && typeof row.ino === "number" && Number.isSafeInteger(row.ino)
        && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)
        : row.dev === null && row.ino === null && row.digest === null && row.bytes === 0)
  })
}

export function readJournal(directory: string): MigrationJournal | undefined {
  const path = join(directory, JOURNAL_NAME)
  if (!existsSync(path)) return undefined
  const fd = ownedFd(path)
  let value: unknown
  try { value = JSON.parse(readFileSync(fd, "utf8")) } finally { closeSync(fd) }
  if (!value || typeof value !== "object") throw new Error("invalid migration journal")
  const row = value as Record<string, unknown>
  if (row.format !== "meridian-bookkeeping-migration" || row.version !== 1 || row.targetVersion !== 1
    || typeof row.id !== "string" || !/^[a-f0-9-]{36}$/.test(row.id)
    || !["PREPARED", "BARRIERS", "IMPORTED", "READY"].includes(String(row.phase))
    || !validSources(row.sources) || (row.finalSources !== undefined && !validSources(row.finalSources))
    || (row.phase !== "PREPARED" && !row.finalSources)) throw new Error("invalid migration journal")
  return row as unknown as MigrationJournal
}

export function saveJournal(directory: string, journal: MigrationJournal): void {
  writeDurably(join(directory, JOURNAL_NAME), JSON.stringify(journal) + "\n")
}
export function barrierBytes(id: string): string {
  return JSON.stringify({ backend: "sqlite", migration_id: id, format: "meridian-bookkeeping-barrier-v1",
    instruction: "Stop all writers; use meridian-bookkeeping export-json. Never delete this barrier manually." }) + "\n"
}
export function isOwnBarrier(directory: string, source: SourceName, id: string): boolean {
  const path = join(directory, source + ".lock")
  try {
    const fd = ownedFd(path)
    try { return readFileSync(fd, "utf8") === barrierBytes(id) } finally { closeSync(fd) }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return false
  }
}
export function requireBarriers(directory: string, id: string): void {
  for (const source of SOURCE_NAMES) {
    if (!isOwnBarrier(directory, source, id)) throw new Error(`missing or foreign barrier: ${source}.lock`)
  }
}

/** Deliberately test-only fault point. SIGKILL leaves OS and filesystem, not JS cleanup, as the recovery carrier. */
export function crashPoint(point: string): void {
  if (process.env.MERIDIAN_BOOKKEEPING_TEST_CRASH === point) process.kill(process.pid, "SIGKILL")
}
