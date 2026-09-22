import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Fast Production Build rejected an imported helper redeclared by an old local
// function. Preserve imports while erasing types: a transpiler that drops an
// apparently unused import can hide the ESM binding conflict from runtime tests.
const routePaths = [
  "src/app/api/v1/vscode/[token]/models/route.ts",
  "src/app/api/v1/vscode/[token]/api/tags/route.ts",
  "src/app/api/v1/vscode/raw/[token]/api/tags/route.ts",
];

for (const routePath of routePaths) {
  test(`${routePath} compiles as an ES module with its imports preserved`, () => {
    const fileName = fileURLToPath(new URL(`../../${routePath}`, import.meta.url));
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
    });
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: outputText,
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, `${routePath}: ${result.stderr}`);
  });
}
