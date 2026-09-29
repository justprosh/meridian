/** MIGRATOR ONLY. This module is not exported by the runtime database facade. */
import { openHandle } from "./connection"
export function openForMaintenance(directory: string, options: { expectPhase: string }) {
  return openHandle(directory, {}, options.expectPhase)
}
