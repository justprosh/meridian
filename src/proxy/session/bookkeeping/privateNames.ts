import { randomUUID } from "node:crypto"
import { rmdirSync, unlinkSync } from "node:fs"

declare const privatePathBrand: unique symbol
export type PrivatePath = string & { readonly [privatePathBrand]: true }

/** The optional name is only for a validated durable intent, never an arbitrary path cast. */
export function privateName(publicPath: string, migrationId: string, recorded?: string): PrivatePath {
  const prefix = `${publicPath}.releasing-${migrationId}-`
  const path = recorded ?? `${prefix}${randomUUID()}`
  if (!path.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(path.slice(prefix.length))) {
    throw new Error("invalid recorded private name")
  }
  return path as PrivatePath
}

/** POSIX boundary: freshly generated private UUID names are not concurrently named by another actor. */
export function unlinkPrivate(path: PrivatePath): void { unlinkSync(path) }
export function rmdirPrivate(path: PrivatePath): void { rmdirSync(path) }
