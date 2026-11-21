import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { budgetErrors, physicalLines } from "./architecture-budgets.mjs";

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const baseline = JSON.parse(readFileSync(path.join(root, "scripts/architecture-baseline.json"), "utf8"));
function previousBaseline() {
  if (!ts.sys.directoryExists(path.join(root, ".git")) && !ts.sys.fileExists(path.join(root, ".git"))) return null;
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const file = "scripts/architecture-baseline.json";
  if (git("rev-parse", "--is-shallow-repository") === "true")
    throw new Error("Architecture ratchet requires full Git history.");
  const committed = JSON.parse(git("show", `HEAD:${file}`));
  if (JSON.stringify(committed) !== JSON.stringify(baseline)) return committed;
  const revisions = git("log", "-2", "--format=%H", "HEAD", "--", file).split("\n");
  return revisions[1] ? JSON.parse(git("show", `${revisions[1]}:${file}`)) : null;
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file) ? [file] : [];
  });
}

// Inspect full-program emit so even implicit re-exports of interfaces disappear.
// JavaScript is captured in memory only: nothing is executed or written.
function runtimeSpecifiers(emitted, file) {
  const ast = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specifiers = new Set();
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && /^(?:require|__require(?:_\d+)?)$/.test(node.expression.text)))
    ) {
      if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) {
        throw new Error(
          `${file}: computed import/require cannot be checked statically. Use a literal module specifier.`
        );
      }
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...specifiers].sort();
}

function runtimeCycles(modules) {
  const graph = new Map(modules.map((m) => [m.file, m.localImports]));
  const visited = new Set();
  const active = [];
  const cycles = [];
  function visit(file) {
    const index = active.indexOf(file);
    if (index !== -1) {
      cycles.push([...active.slice(index), file]);
      return;
    }
    if (visited.has(file)) return;
    active.push(file);
    for (const dependency of graph.get(file)) visit(dependency);
    active.pop();
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function checkArchitecture() {
  const errors = [];
  const configPath = path.join(root, "tsconfig.json");
  let options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  if (ts.sys.fileExists(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    if (parsed.errors.length) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
    options = { ...options, ...parsed.options };
  }
  const modules = sources(path.join(root, "src"))
    .sort()
    .map((absolute) => {
      const file = path.relative(root, absolute).split(path.sep).join("/");
      const source = readFileSync(absolute, "utf8");
      const lines = physicalLines(source);
      const limit = baseline.moduleBudgets[file]?.maxLines ?? baseline.defaultMaxLines;
      if (lines > limit)
        errors.push(`${file}: ${lines} physical lines exceed limit ${limit}. Review the architectural budget.`);
      return { file, absolute, lines, limit, imports: [], localImports: [] };
    });
  if (modules.length === 0) throw new Error("No production TypeScript modules found under src/.");
  errors.push(...budgetErrors(baseline, previousBaseline(), new Map(modules.map((m) => [m.file, m.lines]))));
  const byAbsolutePath = new Map(modules.map((m) => [path.normalize(m.absolute), m]));
  const emittedModules = new Set();
  const program = ts.createProgram(
    modules.map((m) => m.absolute),
    {
      ...options,
      noEmit: false,
      noEmitOnError: false,
      declaration: false,
      emitDeclarationOnly: false,
      sourceMap: false,
      inlineSourceMap: false,
      types: [],
    }
  );
  program.emit(undefined, (file, text, _bom, _onError, sourceFiles) => {
    if (!/\.[cm]?jsx?$/.test(file)) return;
    for (const source of sourceFiles ?? []) {
      const module = byAbsolutePath.get(path.normalize(source.fileName));
      if (module) {
        module.imports = runtimeSpecifiers(text, module.file);
        emittedModules.add(module.file);
      }
    }
  });
  for (const module of modules) {
    if (!emittedModules.has(module.file)) throw new Error(`${module.file}: no JavaScript emitted for analysis.`);
  }
  const forbidden = new Set(baseline.forbiddenPersistenceRuntimeModules);
  const names = new Map(modules.map((m) => [path.normalize(m.absolute), m.file]));
  for (const module of modules) {
    for (const specifier of module.imports) {
      const resolved = ts.resolveModuleName(specifier, module.absolute, options, ts.sys).resolvedModule;
      const target = resolved && names.get(path.normalize(resolved.resolvedFileName));
      if (target) module.localImports.push(target);
      if (
        /^(better-sqlite3|sqlite3|sqlite|sql\.js|node:sqlite|bun:sqlite|@libsql\/client)(\/|$)/.test(specifier) &&
        !(specifier === "better-sqlite3" && Object.hasOwn(baseline.sqliteOwners, module.file))
      ) {
        errors.push(
          `${module.file}: unauthorized SQLite runtime dependency ${specifier}. Use the injected SupportDatabase connection.`
        );
      }
      if (
        module.file.startsWith("src/persistence/") &&
        (/^(grammy(?:\/|$)|@grammyjs\/)/.test(specifier) ||
          (target && (forbidden.has(target) || /Telegram\.[cm]?tsx?$/.test(target))))
      ) {
        errors.push(
          `${module.file}: forbidden runtime dependency ${specifier}. Keep Telegram application code outside persistence.`
        );
      }
    }
  }
  const cycles = runtimeCycles(modules);
  for (const cycle of cycles) errors.push(`Runtime import cycle: ${cycle.join(" -> ")}`);
  return { modules, cycles, errors };
}

try {
  const report = checkArchitecture();
  if (report.errors.length) {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
  } else {
    const edges = report.modules.reduce((count, module) => count + module.localImports.length, 0);
    console.log(
      `Architecture check passed: ${report.modules.length} production modules, ${edges} local runtime edges, no runtime cycles.`
    );
  }
} catch (error) {
  console.error(`Architecture check failed: ${error.message}`);
  process.exitCode = 1;
}
