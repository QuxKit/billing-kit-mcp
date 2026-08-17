// The discovery snapshots the server bundles must agree with what they were
// generated from. This runs the generator in --check mode against the sibling
// checkouts when they are present, and always checks the committed shape.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = JSON.parse(readFileSync(resolve(root, 'src/data/api.json'), 'utf8'));
const components = JSON.parse(readFileSync(resolve(root, 'src/data/components.json'), 'utf8'));

test('api.json: every curated symbol names a real generated export', () => {
  assert.ok(Object.keys(api.exports).length >= 1);
  for (const s of api.symbols) {
    if (s.kind === 'module') {
      assert.ok(api.exports[s.module], `${s.name}: unknown subpath ${s.module}`);
      continue;
    }
    const mod = api.exports[s.module];
    assert.ok(mod, `${s.name}: unknown module ${s.module}`);
    assert.ok(mod.values.includes(s.name) || mod.types.includes(s.name), `${s.name} not exported from ${s.module}`);
  }
});

test('components.json: metadata only, never source', () => {
  assert.ok(components.items.length > 0);
  for (const c of components.items) {
    assert.deepEqual(Object.keys(c).sort(), [
      'categories',
      'dependencies',
      'description',
      'name',
      'registryDependencies',
      'title',
      'type',
    ]);
  }
});

test('discovery:check passes against the sibling checkouts', (t) => {
  const bk = resolve(root, process.env.BILLING_KIT_DIR ?? '../billing-kit');
  const bkc = resolve(root, process.env.BILLING_KIT_COMPONENTS_DIR ?? '../billing-kit-components');
  const have = {
    api: existsSync(resolve(bk, 'dist/index.d.ts')),
    components: existsSync(resolve(bkc, 'registry.json')),
  };
  if (!have.api && !have.components) {
    if (process.env.REQUIRE_DISCOVERY_SOURCES)
      throw new Error('sibling checkouts missing and REQUIRE_DISCOVERY_SOURCES set');
    t.skip('no sibling checkouts (billing-kit / billing-kit-components) next to this repo');
    return;
  }
  const only = have.api && have.components ? [] : [`--only=${have.api ? 'api' : 'components'}`];
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/gen-discovery.mjs'), '--check', ...only], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
});
