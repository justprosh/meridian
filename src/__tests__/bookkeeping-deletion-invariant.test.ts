import { expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const forbidden = new Set(["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync"])
function deletionReferences(source: string): string[] {
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true)
  const findings: string[] = []
  const record = (node: ts.Node, name: string) => {
    if (forbidden.has(name)) findings.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${name}`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) record(node, (node.propertyName ?? node.name).text)
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName)) {
      record(node, node.propertyName.text)
    }
    if (ts.isPropertyAccessExpression(node)) record(node, node.name.text)
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      record(node, node.argumentExpression.text)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) record(node, node.expression.text)
    if (ts.isAsExpression(node) && node.type.getText(file) === "PrivatePath") {
      findings.push("PrivatePath cast outside its generator")
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}

it("only privateNames.ts can name destructive filesystem operations or manufacture the brand", () => {
  const directory = join(process.cwd(), "src/proxy/session/bookkeeping")
  const failures = readdirSync(directory).filter((name) => name.endsWith(".ts") && name !== "privateNames.ts")
    .flatMap((name) => deletionReferences(readFileSync(join(directory, name), "utf8"))
      .map((finding) => `${name}:${finding}`))
  expect(failures).toEqual([])
})

for (const snippet of [
  'import { unlinkSync as erase } from "node:fs"; erase(path)',
  'import * as fs from "node:fs"; fs.unlinkSync(path)',
  'const { rmdirSync: erase } = require("node:fs"); erase(path)',
  'fs["rmSync"](path)', 'unlink(path)', 'const p = path as PrivatePath',
]) it(`invariant rejects ${snippet}`, () => { expect(deletionReferences(snippet).length).toBeGreaterThan(0) })

it("private wrappers, comments and strings are not direct deletion calls", () => {
  expect(deletionReferences('unlinkPrivate(path); // unlinkSync(path)\nconst note = "rmSync(path)"')).toEqual([])
})
