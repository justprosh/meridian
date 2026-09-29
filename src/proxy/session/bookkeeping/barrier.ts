import { randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { barrierBytes, crashPoint, readJournal, saveJournal } from "./maintenanceJournal"
import type { SourceName } from "./maintenanceJournal"
import { errorCode } from "./storagePaths"

export class BookkeepingBarrierReplacedError extends Error { readonly exitCode = 5 }
export interface BarrierReleaseHooks {
  beforeLink?: (privatePath: string) => void
  afterLink?: (privatePath: string) => void
}
function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

/** Exclusive maintenance ownership; durable intent precedes no-clobber publication. */
export function releaseOwnBarrier(directory: string, source: SourceName, id: string,
  hooks: BarrierReleaseHooks = {}): void {
  const path = join(directory, source + ".lock")
  const replaced = () => new BookkeepingBarrierReplacedError(`barrier replaced or foreign barrier: ${source}`)
  const journal = readJournal(directory)
  if (!journal || journal.id !== id) throw replaced()
  let intent = journal.releases?.[source]
  if (!intent) {
    if (!present(path)) return
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || readFileSync(fd, "utf8") !== barrierBytes(id)) throw replaced()
      intent = { name: `${source}.lock.releasing-${id}-${randomUUID()}`, dev: stat.dev, ino: stat.ino }
    } finally { closeSync(fd) }
    journal.releases = { ...journal.releases, [source]: intent }
    saveJournal(directory, journal)
    crashPoint(`barrier:intent:${source}`)
  }
  const privatePath = join(directory, intent.name)
  const isOurs = (file: string) => {
    const stat = lstatSync(file)
    return stat.isFile() && stat.dev === intent.dev && stat.ino === intent.ino
  }
  if (!present(privatePath)) {
    if (!present(path)) return
    if (!isOurs(path)) throw replaced()
    hooks.beforeLink?.(privatePath)
    try { linkSync(path, privatePath) } catch (error) {
      if (errorCode(error) === "EEXIST") throw replaced()
      throw error
    }
    syncDirectoryDurablySync(directory)
    hooks.afterLink?.(privatePath)
    // Only this invocation's newly created link may be removed on failed acquisition.
    if (!isOurs(privatePath)) {
      unlinkSync(privatePath)
      syncDirectoryDurablySync(directory)
      throw replaced()
    }
    crashPoint(`barrier:linked:${source}`)
  }
  if (!isOurs(privatePath) || readFileSync(privatePath, "utf8") !== barrierBytes(id)) throw replaced()
  if (present(path)) {
    if (!isOurs(path)) {
      unlinkSync(privatePath)
      syncDirectoryDurablySync(directory)
      throw replaced()
    }
    unlinkSync(path)
    syncDirectoryDurablySync(directory)
  }
  crashPoint(`barrier:releasing:${source}`)
  unlinkSync(privatePath)
  syncDirectoryDurablySync(directory)
  if (present(path)) throw replaced()
}
