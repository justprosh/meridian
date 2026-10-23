import { expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { readMapping, writeMappingRow } from "../proxy/session/bookkeeping/mappings"
import { storeSharedSession } from "../proxy/session/bookkeeping/storeWriteSql"
import { snapshotForExport } from "../proxy/session/bookkeeping/exportSnapshot"

it("reads and exports upgraded history; an old-runtime continuation invalidates only its context witness", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-rollback-")))
  const handle = initializeSessionBookkeeping(directory)
  const hash = "a".repeat(64)
  const history = { messageHashes: ["first", "second"], sdkMessageUuids: [null, "assistant"] }
  try {
    withBookkeepingWrite(directory, {}, tx => {
      writeMappingRow(tx, "conversation", {
        claudeSessionId: "session-after-upgrade", generationId: randomUUID(), revision: 1,
        createdAt: 1, lastUsedAt: 2, messageCount: 2, ...history,
      })
      tx.run("UPDATE mapping_history SET history_json=? WHERE mapping_key=?",
        JSON.stringify({ ...history, resumeContextHash: hash }), "conversation")
    })
    expect(readMapping(handle.reader, "conversation")).toMatchObject({ ...history, resumeContextHash: hash })
    const exported = JSON.parse(snapshotForExport(handle.reader).store)
    expect(exported.conversation).toMatchObject({ ...history, resumeContextHash: hash })
    expect(storeSharedSession(directory, "conversation", "session-after-upgrade")).not.toBe(false)
    const continued = readMapping(handle.reader, "conversation")
    expect(continued).toMatchObject({ ...history, claudeSessionId: "session-after-upgrade", messageCount: 2 })
    expect(continued).not.toHaveProperty("resumeContextHash")
    expect(handle.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(1)
  } finally { handle.close(); rmSync(directory, { recursive: true, force: true }) }
})
