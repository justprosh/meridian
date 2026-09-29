import { existsSync, statfsSync } from "node:fs"
import { join } from "node:path"
import { protectedBytes } from "./exportJournal"
import { parseLegacySidecar } from "./legacyCodec"
import { assertQuiescent } from "./migrationImport"
import { SOURCE_NAMES } from "./maintenanceJournal"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

/** CLI refusal before guard bootstrap. The migrator repeats checks under exclusive ownership. */
export function preflightLegacyMigration(directory: string): void {
  let bytes = 0
  for (const name of SOURCE_NAMES) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    const document = protectedBytes(path, false, true)
    bytes += document.length
    if (name === "session-gc.json") assertQuiescent(parseLegacySidecar(document.toString("utf8")))
  }
  const fs = statfsSync(directory)
  if (fs.bavail * fs.bsize < bytes * 4 + 16 * 1024 * 1024) {
    throw new BookkeepingMaintenanceRequiredError("insufficient space for migration")
  }
}
