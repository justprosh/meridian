export type ResidueVerdict = "dead-incarnation" | "live" | "unknown"
export interface Residue { path: string; verdict: ResidueVerdict }
export interface ArchivedResidue extends Residue { digest: string; bytes: number; dev: number; ino: number }

export function isResiduePath(path: string): boolean {
  return /^(session-gc|sessions)\.json\.lock[^/]*\.candidate-[^/]+$/.test(path)
    || /^(deletion-gates|sdk-process-gates)\/[^/]+$/.test(path) && !path.endsWith("/..")
    || /^session-gc\.json\.tmp-\d+-[a-f0-9-]{36}$/.test(path)
}
export function validResidues(value: unknown): value is ArchivedResidue[] {
  return Array.isArray(value) && new Set(value.map((row) => row?.path)).size === value.length
    && value.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false
      const row = entry as Record<string, unknown>
      return typeof row.path === "string" && isResiduePath(row.path) && !row.path.endsWith("/.")
        && ["dead-incarnation", "unknown"].includes(String(row.verdict))
        && typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)
        && [row.bytes, row.dev, row.ino].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    })
}
