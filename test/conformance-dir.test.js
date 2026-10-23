// The conformance directory override: SERIALIZE_CONFORMANCE_DIR and
// SERIALIZE_CONFORMANCE_CONTROLS_DIR point the runner at another copy of
// the corpus and the controls' .expected lists (the nightly functional test
// names mas-bandwidth/serialize's own). Unset, the runner reads the vendored
// directories. Resolution logic only: the paths named here are this
// repository's own directories, and nothing is read from anywhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROLS_DIR, CORPUS_DIR, conformanceDir } from './conformance-runner.js';

const VENDORED_CORPUS = fileURLToPath(new URL('../conformance/', import.meta.url));
const VENDORED_CONTROLS = fileURLToPath(new URL('../conformance-controls/', import.meta.url));

test('an unset or empty override is the vendored directory', () => {
  assert.equal(conformanceDir(undefined, VENDORED_CORPUS), VENDORED_CORPUS);
  assert.equal(conformanceDir('', VENDORED_CORPUS), VENDORED_CORPUS);
});

test('an override names the directory, resolved, ending in a separator', () => {
  const elsewhere = resolve('upstream', 'conformance');
  assert.equal(conformanceDir(elsewhere, VENDORED_CORPUS), elsewhere + sep);
  assert.equal(conformanceDir(elsewhere + sep, VENDORED_CORPUS), elsewhere + sep);
  assert.equal(conformanceDir(`upstream${sep}conformance`, VENDORED_CORPUS), elsewhere + sep);
});

test('the runner reads the directories the environment names', async () => {
  const saved = [process.env.SERIALIZE_CONFORMANCE_DIR, process.env.SERIALIZE_CONFORMANCE_CONTROLS_DIR];
  process.env.SERIALIZE_CONFORMANCE_DIR = resolve('upstream', 'conformance');
  process.env.SERIALIZE_CONFORMANCE_CONTROLS_DIR = resolve('upstream', 'conformance-controls');
  try {
    // a fresh module instance, so its constants are read with the override set
    const runner = await import(`./conformance-runner.js?override=${Date.now()}`);
    assert.equal(runner.CORPUS_DIR, resolve('upstream', 'conformance') + sep);
    assert.equal(runner.CONTROLS_DIR, resolve('upstream', 'conformance-controls') + sep);
  } finally {
    for (const [name, value] of [
      ['SERIALIZE_CONFORMANCE_DIR', saved[0]],
      ['SERIALIZE_CONFORMANCE_CONTROLS_DIR', saved[1]],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('without an override the runner reads the vendored directories', () => {
  if (process.env.SERIALIZE_CONFORMANCE_DIR === undefined || process.env.SERIALIZE_CONFORMANCE_DIR === '') {
    assert.equal(CORPUS_DIR, VENDORED_CORPUS);
  }
  if (process.env.SERIALIZE_CONFORMANCE_CONTROLS_DIR === undefined || process.env.SERIALIZE_CONFORMANCE_CONTROLS_DIR === '') {
    assert.equal(CONTROLS_DIR, VENDORED_CONTROLS);
  }
});
