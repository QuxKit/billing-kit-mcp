#!/usr/bin/env node
// Regenerate the discovery snapshots the server bundles:
//
//   src/data/api.json         <- billing-kit's built declaration files (dist/**/index.d.ts)
//   src/data/components.json  <- billing-kit-components' registry.json
//
// api.json has two parts. `exports` is generated: every value and type each
// public subpath of @quxkit/billing-kit exports, read from the d.ts tsup emits.
// `symbols` is curated: hand-written summaries and gotchas for the symbols an
// assistant is most likely to ask about. The generator preserves `symbols`
// verbatim and checks each one still names a real export, so a rename upstream
// fails here instead of shipping a stale reference.
//
//   node scripts/gen-discovery.mjs            rewrite both files
//   node scripts/gen-discovery.mjs --check    exit 1 if the committed files are stale
//   node scripts/gen-discovery.mjs --only=api | --only=components
//
// Sources default to the sibling checkouts (../billing-kit, ../billing-kit-components)
// and can be pointed elsewhere with BILLING_KIT_DIR / BILLING_KIT_COMPONENTS_DIR.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const onlyArg = [...args].find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : 'all';
if (!['all', 'api', 'components'].includes(only)) {
  fail(`--only must be api or components, got "${only}"`);
}

const billingKitDir = resolve(root, process.env.BILLING_KIT_DIR ?? '../billing-kit');
const componentsDir = resolve(root, process.env.BILLING_KIT_COMPONENTS_DIR ?? '../billing-kit-components');

const apiPath = join(root, 'src/data/api.json');
const componentsPath = join(root, 'src/data/components.json');

function fail(msg) {
  process.stderr.write(`gen-discovery: ${msg}\n`);
  process.exit(1);
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const stringify = (o) => `${JSON.stringify(o, null, 2)}\n`;

// ---- api.json ---------------------------------------------------------------

// Pull every exported name out of a tsup-emitted .d.ts. Two forms occur:
//   export { a as Name, type T, U } from './chunk.js';   (re-exports, with renames)
//   export { Name, type T };                              (the file's own final export list)
// plus direct declarations for anything not routed through a list.
function exportsOf(dtsPath) {
  const src = readFileSync(dtsPath, 'utf8');
  const values = new Set();
  const types = new Set();

  // Local name -> kind, for names this file declares itself or imports from a chunk.
  const localKinds = new Map(declaredKinds(dtsPath));
  for (const m of src.matchAll(/import\s*(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const chunk = exportedKinds(resolve(dirname(dtsPath), m[3].replace(/\.js$/, '.d.ts')));
    for (const spec of splitSpecifiers(m[2])) {
      const kind = m[1] || spec.typeOnly ? 'type' : (chunk.get(spec.local) ?? 'value');
      localKinds.set(spec.name, kind);
    }
  }

  for (const m of src.matchAll(/export\s*(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    // For a re-export list, the chunk's own export list decides value vs type;
    // tsup does not always write `type` in front of re-exported interfaces.
    const source = m[3] ? exportedKinds(resolve(dirname(dtsPath), m[3].replace(/\.js$/, '.d.ts'))) : localKinds;
    for (const spec of splitSpecifiers(m[2])) {
      if (spec.name === 'default') continue;
      const kind = m[1] || spec.typeOnly ? 'type' : (source.get(spec.local) ?? 'value');
      (kind === 'type' ? types : values).add(spec.name);
    }
  }
  for (const m of src.matchAll(
    /^export\s+declare\s+(?:abstract\s+)?(class|function|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    (m[1] === 'interface' || m[1] === 'type' ? types : values).add(m[2]);
  }
  // A class or enum is both a value and a type; if a name landed in both, it is a value.
  for (const n of values) types.delete(n);
  return { values: [...values].sort(), types: [...types].sort() };
}

// "a as b, type C, D" -> [{local:'a', name:'b'}, {local:'C', name:'C', typeOnly:true}, ...]
function splitSpecifiers(list) {
  const out = [];
  for (const raw of list.split(',')) {
    const spec = raw.trim();
    if (!spec) continue;
    const typeOnly = /^type\s+/.test(spec);
    const parts = spec.replace(/^type\s+/, '').split(/\s+as\s+/);
    const local = parts[0].trim();
    const name = parts[parts.length - 1].trim();
    if (name) out.push({ local, name, typeOnly });
  }
  return out;
}

// exported name -> 'value' | 'type' for a chunk file, following its own
// `export { Local as Alias }` list back to the declaration.
function exportedKinds(dtsPath) {
  if (exportsCache.has(dtsPath)) return exportsCache.get(dtsPath);
  const kinds = new Map();
  if (existsSync(dtsPath)) {
    const declared = declaredKinds(dtsPath);
    const src = readFileSync(dtsPath, 'utf8');
    for (const m of src.matchAll(/export\s*(type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
      for (const spec of splitSpecifiers(m[2])) {
        kinds.set(spec.name, m[1] || spec.typeOnly ? 'type' : (declared.get(spec.local) ?? 'value'));
      }
    }
  }
  exportsCache.set(dtsPath, kinds);
  return kinds;
}
const exportsCache = new Map();

// name -> 'value' | 'type' for every top-level declaration in a .d.ts (exported or not).
const kindsCache = new Map();
function declaredKinds(dtsPath) {
  if (kindsCache.has(dtsPath)) return kindsCache.get(dtsPath);
  const kinds = new Map();
  if (existsSync(dtsPath)) {
    const src = readFileSync(dtsPath, 'utf8');
    for (const m of src.matchAll(
      /^(?:export\s+)?declare\s+(?:abstract\s+)?(class|function|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      const kind = m[1] === 'interface' || m[1] === 'type' ? 'type' : 'value';
      // class + interface merging: value wins
      if (kinds.get(m[2]) !== 'value') kinds.set(m[2], kind);
    }
  }
  kindsCache.set(dtsPath, kinds);
  return kinds;
}

function generateApi(current) {
  const pkgPath = join(billingKitDir, 'package.json');
  if (!existsSync(pkgPath)) {
    fail(`billing-kit not found at ${billingKitDir} (set BILLING_KIT_DIR)`);
  }
  const pkg = readJson(pkgPath);
  const exportsMap = {};
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'object' || target === null) continue; // ./sql/*, ./package.json
    const typesEntry = target.types;
    const dts = typeof typesEntry === 'string' ? typesEntry : typesEntry?.import;
    if (!dts) continue;
    const dtsPath = join(billingKitDir, dts);
    if (!existsSync(dtsPath)) {
      fail(`${dtsPath} is missing — build billing-kit first (pnpm build in ${billingKitDir})`);
    }
    const moduleName = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
    exportsMap[moduleName] = exportsOf(dtsPath);
  }

  const symbols = current?.symbols ?? [];
  const problems = [];
  for (const s of symbols) {
    if (s.kind === 'module') {
      if (!exportsMap[s.module]) problems.push(`curated module "${s.name}" points at unknown subpath ${s.module}`);
      continue;
    }
    const mod = exportsMap[s.module];
    if (!mod) {
      problems.push(`curated symbol "${s.name}" names unknown module ${s.module}`);
    } else if (!mod.values.includes(s.name) && !mod.types.includes(s.name)) {
      problems.push(`curated symbol "${s.name}" is no longer exported from ${s.module}`);
    }
  }
  if (problems.length) fail(`api.json curated symbols are stale:\n  - ${problems.join('\n  - ')}`);

  return {
    note:
      current?.note ??
      "Curated reference to billing-kit's public API. Signatures are hand-authored and kept short; the point is discovery, not full type dumps.",
    generatedFrom: {
      package: pkg.name,
      version: pkg.version,
      source: 'dist/**/index.d.ts via scripts/gen-discovery.mjs; `exports` is generated, `symbols` is curated by hand',
    },
    exports: exportsMap,
    symbols,
  };
}

// ---- components.json ---------------------------------------------------------

function generateComponents() {
  const registryPath = join(componentsDir, 'registry.json');
  if (!existsSync(registryPath)) {
    fail(`billing-kit-components registry not found at ${registryPath} (set BILLING_KIT_COMPONENTS_DIR)`);
  }
  const registry = readJson(registryPath);
  return {
    homepage: registry.homepage,
    generatedFrom: {
      registry: registry.name,
      source: 'registry.json via scripts/gen-discovery.mjs (metadata only — never component source)',
    },
    items: (registry.items ?? []).map((i) => ({
      name: i.name,
      title: i.title ?? i.name,
      type: i.type,
      description: i.description ?? '',
      categories: i.categories ?? [],
      registryDependencies: i.registryDependencies ?? [],
      dependencies: i.dependencies ?? [],
    })),
  };
}

// ---- drive ------------------------------------------------------------------

const targets = [];
if (only !== 'components') {
  const current = existsSync(apiPath) ? readJson(apiPath) : undefined;
  targets.push({ path: apiPath, next: stringify(generateApi(current)) });
}
if (only !== 'api') {
  targets.push({ path: componentsPath, next: stringify(generateComponents()) });
}

let stale = 0;
for (const t of targets) {
  const prev = existsSync(t.path) ? readFileSync(t.path, 'utf8') : '';
  if (prev === t.next) {
    process.stderr.write(`gen-discovery: ${t.path.slice(root.length + 1)} up to date\n`);
    continue;
  }
  if (check) {
    stale++;
    process.stderr.write(
      `gen-discovery: ${t.path.slice(root.length + 1)} is STALE — run \`pnpm discovery:gen\` and commit\n`,
    );
    continue;
  }
  writeFileSync(t.path, t.next);
  process.stderr.write(`gen-discovery: wrote ${t.path.slice(root.length + 1)}\n`);
}
if (stale) process.exit(1);
