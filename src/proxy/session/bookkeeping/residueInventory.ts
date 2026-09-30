import { closeSync, existsSync, lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { captureProcessIncarnation, parseProcessIncarnation, probeProcessIncarnation } from "../processIncarnation"
import { protectedBytes } from "./exportJournal"
import { errorCode, ownedFd } from "./storagePaths"
import type { Residue, ResidueVerdict } from "./residueTypes"

export function candidateVerdict(path: string): ResidueVerdict {
  const stat = lstatSync(path)
  let owner: unknown
  try {
    const raw: unknown = JSON.parse(protectedBytes(stat.isDirectory() ? join(path, "owner.json") : path,
      true, true).toString("utf8").split("\n")[0]!)
    if (raw && typeof raw === "object") owner = (raw as Record<string, unknown>).incarnation
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(stat.isDirectory() && errorCode(error) === "ENOENT")) throw error
  }
  const incarnation = parseProcessIncarnation(owner)
  if (!incarnation) return "unknown"
  const probe = probeProcessIncarnation(incarnation)
  if (probe === "dead") return "dead-incarnation"
  if (probe === "alive") return "live"
  // Darwin birth time has second precision: not proof of the same incarnation, but a live
  // process at the observed identity is still a reason to refuse, never permission to archive.
  const observed = captureProcessIncarnation(incarnation.pid)
  return observed && observed.hostId === incarnation.hostId && observed.bootId === incarnation.bootId
    && observed.startId === incarnation.startId && observed.startIdKind === incarnation.startIdKind ? "live" : "unknown"
}

export function inspectArtifacts(directory: string): { candidates: Residue[]; gates: Residue[]; temporary: Residue[] } {
  const names = readdirSync(directory).filter((name) => !name.includes(".releasing-"))
  const candidates = names.filter((name) => /^(session-gc|sessions)\.json\.lock[^/]*\.candidate-/.test(name))
    .map((path): Residue => {
      const full = join(directory, path)
      const incomplete = lstatSync(full).isDirectory() && !existsSync(join(full, "owner.json"))
      return { path, verdict: candidateVerdict(full), ...(incomplete ? { kind: "incomplete-candidate" as const } : {}) }
    })
  const gates: Residue[] = []
  for (const name of ["deletion-gates", "sdk-process-gates"]) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    closeSync(ownedFd(path, true, false, true))
    for (const file of readdirSync(path)) gates.push({ path: `${name}/${file}`, verdict: "unknown" })
  }
  const temporary: Residue[] = names.filter((name) => /^session-gc\.json\.tmp-\d+-[a-f0-9-]{36}$/.test(name))
    .filter((name) => protectedBytes(join(directory, name), true, true).length === 0)
    .map((path) => ({ path, verdict: "unknown" }))
  return { candidates, gates, temporary }
}
