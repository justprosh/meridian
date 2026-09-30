import Database from "libsql"
import { closeSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { acquireInspectionGuard } from "./guard"
import { barrierBytes, readJournal, SOURCE_NAMES } from "./maintenanceJournal"
import { protectedBytes, readExportJournal } from "./exportJournal"
import { CYCLES_DIRECTORY, readTransition } from "./cycles"
import { ownedFd } from "./storagePaths"
import { BOOKKEEPING_APPLICATION_ID, pragmaValue, RESOURCE_STATES } from "./schema"
import { parseLegacySidecar, parseLegacyStoreForMaintenance } from "./legacyCodec"
import { inspectArtifacts } from "./residueInventory"
import type { Residue } from "./residueTypes"
import { isUuidV4 } from "./uuid"

export class BookkeepingOwnerMismatchError extends Error { readonly exitCode = 6 }
export type InspectionPhase = "legacy" | "prepared" | "barriers" | "imported" | "ready"
  | "exporting" | "exported" | "aborted" | "corrupt"
export interface Inspection {
  phase: InspectionPhase
  migration_id: string | null
  cycle_id: string | null
  cycle_number: number
  archived_cycles: number
  resources: Record<string, number>
  mappings: number
  sizes: { main: number; wal: number; shm: number }
  barriers: Record<string, "own" | "foreign" | "none">
  candidates: Residue[]
  gates: Residue[]
  temporary: Residue[]
}
export function inspectionDirectory(input: string): string {
  const directory = realpathSync(input)
  const stat = lstatSync(directory)
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new BookkeepingOwnerMismatchError("caller uid differs from session directory owner")
  }
  closeSync(ownedFd(directory, true, false, true))
  return directory
}
const bytes = (path: string) => protectedBytes(path, true, true).toString("utf8")

export function inspectBookkeeping(input: string): Inspection {
  const directory = inspectionDirectory(input)
  const guard = acquireInspectionGuard(directory)
  try {
    const migration = readJournal(directory, true)
    const exported = readExportJournal(directory, true)
    const transition = readTransition(directory, true)
    if (exported && !transition && exported.migrationId !== migration?.id) {
      throw new Error("export migration identity mismatch")
    }
    const root = join(directory, CYCLES_DIRECTORY)
    let archived = 0
    if (existsSync(root)) {
      closeSync(ownedFd(root, true, false, true))
      archived = readdirSync(root).filter((name) => name !== transition?.id && name !== migration?.id
        && isUuidV4(name) && lstatSync(join(root, name)).isDirectory()).length
    }
    const id = migration?.id ?? transition?.id ?? null
    const phase: InspectionPhase = transition
      ? (transition.files.some((file) => file.name === "session-bookkeeping-export.json") ? "exported" : "aborted")
      : exported ? (exported.phase === "EXPORTED" ? "exported" : "exporting")
        : migration?.phase === "ABORTING" ? "barriers"
          : (migration?.phase.toLowerCase() as InspectionPhase | undefined) ?? "legacy"
    const path = join(directory, "session-bookkeeping.sqlite")
    const size = (file: string) => {
      if (!existsSync(file)) return 0
      closeSync(ownedFd(file, false, false, true))
      return lstatSync(file).size
    }
    const sizes = { main: size(path), wal: size(path + "-wal"), shm: size(path + "-shm") }
    const resources: Record<string, number> = Object.fromEntries(RESOURCE_STATES.map((state) => [state, 0]))
    let mappings = 0
    if (sizes.main) {
      if (!migration || !guard) throw new Error("database without migration journal/guard")
      if (!sizes.shm && sizes.wal) throw new Error("WAL without shared memory; offline recovery required")
      // libsql's JS readonly option is ignored; enforce read-only in the native SQLite URI.
      const address = `${pathToFileURL(path).href}?mode=ro${sizes.shm ? "" : "&immutable=1"}`
      const db = new Database(address)
      try {
        db.exec("BEGIN")
        if (pragmaValue(db, "application_id") !== BOOKKEEPING_APPLICATION_ID) {
          throw new Error("bookkeeping database application id mismatch")
        }
        const meta = db.prepare("SELECT migration_id,phase FROM schema_meta").get() as Record<string, unknown>
        if (meta.phase === "READY" && meta.migration_id !== id) throw new Error("database migration id mismatch")
        const counts = db.prepare("SELECT state,count(*) AS n FROM resources GROUP BY state").all() as
          Array<{ state: string; n: number }>
        for (const row of counts) resources[row.state] = row.n
        mappings = (db.prepare("SELECT count(*) AS n FROM mappings").get() as { n: number }).n
      } finally {
        // libsql close can defer native teardown until statements are collected. End the
        // snapshot explicitly: an inspection must not leave a read mark behind until GC.
        try { if (db.inTransaction) db.exec("ROLLBACK") } finally { db.close() }
      }
    } else {
      if (["ready", "imported"].includes(phase)) throw new Error("committed migration database missing")
      const sidecar = join(directory, "session-gc.json")
      const store = join(directory, "sessions.json")
      if (existsSync(sidecar)) for (const row of Object.values(parseLegacySidecar(bytes(sidecar)).resources)) {
        resources[row.state] = (resources[row.state] ?? 0) + 1
      }
      if (existsSync(store)) mappings = Object.keys(parseLegacyStoreForMaintenance(bytes(store)).sessions).length
    }
    const barriers: Inspection["barriers"] = {}
    for (const source of SOURCE_NAMES) {
      const lock = join(directory, source + ".lock")
      barriers[source] = !existsSync(lock) ? "none" : id && bytes(lock) === barrierBytes(id) ? "own" : "foreign"
    }
    return { phase, migration_id: id, cycle_id: id, cycle_number: archived + 1, archived_cycles: archived,
      resources, mappings, sizes, barriers, ...inspectArtifacts(directory) }
  } finally { guard?.close() }
}
