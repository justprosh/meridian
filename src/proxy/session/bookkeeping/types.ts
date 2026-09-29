import type { ProcessIncarnation } from "../processIncarnation"
import type { TokenUsage } from "../lineage"

import type { TranscriptLocator, CanonicalTranscriptLocator } from "./locator"
export type { TranscriptLocator, CanonicalTranscriptLocator } from "./locator"

export type TranscriptResourceState = "prepared" | "live" | "retired" | "deleting" | "deleted"

export interface TranscriptResource {
  key: string
  generation: string
  locator: TranscriptLocator
  state: TranscriptResourceState
  createdAt: number
  updatedAt: number
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  deletionToken?: string
  deletionOwner?: ProcessIncarnation
  deletionExecutor?: ProcessIncarnation
  deletionProcessGroupId?: number
  rowVersion?: number
  activeLeases?: Record<string, ActiveTranscriptLeaseRecord>
}

export interface BookkeepingResource extends TranscriptResource {
  locator: CanonicalTranscriptLocator
  rowVersion: number
}

export interface ActiveTranscriptLeaseRecord {
  token: string
  owner: ProcessIncarnation
  purpose?: "publication"
  executor?: ProcessIncarnation
  executorRecoverable?: boolean
  createdAt: number
}

export interface StoredSession {
  claudeSessionId: string
  revision?: number
  generationId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
  lineageHash?: string
  messageHashes?: string[]
  messageBlockHashes?: string[][]
  sdkMessageUuids?: Array<string | null>
  passthroughToolCallAssistantUuid?: string
  passthroughToolCallIds?: string[]
  contextUsage?: TokenUsage
  previousClaudeSessionId?: string
  currentTranscript?: TranscriptLocator
  previousTranscript?: TranscriptLocator
}

export interface BookkeepingWriteOptions {
  /** Errors after durable commit cannot invalidate the returned publication. */
  onHookError?: (errors: readonly unknown[]) => void
  admissionSignal?: AbortSignal
  lockWaitMs?: number
  lockRetryMs?: number
  /** Only an explicit store/publication owner permits nested store writes. */
  scope?: "lifecycle" | "store" | "publication"
}

export type CanonicalStoredSession = Omit<StoredSession, "currentTranscript" | "previousTranscript"> & {
  currentTranscript?: CanonicalTranscriptLocator
  previousTranscript?: CanonicalTranscriptLocator
}

export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

export interface BookkeepingReader {
  get(sql: string, ...parameters: SqlValue[]): SqlRow | undefined
  all(sql: string, ...parameters: SqlValue[]): SqlRow[]
}

/** The capability expires when the synchronous callback returns. */
export interface BookkeepingTransaction extends BookkeepingReader {
  run(sql: string, ...parameters: SqlValue[]): number
  afterCommit(hook: () => void): void
}
