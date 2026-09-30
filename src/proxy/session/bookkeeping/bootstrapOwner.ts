import { randomUUID } from "node:crypto"
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  captureProcessIncarnation, parseProcessIncarnationJson, probeProcessIncarnation,
} from "../processIncarnation"
import { syncDirectoryDurablySync } from "../durableFileSystem"
import { errorCode } from "./storagePaths"
import { resumeFileRetirement, retireBootstrapAlias, retireFile } from "./privateRetirement"

/** Identity is durable before the temporary SQLite inode can exist. */
export function createBootstrapPath(path: string): string {
  const owner = captureProcessIncarnation()
  if (!owner) throw new Error("cannot capture bootstrap process incarnation")
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const fd = openSync(`${temporary}.owner.json`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(owner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectoryDurablySync(dirname(path))
  return temporary
}

function unlinkIfPresent(path: string): void {
  try {
    retireFile(path, randomUUID())
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
}

function readOwner(path: string) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(`invalid bootstrap owner file: ${path}`)
    }
    return parseProcessIncarnationJson(readFileSync(path, "utf8"))
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    return undefined
  }
}

/** No opens of SQLite inodes: closing even an alias would drop this process's POSIX locks. */
export function cleanupBootstrapOrphans(path: string): void {
  const prefix = `${basename(path)}.tmp-`
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || !/^\d+-[a-f0-9-]+\.owner\.json$/.test(name.slice(prefix.length))) continue
    const ownerPath = join(dirname(path), name)
    const owner = readOwner(ownerPath)
    if (!owner || probeProcessIncarnation(owner) !== "dead") continue
    const temporary = ownerPath.slice(0, -".owner.json".length)
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const candidate = temporary + suffix
      try {
        const stat = lstatSync(candidate)
        if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error(`invalid bootstrap inode: ${candidate}`)
        }
        if (stat.nlink !== 1) {
          const target = lstatSync(path)
          if (suffix || stat.nlink !== 2 || stat.ino !== target.ino || stat.dev !== target.dev) {
            throw new Error(`foreign bootstrap hardlink: ${candidate}`)
          }
        }
        if (stat.nlink === 2) retireBootstrapAlias(candidate, randomUUID(), stat)
        else retireFile(candidate, randomUUID(), stat)
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
        resumeFileRetirement(candidate)
      }
    }
    unlinkIfPresent(ownerPath)
    syncDirectoryDurablySync(dirname(path))
  }
}

export function finishBootstrap(temporary: string): void {
  unlinkIfPresent(temporary)
  unlinkIfPresent(`${temporary}.owner.json`)
  syncDirectoryDurablySync(dirname(temporary))
}
