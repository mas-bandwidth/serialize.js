// The shared conformance corpus, run through this port's reader, writer and
// measure.
//
// conformance/ is a VERBATIM VENDORED COPY of the directory of the same
// name in mas-bandwidth/serialize, vendored the way STANDARD.md is and
// checked against upstream by the same CI job. The vectors are the family's
// one conformance instrument (STANDARD.md, "The shared corpus is the
// conformance instrument"): nothing here regenerates an expectation from
// this port's own codec, so a wrong reading of the standard cannot go green
// by agreeing with itself.
//
// THE DIRECTORY IS DISCOVERED, NEVER NAMED. Every `.txt` file in
// conformance/ is enumerated at run time and every record in it is run. An
// empty directory fails the run, because an empty corpus is a broken
// checkout and not a pass. A vector whose operation, parameter or step
// spelling this runner has no code for FAILS: an operation nobody
// implemented must be red rather than skipped.
//
// ONE STEP MACHINE drives both the single-operation files and the sequence,
// object and message files. A single-operation vector is a one or two step
// sequence built from the record's own parameters -- the second step exists
// where the record carries `preceding_bits`, which places the stream at a
// non-zero bit index before the operation under test -- so there is exactly
// one execution path and the sequence files cannot drift away from the
// operation files.
//
// What a runner checks, from STANDARD.md, "What a runner checks":
//
//   - an ACCEPTED vector decodes the stated value and consumes the stated
//     bits;
//   - a vector carrying `writer = canonical` additionally re-emits those
//     values through the write stream and matches the whole stream byte for
//     byte, flush included, which is where the trailing-bits obligation
//     bites;
//   - a vector carrying `measure_at_least` additionally runs the measure
//     stream over the same steps and requires at least that many bits, a
//     floor and never an equality;
//   - a REFUSED vector is refused, leaves the caller's scalar destination
//     exactly as it was, and leaves the stream terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MeasureStream, ReadStream, WriteStream } from '../src/index.js';

const CORPUS_DIR = fileURLToPath(new URL('../conformance/', import.meta.url));

// The buffer contract. This port's reader prices its windows inside the
// buffer and requires no slack past the data (src/streams.js, ReadStream),
// so the stream handed to it is exactly the vector's bytes. The backing
// allocation still carries slack filled with a NON-ZERO pattern, so a decode
// that strayed past the end could not pass by reading zeros.
const SLACK_BYTES = 8;
const SLACK_FILL = 0xa5;

// The destination sentinel. JavaScript destinations are `{ value }` holders
// with no declared width, so a Symbol is the sentinel that no narrowing can
// forge and no library assignment can reproduce: after a refusal the holder
// still carries it, or the read wrote to a destination it must have left
// alone.
const UNTOUCHED = Symbol('untouched');

const UTF8 = new TextEncoder();

// Reinterpretation scratch, used only to read a decoded number's IEEE-754
// bits. Nothing here encodes or decodes anything: STANDARD.md requires float
// and double expectations to be compared as BIT PATTERNS, and this is how a
// JavaScript number's pattern is observed.
const SCRATCH = new DataView(new ArrayBuffer(8));

/**
 * Parses a vector number to its 128-bit two's complement pattern. Numbers
 * are signed decimal or `0x` hexadecimal and a parser must accept values up
 * to 128 bits wide (STANDARD.md, "Lexical rules"), which is why they travel
 * as BigInt: a JavaScript number is a double and cannot hold them.
 */
function parseNumber(text, where) {
  let body = text;
  let negative = false;
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(body)) {
    throw new Error(`${where}: '${text}' is not a signed decimal or 0x hexadecimal number`);
  }
  const value = BigInt(body.startsWith('0X') ? `0x${body.slice(2)}` : body);
  return BigInt.asIntN(128, negative ? -value : value);
}

/**
 * Parses one vector file into records (STANDARD.md, "The vector format"):
 * `#` begins a comment at the START of a line and nowhere else, blank lines
 * separate records, and every other line is a key and its value. `param`
 * repeats, once per parameter, and `param step` repeats once per step of a
 * sequence.
 */
function parseVectors(text, file) {
  const records = [];
  let current = null;
  const lines = text.split('\n');

  const finish = () => {
    if (current !== null && current.operation !== undefined) {
      records.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('#')) {
      continue;
    }
    const line = raw.trim();
    if (line === '') {
      finish();
      continue;
    }
    if (current === null) {
      current = { params: new Map(), steps: [], where: `${file}:${i + 1}` };
    }
    const where = `${file}:${i + 1}`;
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1).trim();
    switch (key) {
      case 'operation':
      case 'name':
        current[key] = value;
        break;
      case 'param': {
        const equals = value.indexOf('=');
        assert.notEqual(equals, -1, `${where}: param needs 'name = value'`);
        const paramName = value.slice(0, equals).trim();
        const paramValue = value.slice(equals + 1).trim();
        if (paramName === 'step') {
          current.steps.push(paramValue);
        } else {
          current.params.set(paramName, paramValue);
        }
        break;
      }
      case 'bytes':
        current.bytes = Uint8Array.from(
          value === '' ? [] : value.split(/\s+/).map((pair) => Number.parseInt(pair, 16)),
        );
        break;
      case 'expect':
        if (value === 'refused') {
          current.expectKind = 'refused';
        } else {
          const equals = value.indexOf('=');
          assert.notEqual(equals, -1, `${where}: expect needs 'refused' or '<kind> = ...'`);
          const kind = value.slice(0, equals).trim();
          assert.ok(kind === 'value' || kind === 'bits', `${where}: unknown expect kind '${kind}'`);
          current.expectKind = kind;
          current.expected = value.slice(equals + 1).trim();
        }
        break;
      case 'consumed':
        current.consumed = Number(parseNumber(value, where));
        break;
      case 'measure_at_least':
        current.measureAtLeast = Number(parseNumber(value, where));
        break;
      case 'writer':
        assert.equal(value, 'canonical', `${where}: unknown writer mode '${value}'`);
        current.writerCanonical = true;
        break;
      default:
        assert.fail(`${where}: unknown key '${key}'`);
    }
  }
  finish();
  return records;
}

// Which operation takes which parameter. A parameter this runner does not
// understand is a FAILURE and not a silent default: a vector whose
// declaration is not the one being exercised proves nothing, and a corpus
// that grows a parameter must grow a runner to read it.
const OPERATION_PARAMS = {
  preceding_bits: ['align', 'bytes'],
  bits: ['bits'],
  count: ['bytes'],
  buffer_size: ['string', 'wstring'],
  previous: ['int_relative'],
  res: ['compressed_float'],
  integer_bits: ['fixed'],
  fraction_bits: ['fixed'],
  min: ['int', 'int64', 'int128', 'fixed', 'compressed_float'],
  max: ['int', 'int64', 'int128', 'fixed', 'compressed_float'],
};

// The value kinds. A bit-pattern kind and a number kind both compare as a
// 128-bit two's complement PATTERN, so a hexadecimal expectation and its
// decimal twin are one expectation and nothing goes through a float. The
// rest have the textual spellings the corpus states directly.
const PATTERN_KINDS = new Set(['bits', 'uint128', 'float', 'double', 'compressed_float']);
const NUMBER_KINDS = new Set(['int', 'int64', 'int128', 'int_relative', 'fixed']);

// The destinations "a refused primitive read must leave its destination
// unwritten" reaches. STANDARD.md leaves a read into a caller-owned buffer
// -- bytes, string and wstring -- UNSPECIFIED after a refusal, in as many
// words, so those kinds are not checked here.
const SCALAR_KINDS = new Set([...PATTERN_KINDS, ...NUMBER_KINDS, 'bool']);

/** Builds a step from a `param step` spelling, per the head of sequence.txt. */
function stepFromWords(text, where) {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const number = (index) => parseNumber(words[index], where);
  const shape = `${words[0]}/${words.length}`;
  switch (shape) {
    case 'bits/2':
      return { kind: 'bits', bits: Number(number(1)) };
    case 'bool/1':
      return { kind: 'bool' };
    case 'object/2':
      return { kind: 'object', count: Number(number(1)) };
    case 'align/1':
      return { kind: 'align' };
    case 'float/1':
      return { kind: 'float' };
    case 'double/1':
      return { kind: 'double' };
    case 'uint128/1':
      return { kind: 'uint128' };
    case 'int_relative/2':
      return { kind: 'int_relative', previous: Number(number(1)) };
    case 'compressed_float/4': {
      const float = (index) => {
        const value = Number(words[index]);
        assert.ok(Number.isFinite(value), `${where}: step '${text}' states a non-finite bound`);
        return value;
      };
      return { kind: 'compressed_float', min: float(1), max: float(2), res: float(3) };
    }
    case 'bytes/2':
      return { kind: 'bytes', count: Number(number(1)) };
    case 'string/2':
      return { kind: 'string', bufferSize: Number(number(1)) };
    case 'wstring/2':
      return { kind: 'wstring', bufferSize: Number(number(1)) };
    case 'int/3':
      return { kind: 'int', min: Number(number(1)), max: Number(number(2)) };
    case 'int64/3':
    case 'int128/3':
      return { kind: words[0], min: number(1), max: number(2) };
    case 'fixed/5':
      return fixedStep(Number(number(1)), Number(number(2)), number(3), number(4));
    default:
      throw new Error(`${where}: no runner for step '${text}'`);
  }
}

/**
 * A fixed point step. The Q format's bounds are stated in WHOLE units and
 * this port takes them at the storage width's own domain: Numbers for
 * storage of 32 bits or fewer, BigInts for 64 and 128 bit storage. Nothing
 * here is a table of declarations -- serializeFixed takes the declaration as
 * runtime arguments, so every Q format the corpus states is drivable.
 */
function fixedStep(integerBits, fractionBits, min, max) {
  const wide = integerBits + fractionBits > 32;
  return {
    kind: 'fixed',
    integerBits,
    fractionBits,
    min: wide ? min : Number(min),
    max: wide ? max : Number(max),
  };
}

/**
 * Builds the step list for a vector. A single-operation vector becomes a one
 * or two step sequence: the operations whose interesting behavior only
 * exists at a non-zero bit index take a `preceding_bits` parameter, which
 * becomes a leading `bits` step.
 */
function buildSteps(record) {
  const where = record.where;
  const param = (name) => {
    const value = record.params.get(name);
    assert.notEqual(value, undefined, `${where}: operation '${record.operation}' needs '${name}'`);
    return value;
  };
  const numberParam = (name) => parseNumber(param(name), where);
  const floatParam = (name) => {
    const value = Number(param(name));
    assert.ok(Number.isFinite(value), `${where}: '${name}' is not a float32 value`);
    return value;
  };

  if (record.operation === 'sequence') {
    const steps = record.steps.map((text) => stepFromWords(text, where));
    assert.ok(steps.length > 0, `${where}: a sequence states at least one step`);
    return steps;
  }

  assert.equal(record.steps.length, 0, `${where}: steps are only meaningful on a sequence`);

  const steps = [];
  const precedingBits = record.params.has('preceding_bits')
    ? Number(numberParam('preceding_bits'))
    : 0;
  if (precedingBits > 0) {
    steps.push({ kind: 'bits', bits: precedingBits });
  }

  switch (record.operation) {
    case 'bits':
      steps.push({ kind: 'bits', bits: Number(numberParam('bits')) });
      break;
    case 'bool':
    case 'uint128':
    case 'align':
    case 'float':
    case 'double':
      steps.push({ kind: record.operation });
      break;
    case 'int':
      steps.push({ kind: 'int', min: Number(numberParam('min')), max: Number(numberParam('max')) });
      break;
    case 'int64':
    case 'int128':
      steps.push({ kind: record.operation, min: numberParam('min'), max: numberParam('max') });
      break;
    case 'int_relative':
      steps.push({ kind: 'int_relative', previous: Number(numberParam('previous')) });
      break;
    case 'compressed_float':
      steps.push({
        kind: 'compressed_float',
        min: floatParam('min'),
        max: floatParam('max'),
        res: floatParam('res'),
      });
      break;
    case 'bytes':
      steps.push({ kind: 'bytes', count: Number(numberParam('count')) });
      break;
    case 'string':
    case 'wstring':
      steps.push({ kind: record.operation, bufferSize: Number(numberParam('buffer_size')) });
      break;
    case 'fixed':
      steps.push(fixedStep(
        Number(numberParam('integer_bits')),
        Number(numberParam('fraction_bits')),
        numberParam('min'),
        numberParam('max'),
      ));
      break;
    default:
      assert.fail(`${where}: no runner for operation '${record.operation}'`);
  }
  return steps;
}

/** The number of entries in the flat step list one top-level step owns. */
function stepSpan(steps, index) {
  return steps[index].kind === 'object' ? 1 + steps[index].count : 1;
}

/**
 * Runs one step against any stream: the same call a consumer makes, so the
 * vectors exercise the library's own surface. Wide values travel as BigInt
 * because a JavaScript number is a double: every 64 and 128 bit operation
 * has a BigInt destination, and `bits` splits at 32, where this port's two
 * entry points do.
 */
function runStep(stream, step) {
  const ref = step.ref;
  switch (step.kind) {
    case 'bits':
      return step.bits <= 32 ? stream.serializeBits(ref, step.bits) : stream.serializeBits64(ref, step.bits);
    case 'bool':
      return stream.serializeBool(ref);
    case 'uint128':
      return stream.serializeUint128(ref);
    case 'align':
      return stream.serializeAlign();
    case 'int':
      return stream.serializeInt(ref, step.min, step.max);
    case 'int64':
      return stream.serializeInt64(ref, step.min, step.max);
    case 'int128':
      return stream.serializeInt128(ref, step.min, step.max);
    case 'int_relative':
      return stream.serializeIntRelative(step.previous, ref);
    case 'float':
      return stream.serializeFloat(ref);
    case 'double':
      return stream.serializeDouble(ref);
    case 'compressed_float':
      return stream.serializeCompressedFloat(ref, step.min, step.max, step.res);
    case 'bytes':
      return stream.serializeBytes(step.buffer);
    case 'string':
      return stream.serializeString(ref, step.bufferSize);
    case 'wstring':
      return stream.serializeWideString(ref, step.bufferSize);
    case 'fixed':
      return stream.serializeFixed(ref, step.integerBits, step.fractionBits, step.min, step.max);
    default:
      throw new Error(`no runner for step kind '${step.kind}'`);
  }
}

/**
 * STANDARD.md, "object": serialize_object invokes the object's own
 * serialize function inline and contributes NO BYTES OF ITS OWN -- it is
 * composition, not an encoding, with no framing, length prefix or alignment
 * inserted around it. JavaScript needs no macro for that: a nested object IS
 * a serialize function returning a bool, exactly as USAGE.md composes one,
 * and a refusal inside it propagates out through the return value.
 */
function serializeNestedObject(stream, steps) {
  return runSteps(stream, steps);
}

/**
 * Runs a flat step list, stopping at the first refusal and naming the step
 * it stopped on: `stoppedAt` is the top-level index, and `failedStep` is the
 * step whose destination the non-mutation rule reaches, which for a nested
 * object is a step inside it.
 */
function runSteps(stream, steps) {
  for (let i = 0; i < steps.length; ) {
    const step = steps[i];
    if (step.kind === 'object') {
      const nested = serializeNestedObject(stream, steps.slice(i + 1, i + 1 + step.count));
      if (!nested.ok) {
        return { ok: false, stoppedAt: i, failedStep: nested.failedStep };
      }
      i += 1 + step.count;
      continue;
    }
    if (!runStep(stream, step)) {
      return { ok: false, stoppedAt: i, failedStep: step };
    }
    i += 1;
  }
  return { ok: true, stoppedAt: -1, failedStep: null };
}

/** The 128-bit two's complement pattern of a step's decoded value. */
function stepPattern(step) {
  const value = step.ref.value;
  switch (step.kind) {
    case 'bits':
    case 'uint128':
      return BigInt(value);
    case 'float':
    case 'compressed_float':
      return float32Pattern(value);
    case 'double':
      SCRATCH.setFloat64(0, value, true);
      return SCRATCH.getBigUint64(0, true);
    default:
      return BigInt.asUintN(128, BigInt(value));
  }
}

/**
 * The IEEE-754 single-precision bits of a decoded float. A float32 travels
 * through this port as a JavaScript number, so a non-NaN value's pattern is
 * the hardware narrowing, and a NaN's payload rides the top 23 bits of the
 * number's float64 mantissa, where serializeFloat's bit-transparent read
 * placed it. This is reinterpretation and not a codec: the read path is what
 * the vectors judge, and this inverse is independent of it.
 */
function float32Pattern(value) {
  if (!Number.isNaN(value)) {
    SCRATCH.setFloat32(0, value, true);
    return BigInt(SCRATCH.getUint32(0, true));
  }
  SCRATCH.setFloat64(0, value, true);
  const bits = SCRATCH.getBigUint64(0, true);
  return ((bits >> 63n) << 31n) | 0x7f800000n | ((bits >> 29n) & 0x7fffffn);
}

function toHexBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Renders a step's decoded value the way the corpus spells it. */
function renderStepValue(step) {
  if (PATTERN_KINDS.has(step.kind) || NUMBER_KINDS.has(step.kind)) {
    return `0x${stepPattern(step).toString(16).toUpperCase().padStart(32, '0')}`;
  }
  switch (step.kind) {
    case 'object':
    case 'align':
      // neither has a value of its own; for align the corpus states the
      // padding it consumed, which a conforming read always finds zero
      return '0';
    case 'bool':
      return step.ref.value ? 'true' : 'false';
    case 'bytes':
      return toHexBytes(step.buffer);
    case 'string':
      return toHexBytes(UTF8.encode(step.ref.value));
    case 'wstring': {
      // per CODE UNIT, never per code point: a surrogate pair is two
      // transmitted groups and the corpus states both
      const text = step.ref.value;
      const units = [];
      for (let i = 0; i < text.length; i++) {
        units.push(text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase());
      }
      return units.join(' ');
    }
    default:
      throw new Error(`no rendering for step kind '${step.kind}'`);
  }
}

function expectationMatches(step, expected, where) {
  if (PATTERN_KINDS.has(step.kind) || NUMBER_KINDS.has(step.kind)) {
    return stepPattern(step) === BigInt.asUintN(128, parseNumber(expected, where));
  }
  return renderStepValue(step) === expected;
}

/** Seeds every destination, so a refusal that wrote one is visible. */
function seedDestinations(steps) {
  for (const step of steps) {
    step.ref = { value: UNTOUCHED };
    if (step.kind === 'bytes') {
      step.buffer = new Uint8Array(step.count);
    }
  }
}

/** The vector's stream, with non-zero slack behind the data it states. */
function streamData(record) {
  const backing = new Uint8Array(record.bytes.length + SLACK_BYTES).fill(SLACK_FILL);
  backing.set(record.bytes);
  return backing.subarray(0, record.bytes.length);
}

function runVector(record) {
  for (const name of record.params.keys()) {
    const takers = OPERATION_PARAMS[name];
    assert.ok(
      takers && takers.includes(record.operation),
      `${record.where}: no runner for parameter '${name}' on operation '${record.operation}'`,
    );
  }

  const steps = buildSteps(record);
  seedDestinations(steps);

  const stream = new ReadStream(streamData(record));
  const { ok, stoppedAt, failedStep } = runSteps(stream, steps);

  if (record.expectKind === 'refused') {
    assert.equal(ok, false, 'the read succeeded, the corpus requires refusal');
    assert.notEqual(stream.error, null, 'a refusal latches an error');

    if (failedStep && SCALAR_KINDS.has(failedStep.kind)) {
      assert.equal(failedStep.ref.value, UNTOUCHED, 'the refused read wrote to its destination');
    }

    // Failure is terminal, and a sequence states its own successors: every
    // step after the failing one must fail too, however many readable bits
    // the stream still holds.
    for (let i = stoppedAt + stepSpan(steps, stoppedAt); i < steps.length; i += stepSpan(steps, i)) {
      const successor = steps.slice(i, i + stepSpan(steps, i));
      assert.equal(
        runSteps(stream, successor).ok,
        false,
        `step ${i + 1} succeeded after step ${stoppedAt + 1} was refused; failure must be terminal`,
      );
    }

    // and the same rule against a read the vector does not name, checked by
    // BEHAVIOR rather than by an accessor so the check ports everywhere
    const after = { value: UNTOUCHED };
    const bitsBefore = stream.bitsProcessed();
    assert.equal(stream.serializeBits(after, 8), false, 'a further read must fail');
    assert.equal(after.value, UNTOUCHED, 'a read after a refusal writes nothing');
    assert.equal(stream.bitsProcessed(), bitsBefore, 'a read after a refusal consumes no bits');
    return;
  }

  assert.equal(ok, true, `the read was refused (error ${String(stream.error)})`);

  // One expect entry per step, objects and aligns included, which state `-`.
  // A leading preceding_bits step carries no entry of its own: it exists to
  // place the stream, and the record states only the operation under test,
  // so the list aligns to the END of the step list.
  const entries = record.expected.split('|').map((entry) => entry.trim());
  const offset = steps.length - entries.length;
  assert.ok(offset >= 0, 'the expect list states more values than the vector has steps');
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] === '-') {
      continue;
    }
    const step = steps[offset + i];
    assert.ok(
      expectationMatches(step, entries[i], record.where),
      `step ${offset + i + 1} decoded ${renderStepValue(step)}, the corpus states ${entries[i]}`,
    );
  }

  assert.equal(stream.bitsProcessed(), record.consumed, 'consumes its stated bits');

  if (record.writerCanonical) {
    // The writer leg re-emits the decoded values and the comparison covers
    // the WHOLE stream, which is what pins the trailing-bits obligation: the
    // unused bits of the final byte must be zero, and the scratch is filled
    // with a non-zero pattern first so a writer that leaks into them
    // produces a byte the vector does not carry.
    const capacity = Math.ceil((record.bytes.length + 64) / 8) * 8;
    const writer = new WriteStream(new Uint8Array(capacity).fill(SLACK_FILL));
    assert.equal(runSteps(writer, steps).ok, true, 'the writer refused a canonical vector');
    writer.flush();
    assert.deepEqual(
      Array.from(writer.data()),
      Array.from(record.bytes),
      'emits the bytes the corpus states',
    );
  }

  if (record.measureAtLeast !== undefined) {
    // A measure is a BOUND and not the packet size, so the corpus states a
    // floor and the check is an inequality. A measure refuses nothing at
    // runtime.
    const measure = new MeasureStream();
    assert.equal(runSteps(measure, steps).ok, true, 'a measure refuses nothing at runtime');
    assert.ok(
      measure.bitsProcessed() >= record.measureAtLeast,
      `measured ${measure.bitsProcessed()} bits, the corpus requires at least ${record.measureAtLeast}`,
    );
  }
}

const files = readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.txt')).sort();
const corpus = files.map((file) => [file, parseVectors(readFileSync(CORPUS_DIR + file, 'utf8'), file)]);

test('the corpus is present and every file parses into records', () => {
  assert.ok(files.length > 0, 'conformance/ holds at least one vector file');
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

// One node:test case per vector, so a red run names every vector that
// disagrees with the standard rather than stopping at the first.
for (const [file, records] of corpus) {
  for (const record of records) {
    test(`conformance/${file}: ${record.name}`, () => runVector(record));
  }
}
