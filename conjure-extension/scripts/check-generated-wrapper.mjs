import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleCache = new Map();

const resolveTsModule = (fromFile, specifier) => {
  if (!specifier.startsWith(".")) return specifier;

  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not resolve ${specifier} from ${fromFile}`);
};

const loadTsModule = (filePath) => {
  const resolved = path.resolve(filePath);
  if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;

  const source = fs.readFileSync(resolved, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: resolved
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(resolved, module);

  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const target = resolveTsModule(resolved, specifier);
    return loadTsModule(target);
  };

  new Function("require", "exports", "module", js)(localRequire, module.exports, module);
  return module.exports;
};

const { buildGeneratedModUserScriptCode } = loadTsModule(
  path.join(root, "src", "generatedModWrapper.ts")
);

const generated = buildGeneratedModUserScriptCode({
  projectId: "project-test",
  scriptId: "conjure-mod-demo",
  bundle: {
    mod_id: "demo",
    name: "Demo mod",
    matches: ["https://example.com/*"],
    run_at: "document_idle",
    css: "body { color: rgb(1, 2, 3); }",
    js: [
      "const button = document.createElement('button');",
      "button.addEventListener('click', async () => { throw new Error('click failed'); });",
      "setTimeout(() => { throw new Error('timer failed'); }, 1);",
      "requestAnimationFrame(() => { throw new Error('frame failed'); });"
    ].join("\n")
  }
});

const requiredMarkers = [
  "conjure:generated_mod_error",
  "chrome.runtime.sendMessage",
  "window.postMessage",
  "addEventListener",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "promise_rejection",
  "data-conjure-mod-id",
  "throw __conjureError;"
];

const missingMarkers = requiredMarkers.filter((marker) => !generated.includes(marker));
if (missingMarkers.length > 0) {
  throw new Error(`Generated wrapper is missing markers: ${missingMarkers.join(", ")}`);
}

new Function(generated);

console.log(`generated wrapper shape ok (${generated.length} chars)`);
