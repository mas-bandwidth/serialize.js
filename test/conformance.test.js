// The shared conformance corpus, run through this port's reader, writer and
// measure.
//
// conformance/ is a VERBATIM VENDORED COPY of the directory of the same
// name in mas-bandwidth/serialize, vendored the way STANDARD.md is and
// checked against upstream by the same CI job. The vectors are the family's
// one conformance instrument (STANDARD.md, "The shared corpus is the
// conformance instrument"): nothing here regenerates an expectation from
// this port's own codec, so a wrong reading of the standard cannot go green
// by agreeing with itself. The runner itself lives in conformance-runner.js,
// shared with the negative controls that prove it responds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeasureStream, ReadStream, WriteStream } from '../src/index.js';
import { loadCorpus, makeRunner } from './conformance-runner.js';

const corpus = loadCorpus();
const runVector = makeRunner({ ReadStream, WriteStream, MeasureStream });

test('the corpus is present and every file parses into records', () => {
  assert.ok(corpus.length > 0, 'conformance/ holds at least one vector file');
  for (const [file, records] of corpus) {
    assert.ok(records.length > 0, `${file} holds at least one vector`);
    for (const record of records) {
      assert.ok(record.operation, `${record.where}: no operation`);
      assert.ok(record.name, `${record.where}: no name`);
      assert.ok(record.bytes, `${record.where}: no bytes`);
      assert.notEqual(record.expectKind, undefined, `${record.where}: no expect`);
      assert.equal(
        record.consumed === undefined,
        record.expectKind === 'refused',
        `${record.where}: consumed is stated on accepted reads and only there`,
      );
    }
  }
});

test('vector names are unique across the corpus', () => {
  const seen = new Map();
  for (const [, records] of corpus) {
    for (const record of records) {
      assert.ok(!seen.has(record.name), `${record.where}: '${record.name}' is also ${seen.get(record.name)}`);
      seen.set(record.name, record.where);
    }
  }
});

// One node:test case per vector, so a red run names every vector that
// disagrees with the standard rather than stopping at the first.
for (const [file, records] of corpus) {
  for (const record of records) {
    test(`conformance/${file}: ${record.name}`, () => runVector(record));
  }
}
