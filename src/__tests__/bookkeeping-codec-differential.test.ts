import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { STORE_META_KEY } from "../proxy/session/bookkeeping/legacyCodec"
import { enrichFixture } from "./fixtures/bookkeeping-rich-fixture"
import { nestedCodecCases } from "./fixtures/bookkeeping-nested-codec-corpus"
import type { CodecCase } from "./fixtures/bookkeeping-nested-codec-corpus"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

const baseline = spawnSync("git", ["cat-file", "-e", "ccc5ba3^{commit}"], { encoding: "utf8" })
const reason = baseline.status === 0 ? "" : " — git object ccc5ba3 unavailable (e.g. shallow checkout)"
if (reason) console.warn(`SKIP differential codecs${reason}`)
const differentialTest = reason ? it.skip : it
differentialTest(`ccc5ba3 codecs and extracted codecs produce identical bytes and error messages${reason}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-codec-differential-")))
  try {
    const tree = spawnSync("git", ["archive", "ccc5ba3", "src"], { maxBuffer: 64 * 1024 * 1024 })
    expect(tree.status, tree.stderr.toString()).toBe(0)
    const unpack = spawnSync("tar", ["-x", "-C", root], { input: tree.stdout, encoding: "utf8" })
    expect(unpack.status, unpack.stderr).toBe(0)
    for (const [file, names] of [["sessionLifecycle.ts", "readSidecar, writeSidecar"],
      ["sessionStore.ts", "parseStoreDocument, writeStore"]]) {
      const path = join(root, "src/proxy", file!)
      const original = spawnSync("git", ["show", `ccc5ba3:src/proxy/${file}`], { encoding: "utf8" })
      expect(original.status, original.stderr).toBe(0)
      writeFileSync(path, original.stdout + `\nexport { ${names} };\n`)
    }
    const data = join(root, "data")
    mkdirSync(data, { mode: 0o700 })
    const locator = canonicalizeLocator({ configDir: data, sessionId: "session" })
    const key = resourceKey(locator)
    const sidecar = { version: 1, resources: { [key]: {
      key, locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0, unknown: { b: 2, a: 1 },
    } }, unknown: "preserve-or-reject-identically" }
    const entry = { extension: { z: null, a: true }, claudeSessionId: "session", createdAt: 1,
      lastUsedAt: 2, messageCount: 2, sdkMessageUuids: [null, "uuid"], messageHashes: [] }
    const store = { [STORE_META_KEY]: { version: 3, slots: { abcd: 0, dcba: 7 },
      priorityAssignments: {}, priorityAttempts: {}, priorityRollbackMappings: {} }, entry }
    writeFileSync(join(data, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })
    writeFileSync(join(data, "sessions.json"), JSON.stringify(store), { mode: 0o600 })
    enrichFixture(data)
    const cases: CodecCase[] = []
    const add = (kind: "sidecar" | "store", value: unknown) => cases.push({ kind, raw: JSON.stringify(value) })
    add("sidecar", sidecar)
    cases.push({ kind: "sidecar", raw: readFileSync(join(data, "session-gc.json"), "utf8") })
    add("store", store)
    cases.push({ kind: "store", raw: readFileSync(join(data, "sessions.json"), "utf8") })
    add("store", { [STORE_META_KEY]: { version: 1, slots: { abcd: 0, dcba: 7 } }, entry })
    add("store", { entry: Object.fromEntries(Object.entries(entry).reverse()) })
    add("sidecar", Object.fromEntries(Object.entries(sidecar).reverse()))
    for (const kind of ["sidecar", "store"] as const) {
      for (const raw of ["", "{", "null", "[]", "true", "1", '"text"', "{}"])
        cases.push({ kind, raw })
    }
    for (const revision of [-1, 1.5, null, "1"]) add("store", { entry: { ...entry, revision } })
    for (const sdkMessageUuids of [[undefined], [5], {}, "uuid"]) add("store", { entry: { ...entry, sdkMessageUuids } })
    for (const version of [0, 4, "3", null]) {
      add("sidecar", { ...sidecar, version })
      add("store", { ...store, [STORE_META_KEY]: { ...store[STORE_META_KEY], version } })
    }
    add("sidecar", { version: 2, meta: { fenceSlots: { abcd: 0 } }, resources: {} })
    add("store", { ...store, [STORE_META_KEY]: { ...store[STORE_META_KEY], unknown: true } })
    add("store", { entry: { ...entry, currentTranscript: { configDir: "relative", sessionId: "session" } } })
    cases.push(...nestedCodecCases(data))
    writeFileSync(join(root, "cases.json"), JSON.stringify(cases))
    const runner = join(root, "runner.ts")
    writeFileSync(runner, `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { readSidecar, writeSidecar } from './src/proxy/sessionLifecycle';
      import { parseStoreDocument as oldStore, writeStore } from './src/proxy/sessionStore';
      import { parseLegacySidecar, serializeLegacySidecar, parseStoreDocument, serializeLegacyStore }
        from ${JSON.stringify(resolve("src/proxy/session/bookkeeping/legacyCodec.ts"))};
      const rows = JSON.parse(readFileSync(${JSON.stringify(join(root, "cases.json"))}, 'utf8'));
      const input = ${JSON.stringify(join(data, "input.json"))};
      const output = ${JSON.stringify(join(data, "output.json"))};
      const outcomes = [];
      for (const row of rows) {
        writeFileSync(input, row.raw, {mode: 0o600});
        let old; let current;
        try {
          if (row.kind === 'sidecar') await writeSidecar(output, await readSidecar(input));
          else writeStore(output, oldStore(row.raw));
          old = {bytes: readFileSync(output, 'utf8')};
        } catch(error) { old = {error: error.message}; }
        try {
          current = {bytes: row.kind === 'sidecar'
            ? serializeLegacySidecar(parseLegacySidecar(row.raw, input))
            : serializeLegacyStore(parseStoreDocument(row.raw))};
        } catch(error) { current = {error: error.message}; }
        outcomes.push({old, current});
      }
      console.log(JSON.stringify(outcomes));
    `)
    const build = await Bun.build({ entrypoints: [runner], outdir: root, naming: "runner.mjs", target: "node" })
    expect(build.success, String(build.logs)).toBe(true)
    const result = spawnSync("node", [join(root, "runner.mjs")], { encoding: "utf8", timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const outcomes: Array<{ old: { bytes?: string; error?: string }; current: { bytes?: string; error?: string } }> =
      JSON.parse(result.stdout)
    expect(outcomes).toHaveLength(cases.length)
    expect(outcomes.filter((row) => row.old.bytes !== undefined).length).toBeGreaterThanOrEqual(7)
    expect(outcomes.filter((row) => row.old.error !== undefined).length).toBeGreaterThan(20)
    writeBenchArtifact("codec-differential-corpus.json", cases.map((row, index) => ({
      ...row, ...outcomes[index],
      equal: JSON.stringify(outcomes[index]?.old) === JSON.stringify(outcomes[index]?.current),
    })))
    for (const [index, row] of outcomes.entries()) expect(row.current, JSON.stringify(cases[index])).toEqual(row.old)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)
