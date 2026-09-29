import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  rmdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { protectedBytes } from "./exportJournal"
import type { ArchivedResidue } from "./residueTypes"
import { ownedFd } from "./storagePaths"

/** Empty directories cannot be hardlinked. Archive their identity before removing the empty source. */
export function archiveIncompleteDirectory(source: string, target: string, row: ArchivedResidue): void {
  const checkSource = () => {
    closeSync(ownedFd(source, true, false, true))
    const stat = lstatSync(source)
    if (stat.dev !== row.dev || stat.ino !== row.ino || readdirSync(source).length) {
      throw new Error(`incomplete candidate changed: ${row.path}`)
    }
  }
  if (existsSync(source)) checkSource()
  const marker = join(target, ".bookkeeping-residue.json")
  const bytes = JSON.stringify(row) + "\n"
  if (!existsSync(target)) {
    if (!existsSync(source)) throw new Error(`incomplete candidate disappeared: ${row.path}`)
    mkdirSync(target, { mode: 0o700 })
    const fd = openSync(marker, "wx", 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    syncDirectoryDurablySync(target)
    syncDirectoryDurablySync(dirname(target))
  }
  closeSync(ownedFd(target, true, false, true))
  // An empty pre-existing target (including a crash before marker publication) is ambiguous:
  // refuse without removing the source, rather than adopting somebody else's directory.
  if (readdirSync(target).length !== 1 || protectedBytes(marker, false, true).toString("utf8") !== bytes) {
    throw new Error(`foreign incomplete candidate archive: ${row.path}`)
  }
  if (existsSync(source)) {
    checkSource()
    rmdirSync(source)
    syncDirectoryDurablySync(dirname(source))
  }
}
