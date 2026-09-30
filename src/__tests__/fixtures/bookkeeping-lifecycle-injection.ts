import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withBookkeepingWrite } from "../../proxy/session/bookkeeping/database"
import type { TranscriptResource } from "../../proxy/session/bookkeeping/types"
import { sqliteLifecycleTest } from "./bookkeeping-lifecycle-install"

/** Inject a crash-state ledger row, not JSON corruption or a replacement writer connection. */
export function injectDeletingResource(directory: string, resource: TranscriptResource): void {
  if (resource.state !== "deleting") throw new TypeError("fixture requires a deleting resource")
  if (!sqliteLifecycleTest) {
    const path = join(directory, "session-gc.json")
    const sidecar = JSON.parse(readFileSync(path, "utf8")) as { resources: Record<string, TranscriptResource> }
    sidecar.resources[resource.key] = resource
    writeFileSync(path, JSON.stringify(sidecar), { mode: 0o600 })
    return
  }
  withBookkeepingWrite(directory, {}, tx => {
    const changed = tx.run(`UPDATE resources SET state='deleting',updated_at=?,deletion_token=?,
      deletion_owner_json=?,deletion_executor_json=?,deletion_process_group_id=?,row_version=row_version+1
      WHERE key=? AND generation=?`, resource.updatedAt, resource.deletionToken ?? null,
    resource.deletionOwner ? JSON.stringify(resource.deletionOwner) : null,
    resource.deletionExecutor ? JSON.stringify(resource.deletionExecutor) : null,
    resource.deletionProcessGroupId ?? null, resource.key, resource.generation)
    if (changed !== 1) throw new Error("fixture did not address exactly one resource generation")
  })
}
