import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { barrierBytes, crashPoint } from "./maintenanceJournal"
import type { SourceName } from "./maintenanceJournal"
import { errorCode } from "./storagePaths"

export class BookkeepingBarrierReplacedError extends Error {
  readonly exitCode = 5
}

function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

/** The exclusive maintenance guard serializes release/resume. Never unlink an unchecked path. */
export function releaseOwnBarrier(directory: string, source: SourceName, id: string,
  afterCheckForTest?: () => void): void {
  const path = join(directory, source + ".lock")
  const privatePath = `${path}.releasing-${id}`
  const resumed = present(privatePath)
  const target = resumed ? privatePath : path
  if (!present(target)) return
  const replaced = () => new BookkeepingBarrierReplacedError(`barrier replaced or foreign barrier: ${source}`)
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const expected = fstatSync(fd)
    if (!expected.isFile() || readFileSync(fd, "utf8") !== barrierBytes(id)) throw replaced()
    if (!resumed) {
      afterCheckForTest?.()
      renameSync(path, privatePath)
      syncDirectoryDurablySync(directory)
    }
    const actual = lstatSync(privatePath)
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      // link+unlink is a no-clobber rename: rename() alone could overwrite a newly occupied path.
      try {
        linkSync(privatePath, path)
        unlinkSync(privatePath)
        syncDirectoryDurablySync(directory)
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
      }
      throw replaced()
    }
    crashPoint(`barrier:releasing:${source}`)
    unlinkSync(privatePath)
    syncDirectoryDurablySync(directory)
  } finally { closeSync(fd) }
  if (present(path)) throw replaced()
}
