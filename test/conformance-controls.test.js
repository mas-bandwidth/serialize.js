// The negative controls: proof that the conformance runner responds.
//
// STANDARD.md, "A gate nobody has seen go red is a claim, not a
// measurement": a corpus file whose operation has no runner must be
// rejected rather than skipped, and, for each refusal rule, a reader with
// that one rule deleted, run against the real corpus, must fail EXACTLY the
// vectors conformance-controls/<rule>.expected names and no others. The
// .expected lists are vendored verbatim from mas-bandwidth/serialize with
// the corpus; they are the oracle, never regenerated from this port.
//
// Each sabotage below works the way the reference's CMakeLists.txt does: it
// copies src/ into .controls/<rule>/ (inside the repository, gitignored),
// replaces one line of the library -- the NEEDLE -- with a PATCH that keeps
// the line valid and reading every variable it read, adds a conjunct that is
// false exactly when the rule would have fired, imports the copy and runs
// the whole corpus through the shared runner. A needle that no longer
// matches is a failure, not a silent no-op: a control that has quietly
// stopped sabotaging anything is worse than no control at all.
//
// Where the reference keeps a rule in one place and this port keeps it in
// two -- the ranged int's rules also guard int_relative's bounded tiers,
// which serialize.h serializes through serialize_int and this port decodes
// directly -- the control patches both, so the rule deleted is the same
// rule the .expected list names.
//
// This port's UTF-8 validation is the platform's fatal TextDecoder, which
// has no separable encoded-surrogate clause, so string-utf8-surrogate
// deletes that one clause the only way it can: a payload holding an encoded
// surrogate lead (ED A0 to ED BF) is decoded non-fatally, so that clause
// alone stops refusing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MeasureStream, ReadStream, WriteStream } from '../src/index.js';
import {
  CONTROLS_DIR,
  loadCorpus,
  loadExpectedFailures,
  makeRunner,
  parseVectors,
} from './conformance-runner.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const SCRATCH_DIR = fileURLToPath(new URL('../.controls/', import.meta.url));
const MARK = ' // NEGATIVE CONTROL: this rule is deleted on purpose';

const CONTROLS = [
  {
    name: 'align-padding',
    rule: 'readers must verify that the alignment padding bits are zero',
    patches: [{
      file: 'bitpacker.js',
      needle: '      if (value !== 0) {',
      patch: `      if (value !== 0 && value < 0) {${MARK}`,
    }],
  },
  {
    name: 'ranged-reconstruction',
    rule: 'a ranged int decodes to its offset plus min',
    patches: [
      {
        file: 'streams.js',
        needle: '    ref.value = (unsigned + (min >>> 0)) | 0;',
        patch: `    ref.value = unsigned | 0;${MARK}`,
      },
      {
        file: 'streams.js',
        needle: '          difference = RELATIVE_TIER_BASE[tier] + offset;',
        patch: `          difference = offset;${MARK}`,
      },
    ],
  },
  {
    name: 'ranged-range',
    rule: 'a ranged int whose offset is past the span is refused',
    patches: [
      {
        file: 'streams.js',
        needle: '    if (unsigned > ((max >>> 0) - (min >>> 0)) >>> 0) {',
        patch: `    if (unsigned > ((max >>> 0) - (min >>> 0)) >>> 0 && unsigned < 0) {${MARK}`,
      },
      {
        file: 'streams.js',
        needle: '          if (offset > RELATIVE_TIER_RANGE[tier]) {',
        patch: `          if (offset > RELATIVE_TIER_RANGE[tier] && offset < 0) {${MARK}`,
      },
    ],
  },
  {
    name: 'fixed-degenerate-terminal',
    rule: 'every read consults the failure state, zero bit reads included',
    patches: [{
      file: 'streams.js',
      needle: [
        '    const params = fixedPointParams(integerBits, fractionBits, min, max);',
        '    if (this.#error !== SerializeError.None) {',
        '      return false;',
        '    }',
        '    if (!params.wide) {',
        '      if (params.bits === 0) {',
        '        ref.value = params.rawMin;',
      ].join('\n'),
      patch: [
        '    const params = fixedPointParams(integerBits, fractionBits, min, max);',
        `    if (this.#error !== SerializeError.None && params.bits !== 0) {${MARK}`,
        '      return false;',
        '    }',
        '    if (!params.wide) {',
        '      if (params.bits === 0) {',
        '        ref.value = params.rawMin;',
      ].join('\n'),
    }],
  },
  {
    name: 'float-finite',
    rule: 'a float read refuses NaN and the infinities',
    patches: [{
      file: 'streams.js',
      needle: '    if (!floatBitsAreFinite(bits)) {\n      return this.#fail(SerializeError.NonFiniteFloat);\n    }\n    ref.value',
      patch: `    if (!floatBitsAreFinite(bits) && bits === 0) {${MARK}\n      return this.#fail(SerializeError.NonFiniteFloat);\n    }\n    ref.value`,
    }],
  },
  {
    name: 'double-finite',
    rule: 'a double read refuses NaN and the infinities',
    patches: [{
      file: 'streams.js',
      needle: '    if (!doubleHighBitsAreFinite(high)) {\n      return this.#fail(SerializeError.NonFiniteFloat);\n    }\n    FLOAT_SCRATCH.setUint32(0, low, true);',
      patch: `    if (!doubleHighBitsAreFinite(high) && high === 0) {${MARK}\n      return this.#fail(SerializeError.NonFiniteFloat);\n    }\n    FLOAT_SCRATCH.setUint32(0, low, true);`,
    }],
  },
  {
    name: 'compressed-float-finite',
    rule: 'a compressed float decode that is not finite is refused',
    patches: [{
      file: 'streams.js',
      needle: '    if (!Number.isFinite(decoded)) {',
      patch: `    if (!Number.isFinite(decoded) && decoded === 0) {${MARK}`,
    }],
  },
  {
    name: 'end-trailing-data',
    rule: 'an end refuses a whole byte after the object',
    // without the rule the end examines only the bits below the next byte
    // boundary, as the reference's sabotaged end does, so a stream with
    // whole bytes left over passes when those bits are zero
    patches: [{
      file: 'streams.js',
      needle: '    const remaining = this.#reader.bitsRemaining();\n    if (remaining >= 8) {',
      patch: `    const remaining = this.#reader.bitsRemaining() % 8;\n    if (remaining >= 8) {${MARK}`,
    }],
  },
  {
    name: 'end-padding',
    rule: 'an end refuses non-zero padding in the final byte',
    patches: [{
      file: 'streams.js',
      needle: '      if (padding !== 0) {',
      patch: `      if (padding !== 0 && padding < 0) {${MARK}`,
    }],
  },
  {
    name: 'int-relative-canonical',
    rule: 'the absolute tier refuses a difference a bounded tier carries',
    patches: [{
      file: 'streams.js',
      needle: '    if (current - previous <= RELATIVE_BOUNDED_MAX) {',
      patch: `    if (current - previous <= RELATIVE_BOUNDED_MAX && current < 0) {${MARK}`,
    }],
  },
  {
    name: 'string-embedded-nul',
    rule: 'a string read refuses a zero byte among its payload',
    patches: [{
      file: 'streams.js',
      needle: '      if (payload[i] === 0) {',
      patch: `      if (payload[i] === 0 && i < 0) {${MARK}`,
    }],
  },
  {
    name: 'string-utf8',
    rule: 'a string read refuses a payload that is not well formed UTF-8',
    // the validation IS the fatal decoder: without it, the decoder hands
    // back U+FFFD where the payload is malformed
    patches: [{
      file: 'streams.js',
      needle: "const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });",
      patch: `const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });${MARK}`,
    }],
  },
  {
    name: 'string-utf8-surrogate',
    rule: 'a string read refuses an encoded surrogate code point',
    patches: [{
      file: 'streams.js',
      needle: '      decoded = UTF8_DECODER.decode(payload);',
      patch: '      decoded = (payload.some((byte, i) => byte === 0xed && payload[i + 1] >= 0xa0 && payload[i + 1] <= 0xbf) ' +
        '? new TextDecoder() : UTF8_DECODER).decode(payload); // NEGATIVE CONTROL: this clause is deleted on purpose',
    }],
  },
  {
    name: 'int64-through-double',
    rule: 'a 64 bit value is carried exactly, never through a double',
    // as a port backed by a double would: every integer up to 2^53
    // survives, and the wide vectors past it do not
    patches: [{
      file: 'streams.js',
      needle: '    ref.value = BigInt.asIntN(64, unsigned + BigInt.asUintN(64, min));',
      patch: '    { const throughDouble = Number(BigInt.asIntN(64, unsigned + BigInt.asUintN(64, min))); ' +
        'ref.value = throughDouble >= 9223372036854775807 ? INT64_MAX : BigInt(throughDouble); } ' +
        '// NEGATIVE CONTROL: the value goes through a double on purpose',
    }],
  },
  {
    name: 'wrong-reason',
    rule: 'a refusal names the rule that refused it',
    // this reader refuses every stream the real one refuses, and names the
    // wrong rule for one of them
    patches: [{
      file: 'streams.js',
      needle: '        return this.#fail(SerializeError.EmbeddedNul);',
      patch: '        return this.#fail(SerializeError.InvalidUtf8); // NEGATIVE CONTROL: the wrong reason on purpose',
    }],
  },
];

/** The number of times needle occurs in text. */
function occurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

/** Writes src/ with the control's patches applied and imports the copy. */
async function sabotagedStreams(control) {
  const dir = `${SCRATCH_DIR}${control.name}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const sources = new Map();
  for (const file of readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'))) {
    // a checkout with CRLF line endings (Windows) still matches the needles
    sources.set(file, readFileSync(SRC_DIR + file, 'utf8').replace(/\r\n/g, '\n'));
  }
  for (const { file, needle, patch } of control.patches) {
    const text = sources.get(file);
    assert.equal(
      occurrences(text, needle),
      1,
      `control '${control.name}' must find its needle exactly once in src/${file}: the line that ` +
        `deletes '${control.rule}' has moved or changed. Update the needle; do not delete the control.`,
    );
    sources.set(file, text.replace(needle, () => patch));
  }
  for (const [file, text] of sources) {
    writeFileSync(dir + file, text);
  }
  return import(pathToFileURL(`${dir}index.js`).href);
}

/** The names of the corpus vectors a runner over these streams fails. */
function failingVectors(streams) {
  const runVector = makeRunner(streams);
  const failing = [];
  for (const [, records] of loadCorpus()) {
    for (const record of records) {
      try {
        runVector(record);
      } catch {
        failing.push(record.name);
      }
    }
  }
  return failing;
}

test('control: the unmodified library fails no vector', () => {
  assert.deepEqual(failingVectors({ ReadStream, WriteStream, MeasureStream }), []);
});

test('control: unknown-operation -- a vector whose operation has no runner is red, never skipped', () => {
  const text = readFileSync(`${CONTROLS_DIR}unknown-operation.txt`, 'utf8');
  const records = parseVectors(text, 'unknown-operation.txt');
  assert.equal(records.length, 1);
  const runVector = makeRunner({ ReadStream, WriteStream, MeasureStream });
  assert.throws(() => runVector(records[0]), /no runner/);
});

test('control: a refused vector stating no reason, or one outside the closed list, is malformed', () => {
  const vector = (expect) => `operation bits\nname control-reason\nparam bits = 8\nbytes\nexpect ${expect}\n`;
  assert.throws(() => parseVectors(vector('refused'), 'control.txt'), /closed list/);
  assert.throws(() => parseVectors(vector('refused overflow'), 'control.txt'), /closed list/);
  assert.equal(parseVectors(vector('refused past_end'), 'control.txt')[0].reason, 'past_end');
});

for (const control of CONTROLS) {
  test(`control: ${control.name} -- ${control.rule}`, async () => {
    const expected = loadExpectedFailures(control.name);
    assert.ok(expected.length > 0, `conformance-controls/${control.name}.expected names the vectors its rule owns`);
    const failing = failingVectors(await sabotagedStreams(control));
    assert.deepEqual(
      [...failing].sort(),
      [...expected].sort(),
      `deleting '${control.rule}' must fail exactly the vectors conformance-controls/${control.name}.expected names`,
    );
  });
}
