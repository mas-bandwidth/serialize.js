// Smoke test: the package entry point loads as an ES module under node:test.
// Exists so the harness is proven green from the first commit; real tests
// arrive with the bitpacker.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('package entry point loads', async () => {
  const mod = await import('../src/index.js');
  assert.ok(mod, 'module namespace object exists');
});
