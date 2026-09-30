import { expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lifecycle from "../proxy/sessionLifecycle"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingRead, withBookkeepingWrite }
  from "../proxy/session/bookkeeping/database"
import { connectionFor, BookkeepingBusyError } from "../proxy/session/bookkeeping/connection"
import { BookkeepingCommitUncertainError } from "../proxy/session/bookkeeping/transaction"
import { sqliteLifecycleBackend as backend } from "../proxy/session/bookkeeping/lifecycleSql"
import { retryDeferredLeaseReleases } from "../proxy/session/bookkeeping/lifecycleLeasesSql"
import { claimDeletion, attachDeletionExecutor, finishDeletion, runDeletionPhase }
  from "../proxy/session/bookkeeping/lifecycleDeletionSql"
import { lifecycleCommitInjection, type LifecycleCommitFault } from "./fixtures/bookkeeping-lifecycle-injection"
import { observeLifecycleState } from "./fixtures/bookkeeping-lifecycle-observer"
import { writeMappingRow } from "../proxy/session/bookkeeping/mappings"
import { persistedCanonicalLocator } from "../proxy/session/bookkeeping/locator"

const methods = ["acquire", "attachExecutor", "release", "releaseJoined", "retryDeferred", "prepare",
  "preparePublication", "ensure", "register", "commit", "abandon", "publish", "attachPinned",
  "claimDeletion", "attachDeletion", "finishDeletion", "reconcileRescue", "reconcileRetire", "runGc", "runDeletionPhase"] as const
for (const method of methods) for (const point of ["busy-before", "ioerr-before", "ioerr-after"] as const) {
  it(`${method} × ${point}: typed outcome, durable snapshot, hooks, reopen`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-injection-")))
    const injection = lifecycleCommitInjection()
    const handle = initializeSessionBookkeeping(directory, injection)
    const options = { storeDir: directory, now: () => 1000, retiredGraceMs: 0 }
    const owner = captureProcessIncarnation()!
    const input = { configDir: directory, sessionId: "target" }
    let hooks = 0, callbacks = 0
    const publish = () => withBookkeepingWrite(directory, { scope: "store" }, tx => {
      callbacks++
      writeMappingRow(tx, "mapping", { claudeSessionId: input.sessionId, createdAt: 1000,
        lastUsedAt: 1000, messageCount: 0, currentTranscript: persistedCanonicalLocator(input) })
      tx.afterCommit(() => { hooks++ }); return true
    })
    const snapshot = () => ({ ledger: observeLifecycleState(directory, true),
      pins: withBookkeepingRead(directory, reader => reader.all("SELECT * FROM mapping_pins ORDER BY mapping_key,slot")) })
    try {
      let operation: () => Promise<unknown>
      let ordinal = 1
      if (["prepare", "preparePublication", "ensure", "register", "attachPinned"].includes(method)) {
        operation = () => {
          if (method === "prepare") return backend.prepareFork(input, options)
          if (method === "preparePublication") return backend.prepareForkForPublication(input, options)
          if (method === "ensure") return backend.ensureTranscriptJournaled(input, options)
          if (method === "register") return backend.registerLiveTranscript(input, options)
          return backend.attachPinnedTranscript(input, publish, options)
        }
      } else {
        const target = await backend.prepareFork(input, options)
        if (["attachExecutor", "release", "releaseJoined", "retryDeferred"].includes(method)) {
          const lease = await backend.acquireActiveTranscriptLease([target], options)
          if (method === "retryDeferred") {
            const abort = new AbortController()
            abort.abort(new lifecycle.SessionLifecycleLockError("defer joined release"))
            await backend.releaseJoinedTranscriptLease(lease, { ...options, admissionSignal: abort.signal })
          }
          operation = () => method === "attachExecutor" ? backend.attachActiveTranscriptExecutor(lease, owner, options)
            : method === "release" ? backend.releaseActiveTranscriptLease(lease, options)
              : method === "releaseJoined" ? backend.releaseJoinedTranscriptLease(lease, options)
                : retryDeferredLeaseReleases(options)
        } else if (["claimDeletion", "attachDeletion", "finishDeletion", "runDeletionPhase"].includes(method)) {
          await backend.abandonFork(target, options)
          if (method === "claimDeletion") operation = () => claimDeletion([], options)
          else if (method === "runDeletionPhase") operation = () => runDeletionPhase([], {
            ...options, deleter: async () => {},
          })
          else {
            const claim = (await claimDeletion([], options))!
            operation = () => method === "attachDeletion"
              ? attachDeletionExecutor(claim.key, claim.deletionToken!, owner, owner.pid, options)
              : finishDeletion(claim.key, claim.deletionToken!, undefined, options)
          }
        } else if (method === "reconcileRescue") {
          await backend.abandonFork(target, options)
          operation = () => backend.reconcile([target], options)
        } else if (method === "reconcileRetire" || method === "runGc") {
          await backend.commitFork(target, options)
          ordinal = 2 // rescue page commits unchanged, then the retirement write page
          operation = () => method === "runGc"
            ? backend.runGc([], { ...options, deleter: async () => {} }) : backend.reconcile([], options)
        } else operation = () => method === "acquire" ? backend.acquireActiveTranscriptLease([target], options)
          : method === "commit" ? backend.commitFork(target, options)
            : method === "abandon" ? backend.abandonFork(target, options)
              : backend.publishPinnedTranscript(target, publish, options)
      }
      const before = snapshot()
      injection.arm(point satisfies LifecycleCommitFault, ordinal)
      const expected = point === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError
      // Joined release deliberately absorbs retryable lock errors; it is retried by GC.
      if (method === "releaseJoined" && point === "busy-before") await operation()
      else await expect(operation()).rejects.toBeInstanceOf(expected)
      expect(injection.hits).toBe(1)
      expect(Boolean(connectionFor(directory).poisoned)).toBe(point !== "busy-before")
      expect(hooks).toBe(0)
      if (method === "publish" || method === "attachPinned") expect(callbacks).toBe(1)
      // Read admission reopens poisoned wrappers and observes the durable outcome, not a cached object.
      const after = snapshot()
      expect(Boolean(connectionFor(directory).poisoned)).toBe(false)
      if (point === "ioerr-after") expect(after).not.toEqual(before)
      else expect(after).toEqual(before)
      if (point !== "ioerr-after") {
        await operation()
        expect(snapshot()).not.toEqual(before)
        if (method === "publish" || method === "attachPinned") expect(hooks).toBe(1)
      }
      const next = await backend.prepareFork({ configDir: directory, sessionId: "after-reopen" }, options)
      expect(next.lifecycleGeneration).toBeDefined()
      await retryDeferredLeaseReleases(options)
    } finally {
      handle.close(); rmSync(directory, { recursive: true, force: true })
    }
  })
}
