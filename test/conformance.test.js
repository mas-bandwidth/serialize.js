// The shared conformance corpus, run through this port's reader.
//
// conformance/ is a VERBATIM VENDORED COPY of the directory of the same
// name in mas-bandwidth/serialize, vendored the way STANDARD.md is and
// checked against upstream by the same CI job. The vectors are the family's
// one conformance instrument (STANDARD.md, "The shared corpus is the
// conformance instrument"): nothing here regenerates an expectation from
// this port's own codec, so a wrong reading of the standard cannot go green
// by agreeing with itself.
//
// Every vector file is read from disk at test time and every record is run:
// an accepted vector must yield the stated value AND consume the stated
// number of bits; a refused vector must refuse. An `operation` the table
// below does not know is a hard failure, not a skip -- a corpus sync that
// brings in a new operation must surface as red here rather than as silent
// coverage loss.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ReadStream } from '../src/index.js';

const CORPUS_DIR = fileURLToPath(new URL('../conformance/', import.meta.url));

/**
 * Parses one vector file into records (STANDARD.md, "The vector format"):
 * `#` begins a comment, blank lines separate records, and every other line
 * is a key and its value. `param` repeats, once per parameter; `consumed`
 * appears on accepted reads only.
 */
function parseVectors(text, file) {
  const records = [];
  let current = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) {
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1).trim();
    if (current === null) {
      current = { params: new Map(), where: `${file}:${i + 1}` };
      records.push(current);
    }
    switch (key) {
      case 'operation':
      case 'name':
        current[key] = value;
        break;
      case 'param': {
        const equals = value.indexOf('=');
        assert.notEqual(equals, -1, `${current.where}: param needs 'name = value'`);
        current.params.set(value.slice(0, equals).trim(), value.slice(equals + 1).trim());
        break;
      }
      case 'bytes':
        current.bytes = Uint8Array.from(
          value === '' ? [] : value.split(/\s+/).map((pair) => Number.parseInt(pair, 16)),
        );
        break;
      case 'expect':
        if (value === 'refused') {
          current.refused = true;
        } else {
          const equals = value.indexOf('=');
          assert.notEqual(equals, -1, `${current.where}: expect needs 'refused' or 'value = ...'`);
          current.refused = false;
          current.expected = value.slice(equals + 1).trim();
        }
        break;
      case 'consumed':
        current.consumed = Number.parseInt(value, 10);
        break;
      default:
        assert.fail(`${current.where}: unknown key '${key}'`);
    }
  }
  return records;
}

// One entry per operation the corpus covers. Each reads the record's
// parameters, drives the reader once, and returns what came back: the
// vector runner owns the accept/refuse and bit-count assertions, so an
// operation entry never decides whether a vector passed.
const OPERATIONS = {
  int_relative(stream, record) {
    const previous = Number(record.params.get('previous'));
    const ref = {};
    return { accepted: stream.serializeIntRelative(previous, ref), ref, decode: Number };
  },

  int128(stream, record) {
    const min = BigInt(record.params.get('min'));
    const max = BigInt(record.params.get('max'));
    const ref = {};
    return { accepted: stream.serializeInt128(ref, min, max), ref, decode: BigInt };
  },
};

const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.txt')).sort();

test('the corpus is present and every file parses into records', () => {
  assert.ok(files.length > 0, 'conformance/ holds at least one vector file');
  for (const file of files) {
    const records = parseVectors(readFileSync(CORPUS_DIR + file, 'utf8'), file);
    assert.ok(records.length > 0, `${file} holds at least one vector`);
    for (const record of records) {
      assert.ok(record.operation, `${record.where}: no operation`);
      assert.ok(record.name, `${record.where}: no name`);
      assert.ok(record.bytes, `${record.where}: no bytes`);
      assert.notEqual(record.refused, undefined, `${record.where}: no expect`);
      assert.equal(
        record.consumed === undefined,
        record.refused,
        `${record.where}: consumed is stated on accepted reads and only there`,
      );
    }
  }
});

// One node:test case per vector, so a red run names every vector that
// disagrees with the standard rather than stopping at the first.
for (const file of files) {
  for (const record of parseVectors(readFileSync(CORPUS_DIR + file, 'utf8'), file)) {
    test(`conformance/${file}: ${record.name}`, () => {
      const run = OPERATIONS[record.operation];
      assert.ok(run, `${record.where}: no runner for operation '${record.operation}'`);

      const stream = new ReadStream(record.bytes);
      const sentinel = Symbol('untouched');
      const { accepted, ref, decode } = run(stream, record);

      if (record.refused) {
        assert.equal(accepted, false, 'must be refused');
        assert.notEqual(stream.error, null, 'a refusal latches an error');
        // the refusal is terminal and non-mutating: nothing was written to
        // the destination, and the stream refuses everything after it
        assert.equal(ref.value, undefined, 'a refusal leaves the destination unwritten');
        const after = { value: sentinel };
        assert.equal(stream.serializeBits(after, 1), false, 'a refusal is terminal');
        assert.equal(after.value, sentinel, 'a read after a refusal writes nothing');
        return;
      }

      assert.equal(accepted, true, `must be accepted (error ${stream.error})`);
      assert.equal(ref.value, decode(record.expected), 'decodes its value');
      assert.equal(stream.bitsProcessed(), record.consumed, 'consumes its stated bits');
    });
  }
}
