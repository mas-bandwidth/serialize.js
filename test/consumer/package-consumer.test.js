// Clean packed-artifact consumer test (`npm pack` -> `npm install <tarball>`).
//
// Packs the repository into a temporary directory outside the source tree,
// installs only that `.tgz` artifact into a clean consumer package, and runs
// a standalone consumer script in both checked (NODE_ENV=development) and
// production (NODE_ENV=production) fresh processes.
//
// The consumer script imports only the public package entry point ('serialize'),
// verifies that internal subpaths ('serialize/src/...') are blocked by the
// package exports map, reproduces the pinned 29-op / 843-bit / 106-byte
// golden wire message, decodes it back via ReadStream, and verifies that
// truncated buffers are rejected with SerializeError.PastEnd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

function findNpmCliJs() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(execDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function runNpm(args, cwd) {
  const npmCli = findNpmCliJs();
  const env = {
    ...process.env,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });

  assert.equal(
    result.status,
    0,
    `npm ${args.join(' ')} failed (status=${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

// Standalone consumer script source written into the temporary consumer directory.
// Imports ONLY `'serialize'` (never `../src/...` or repository paths).
const CONSUMER_SCRIPT_SOURCE = `import assert from 'node:assert/strict';
import {
  BitWriter,
  BitReader,
  WriteStream,
  ReadStream,
  MeasureStream,
  SerializeError,
  bitsRequired,
  bitsRequired64,
  bitsRequired128,
} from 'serialize';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// STANDARD.md's whole message: 29 operations, 843 field bits, 106 bytes.
const GOLDEN_WIRE_BYTES = Uint8Array.from([
  0x5d, 0xda, 0xf7, 0xe6, 0xd5, 0x77, 0xdf, 0x56, 0xef, 0x9f, 0x75, 0x19,
  0x52, 0xbc, 0xda, 0x0f, 0x49, 0x40, 0xf4, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0xff, 0xfc, 0xd1, 0x48, 0xe0, 0x59, 0xd1, 0x48, 0xc0, 0x7b,
  0xf3, 0x6a, 0xe2, 0x59, 0xd1, 0x48, 0x84, 0xb7, 0x06, 0xde, 0xad, 0xbe,
  0xef, 0xca, 0xfe, 0x01, 0x06, 0x67, 0x6f, 0x6c, 0x64, 0x65, 0x6e, 0x06,
  0xe7, 0xa2, 0x81, 0xe7, 0x9f, 0xb3, 0xc0, 0x60, 0x00, 0x80, 0xa2, 0x7c,
  0xfc, 0xec, 0x26, 0xcb, 0xff, 0xff, 0x4b, 0x1d, 0x1f, 0xef, 0xd2, 0x1a,
  0x1f, 0x01, 0xe9, 0xff, 0xff, 0x09, 0x19, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e,
  0x7f, 0x78, 0x6f, 0x5e, 0x4d, 0x3c, 0x2b, 0x1a, 0x09, 0x04,
]);

const GOLDEN_BITS = 843;
const GOLDEN_END_BITS = 848;

const SCALAR_FIELDS = [
  'bits4', 'bits11', 'bits24', 'bits32', 'intSmall', 'intFull', 'flag',
  'floatValue', 'compressedFloatValue', 'doubleValue', 'uint8Value',
  'uint16Value', 'uint32Value', 'uint64Value', 'relativeNear', 'relativeFar',
  'string', 'cjk', 'fixedQ8_8', 'fixedQ16_16', 'fixedQ48_16',
  'fixedQ16_16Unsigned', 'fixedQ112_16Wide', 'fixedQ64_64Wide',
];

function goldenValues() {
  return {
    bits4: 13,
    bits11: 1445,
    bits24: 11259375,
    bits32: 0xdeadbeef,
    intSmall: -37,
    intFull: -123456789,
    flag: true,
    floatValue: Math.fround(3.1415926),
    compressedFloatValue: 5.0,
    doubleValue: 1.0 / 3.0,
    uint8Value: 0x7f,
    uint16Value: 0x1234,
    uint32Value: 0x12345678,
    uint64Value: 0x123456789abcdef0n,
    relativeNear: 101,
    relativeFar: 2100,
    bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0x01]),
    string: 'golden',
    cjk: '\\u7881\\u77F3',
    fixedQ8_8: -(3 * 256 + 64),
    fixedQ16_16: 1234 * 65536 + 32768,
    fixedQ48_16: -(54321n * 65536n + 12345n),
    fixedQ16_16Unsigned: 29999 * 65536 + 65535,
    fixedQ112_16Wide: -(98765432109n * 65536n + 4321n),
    fixedQ64_64Wide: (0x0123456789abcdefn << 64n) + 0x0fedcba987654321n,
  };
}

function makeRefs(values) {
  const refs = { bytes: new Uint8Array(values.bytes) };
  for (const field of SCALAR_FIELDS) {
    refs[field] = { value: values[field] };
  }
  return refs;
}

function makeReadRefs() {
  const refs = { bytes: new Uint8Array(7) };
  for (const field of SCALAR_FIELDS) {
    refs[field] = {};
  }
  return refs;
}

function serializeGoldenWire(stream, refs) {
  const relativeBase = 100;
  return (
    stream.serializeBits(refs.bits4, 4) &&
    stream.serializeBits(refs.bits11, 11) &&
    stream.serializeBits(refs.bits24, 24) &&
    stream.serializeBits(refs.bits32, 32) &&
    stream.serializeInt(refs.intSmall, -100, +100) &&
    stream.serializeInt(refs.intFull, INT32_MIN, INT32_MAX) &&
    stream.serializeBool(refs.flag) &&
    stream.serializeFloat(refs.floatValue) &&
    stream.serializeCompressedFloat(refs.compressedFloatValue, 0.0, 10.0, 0.01) &&
    stream.serializeDouble(refs.doubleValue) &&
    stream.serializeUint8(refs.uint8Value) &&
    stream.serializeUint16(refs.uint16Value) &&
    stream.serializeUint32(refs.uint32Value) &&
    stream.serializeUint64(refs.uint64Value) &&
    stream.serializeIntRelative(relativeBase, refs.relativeNear) &&
    stream.serializeIntRelative(relativeBase, refs.relativeFar) &&
    stream.serializeAlign() &&
    stream.serializeBytes(refs.bytes) &&
    stream.serializeString(refs.string, 16) &&
    stream.serializeString(refs.cjk, 8) &&
    stream.serializeAlign() &&
    stream.serializeFixed(refs.fixedQ8_8, 8, 8, -100, +100) &&
    stream.serializeFixed(refs.fixedQ16_16, 16, 16, -2000, +2000) &&
    stream.serializeFixed(refs.fixedQ48_16, 48, 16, -100000n, 100000n) &&
    stream.serializeFixed(refs.fixedQ16_16Unsigned, 16, 16, 0, 30000) &&
    stream.serializeAlign() &&
    stream.serializeFixed(refs.fixedQ112_16Wide, 112, 16, -144115188075855872n, 144115188075855872n) &&
    stream.serializeFixed(refs.fixedQ64_64Wide, 64, 64, INT64_MIN, INT64_MAX) &&
    stream.serializeEnd()
  );
}

function verifyGoldenMessage(corruptByteIndex = -1, truncateBytes = -1) {
  const measure = new MeasureStream();
  assert.equal(serializeGoldenWire(measure, makeRefs(goldenValues())), true);
  assert.equal(measure.bitsProcessed() >= GOLDEN_BITS, true);
  assert.equal(measure.bytesProcessed() >= GOLDEN_WIRE_BYTES.byteLength, true);

  const rawBuffer = new Uint8Array(256);
  const writer = new WriteStream(rawBuffer);
  assert.equal(serializeGoldenWire(writer, makeRefs(goldenValues())), true);
  assert.equal(writer.bitsProcessed(), GOLDEN_BITS);
  assert.equal(writer.bytesProcessed(), GOLDEN_WIRE_BYTES.byteLength);
  writer.flush();

  const wire = new Uint8Array(writer.data());
  if (corruptByteIndex >= 0) {
    wire[corruptByteIndex] ^= 0x01;
  }
  assert.equal(wire.byteLength, 106);
  assert.deepEqual(wire, GOLDEN_WIRE_BYTES, 'golden 106-byte wire mismatch');

  const readInput = truncateBytes >= 0 ? wire.subarray(0, truncateBytes) : wire;
  const reader = new ReadStream(readInput);
  const refs = makeReadRefs();
  const readOk = serializeGoldenWire(reader, refs);
  assert.equal(readOk, true, \`golden wire read failed with error=\${reader.error}\`);
  assert.equal(reader.ok, true);
  assert.equal(reader.error, null);
  assert.equal(reader.bitsProcessed(), GOLDEN_END_BITS);

  const expected = goldenValues();
  for (const field of SCALAR_FIELDS) {
    assert.equal(
      Object.is(refs[field].value, expected[field]),
      true,
      \`\${field}: decoded \${refs[field].value}, expected \${expected[field]}\`,
    );
  }
  assert.deepEqual(refs.bytes, expected.bytes);
}

// 1. Verify golden 106-byte reproduction and round-trip.
verifyGoldenMessage();

// 2. Verify truncated reads are rejected with SerializeError.PastEnd.
for (const truncatedLen of [0, 1, 15, 64, 105]) {
  const truncatedReader = new ReadStream(GOLDEN_WIRE_BYTES.subarray(0, truncatedLen));
  const refs = makeReadRefs();
  const ok = serializeGoldenWire(truncatedReader, refs);
  assert.equal(ok, false, \`truncated read at \${truncatedLen} bytes must return false\`);
  assert.equal(truncatedReader.ok, false);
  assert.equal(truncatedReader.error, SerializeError.PastEnd);
}

// 3. Sensitivity controls inside the consumer:
//    - Corrupting 1 byte of the golden wire fails verifyGoldenMessage.
//    - Passing a 105-byte truncated wire to verifyGoldenMessage fails with PastEnd.
assert.throws(
  () => verifyGoldenMessage(0, -1),
  /golden 106-byte wire mismatch/,
);
assert.throws(
  () => verifyGoldenMessage(-1, 105),
  /golden wire read failed with error=past_end/,
);

// 4. Verify internal subpath imports are blocked by package.json "exports".
let blockedSubpath = false;
try {
  await import('serialize/src/bitpacker.js');
} catch (err) {
  blockedSubpath = Boolean(err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
}
assert.equal(blockedSubpath, true, 'package exports must block serialize/src/bitpacker.js');

// 5. Verify BitWriter/BitReader and bitsRequired/bitsRequired64/bitsRequired128 exports.
assert.equal(typeof BitWriter, 'function');
assert.equal(typeof BitReader, 'function');
assert.equal(bitsRequired(0, 255), 8);
assert.equal(bitsRequired64(0n, 255n), 8);
assert.equal(bitsRequired128(0n, 255n), 8);

console.log(JSON.stringify({
  ok: true,
  nodeEnv: process.env.NODE_ENV ?? '',
  bitWriterClass: BitWriter.name,
  writeStreamClass: WriteStream.name,
  measureStreamClass: MeasureStream.name,
  goldenBytes: GOLDEN_WIRE_BYTES.byteLength,
}));
`;

test('clean consumer installs packed tarball and verifies public entry point, 106-byte golden wire, and truncated PastEnd refusal in checked and production modes', () => {
  // Guard that the consumer script source has zero relative repository imports.
  assert.equal(
    CONSUMER_SCRIPT_SOURCE.includes('../src') || CONSUMER_SCRIPT_SOURCE.includes('/src/index.js'),
    false,
    'consumer script must only import from public package specifier',
  );

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'serialize-consumer-'));
  try {
    const packDir = path.join(tmpRoot, 'pack');
    const appDir = path.join(tmpRoot, 'app');
    mkdirSync(packDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    // 1. Pack the repository into packDir.
    runNpm(['pack', '--pack-destination', packDir], REPO_ROOT);

    const packedFiles = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
    assert.equal(packedFiles.length, 1, `expected exactly 1 .tgz in ${packDir}, got ${packedFiles.join(', ')}`);
    const tarballPath = path.join(packDir, packedFiles[0]);
    const tarballBytes = readFileSync(tarballPath);
    const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex');
    assert.equal(tarballSha256.length, 64, 'valid SHA-256 hex digest of packed tarball');

    // Ensure no stray .tgz was left in the repository root.
    const rootTarballs = readdirSync(REPO_ROOT).filter((f) => f.endsWith('.tgz'));
    assert.deepEqual(rootTarballs, [], 'npm pack must not leave .tgz in repository root');

    // 2. Initialize clean consumer package and install ONLY the tarball.
    writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify(
        {
          name: 'serialize-clean-consumer',
          version: '1.0.0',
          private: true,
          type: 'module',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    writeFileSync(path.join(appDir, 'consumer-verify.mjs'), CONSUMER_SCRIPT_SOURCE, 'utf8');

    runNpm(
      ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarballPath],
      appDir,
    );

    assert.equal(
      existsSync(path.join(appDir, 'node_modules', 'serialize', 'package.json')),
      true,
      'serialize package must be installed in consumer node_modules',
    );

    // 3. Execute consumer verification in a fresh checked process (NODE_ENV=development).
    const checkedRun = spawnSync(
      process.execPath,
      ['consumer-verify.mjs'],
      {
        cwd: appDir,
        env: { ...process.env, NODE_ENV: 'development' },
        encoding: 'utf8',
      },
    );
    assert.equal(
      checkedRun.status,
      0,
      `consumer checked run failed (${checkedRun.status}):\n${checkedRun.stderr}`,
    );
    const checkedReport = JSON.parse(checkedRun.stdout.trim());
    assert.deepEqual(checkedReport, {
      ok: true,
      nodeEnv: 'development',
      bitWriterClass: 'CheckedBitWriter',
      writeStreamClass: 'CheckedWriteStream',
      measureStreamClass: 'CheckedMeasureStream',
      goldenBytes: 106,
    });

    // 4. Execute consumer verification in a fresh production process (NODE_ENV=production).
    const prodRun = spawnSync(
      process.execPath,
      ['consumer-verify.mjs'],
      {
        cwd: appDir,
        env: { ...process.env, NODE_ENV: 'production' },
        encoding: 'utf8',
      },
    );
    assert.equal(
      prodRun.status,
      0,
      `consumer production run failed (${prodRun.status}):\n${prodRun.stderr}`,
    );
    const prodReport = JSON.parse(prodRun.stdout.trim());
    assert.deepEqual(prodReport, {
      ok: true,
      nodeEnv: 'production',
      bitWriterClass: 'ProductionBitWriter',
      writeStreamClass: 'ProductionWriteStream',
      measureStreamClass: 'ProductionMeasureStream',
      goldenBytes: 106,
    });
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
