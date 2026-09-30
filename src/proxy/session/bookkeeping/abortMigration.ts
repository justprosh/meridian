import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { acquireMaintenanceGuard } from "./guard"
import { BOOKKEEPING_FILENAME } from "./connection"
import { EXPORT_JOURNAL_NAME } from "./exportJournal"
import {
  crashPoint, readJournal, requireBarriers, saveJournal, SOURCE_NAMES,
} from "./maintenanceJournal"
import { releaseOwnBarrier } from "./barrier"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import { resumeRetirements } from "./privateRetirement"

/** Only the pre-database BARRIERS failure is reversible without exporting SQLite authority. */
export function abortBookkeepingMigration(input: string): void {
  const guard = acquireMaintenanceGuard(input)
  const directory = dirname(guard.path)
  try {
    resumeRetirements(directory)
    const journal = readJournal(directory)
    if (!journal || !["BARRIERS", "ABORTING", "ABORTED"].includes(journal.phase)) {
      throw new BookkeepingMaintenanceRequiredError("abort requires a BARRIERS migration journal")
    }
    if ([BOOKKEEPING_FILENAME, BOOKKEEPING_FILENAME + "-wal", BOOKKEEPING_FILENAME + "-shm",
      EXPORT_JOURNAL_NAME].some((name) => existsSync(join(directory, name)))) {
      throw new BookkeepingMaintenanceRequiredError("abort forbidden after database creation; use export-json")
    }
    if (journal.phase === "BARRIERS") {
      requireBarriers(directory, journal.id)
      journal.phase = "ABORTING"
      saveJournal(directory, journal)
      crashPoint("abort:ABORTING")
    }
    for (const source of SOURCE_NAMES) {
      releaseOwnBarrier(directory, source, journal.id)
      crashPoint(`abort:released:${source}`)
    }
    Object.assign(journal, readJournal(directory))
    journal.phase = "ABORTED"
    saveJournal(directory, journal)
    crashPoint("abort:ABORTED")
  } finally { guard.close() }
}
