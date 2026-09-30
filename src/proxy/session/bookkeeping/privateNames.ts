import { randomUUID } from "node:crypto"
import { rmdirSync, unlinkSync } from "node:fs"
import { isUuidV4 } from "./uuid"
import { BookkeepingFormatError } from "./storagePaths"

declare const privatePathBrand: unique symbol
export type PrivatePath = string & { readonly [privatePathBrand]: true }

/** The optional name is only for a validated durable intent, never an arbitrary path cast. */
export function privateName(publicPath: string, migrationId: string, recorded?: string): PrivatePath {
  if (!isUuidV4(migrationId)) throw new BookkeepingFormatError("invalid private name migration UUID")
  const prefix = `${publicPath}.releasing-${migrationId}-`
  const path = recorded ?? `${prefix}${randomUUID()}`
  if (!path.startsWith(prefix) || !isUuidV4(path.slice(prefix.length))) {
    throw new BookkeepingFormatError("invalid recorded private name")
  }
  return path as PrivatePath
}

/** POSIX boundary: freshly generated private UUID names are not concurrently named by another actor. */
export function unlinkPrivate(path: PrivatePath): void { unlinkSync(path) }
export function rmdirPrivate(path: PrivatePath): void { rmdirSync(path) }
