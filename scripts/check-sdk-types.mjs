import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Inspect only public SDK entrypoints, without loading host code or runtime state.
const require = createRequire(new URL("../packages/feishu/package.json", import.meta.url));
const file = new URL("../packages/feishu/src/openclaw-sdk-compat.d.ts", import.meta.url);
const declaration = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
let checked = 0;
for (const module of declaration.statements) {
  if (!ts.isModuleDeclaration(module) || !ts.isStringLiteral(module.name) || !module.body || !ts.isModuleBlock(module.body)) continue;
  const publicPath = require.resolve(module.name.text);
  if (existsSync(publicPath.replace(/\.js$/, ".d.ts"))) {
    throw new Error(`${module.name.text} now has upstream types; remove its compatibility declaration.`);
  }
  const source = ts.createSourceFile(publicPath, readFileSync(publicPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const exports = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const entry of statement.exportClause.elements) exports.add(entry.name.text);
    }
  }
  for (const statement of module.body.statements) {
    const names = [];
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.filter(entry => !entry.isTypeOnly).map(entry => entry.name.text));
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.push(statement.name.text);
    }
    for (const name of names) {
      if (!exports.has(name)) throw new Error(`Compatibility type ${module.name.text}.${name} is absent from the installed public SDK.`);
      checked += 1;
    }
  }
}
console.log(`Verified ${checked} typed exports against installed public SDK entrypoints.`);
