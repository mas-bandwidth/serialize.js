// Smoke test: the package entry point loads as an ES module under node:test.
// Exists so the harness is proven green from the first commit; real tests
// arrive with the bitpacker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('package entry point loads', async () => {
  const mod = await import('../src/index.js');
  assert.ok(mod, 'module namespace object exists');
});

test('mode selection supports runtime environments and bundler define replacement', async (t) => {
  const moduleURL = new URL('../src/mode.js', import.meta.url);
  for (const [name, setup, expected] of [
    ['no process', 'delete globalThis.process;', false],
    ['null process', 'globalThis.process = null;', false],
    ['no environment', 'globalThis.process = {};', false],
    ['development', "globalThis.process = { env: { NODE_ENV: 'development' } };", false],
    ['production', "globalThis.process = { env: { NODE_ENV: 'production' } };", true],
  ]) {
    await t.test(name, () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        ${setup}
        const { PRODUCTION } = await import(${JSON.stringify(moduleURL.href)});
        if (PRODUCTION !== ${expected}) throw new Error('unexpected mode');
      `], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    });
  }

  await t.test('bundled define replacement without process global', () => {
    const source = readFileSync(moduleURL, 'utf8');
    assert.ok(source.includes('process.env.NODE_ENV'), 'literal process.env.NODE_ENV must remain for bundler define replacement');
    const definedSource = source.replaceAll('process.env.NODE_ENV', JSON.stringify('production'));
    const dataURL = `data:text/javascript;base64,${Buffer.from(definedSource, 'utf8').toString('base64')}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      delete globalThis.process;
      const { PRODUCTION } = await import(${JSON.stringify(dataURL)});
      if (PRODUCTION !== true) throw new Error('unexpected mode');
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
});
