import { sqliteLifecycleLeases } from "./lifecycleLeasesSql"
import { sqliteLifecyclePrepare } from "./lifecyclePrepareSql"
import { sqliteLifecycleRegister } from "./lifecycleRegisterSql"
import { sqliteLifecycleTransitions } from "./lifecycleTransitionsSql"
import { sqliteLifecyclePublication } from "./lifecyclePublicationSql"
import { sqliteLifecycleGc } from "./lifecycleGcSql"
import type { SessionLifecycleBackend } from "./lifecycleBackend"

/** Complete test-only backend. Production selection remains unchanged. */
export const sqliteLifecycleBackend = {
  ...sqliteLifecycleLeases, ...sqliteLifecyclePrepare, ...sqliteLifecycleRegister,
  ...sqliteLifecycleTransitions, ...sqliteLifecyclePublication, ...sqliteLifecycleGc,
} satisfies SessionLifecycleBackend
