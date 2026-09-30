import { describe, it } from "bun:test"
import { initializeSessionBookkeeping, type BookkeepingHandle } from "../../proxy/session/bookkeeping/database"
import { setSessionLifecycleBackendForTest } from "../../proxy/session/bookkeeping/lifecycleBackend"
import { sqliteLifecycleBackend } from "../../proxy/session/bookkeeping/lifecycleSql"
import { sqliteSessionStoreBackend } from "../../proxy/session/bookkeeping/sqliteStoreBackend"
import { getSessionStoreDir, setSessionStoreBackendForTest, setSessionStoreDir } from "../../proxy/sessionStore"

export const sqliteLifecycleTest = process.env.BOOKKEEPING_TEST_BACKEND === "sqlite"
const handles: BookkeepingHandle[] = []
let previousStoreDirectory: string | undefined

/** Keep JSON protocol assertions intact; the reason is visible in the test report. */
export function legacyLifecycleOnly(
  reason: string, name: string, test: () => void | Promise<void>, timeout?: number,
): void {
  const suite = sqliteLifecycleTest ? describe.skip : describe
  suite(`legacy-only: ${reason}`, () => { it(name, test, timeout) })
}

/** Publication callbacks use the store port, so both ports must share the same database. */
export function setupLifecycleBackend(directory: string): void {
  if (!sqliteLifecycleTest) return
  handles.push(initializeSessionBookkeeping(directory))
  previousStoreDirectory ??= getSessionStoreDir()
  setSessionStoreDir(directory)
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  setSessionLifecycleBackendForTest(sqliteLifecycleBackend)
}

export function teardownLifecycleBackend(): void {
  if (!sqliteLifecycleTest) return
  setSessionLifecycleBackendForTest(null)
  setSessionStoreBackendForTest(null)
  for (const handle of handles.splice(0)) handle.close()
  if (previousStoreDirectory !== undefined) setSessionStoreDir(previousStoreDirectory)
  previousStoreDirectory = undefined
}
