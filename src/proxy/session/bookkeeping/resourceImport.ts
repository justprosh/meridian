/** IMPORT ONLY: offline migrator/fixtures; never exported by the runtime facade. */
import { validateResource } from "./resources"
import { writeResourceRow } from "./resourceRow"
import type { BookkeepingResource, BookkeepingTransaction } from "./types"

export function importResource(tx: BookkeepingTransaction, resource: BookkeepingResource): void {
  const counter = validateResource(resource)
  writeResourceRow(tx, resource)
  tx.run(
    `INSERT INTO fence_slots VALUES('lifecycle',?,?) ON CONFLICT(namespace,slot)
    DO UPDATE SET counter=max(counter,excluded.counter)`,
    resource.key.slice(0, 4),
    counter,
  )
}
