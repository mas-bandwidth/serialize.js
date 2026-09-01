// The production-mode test leg: node production-tests.mjs (or npm run
// test:production).
//
// Spawns the node:test runner with NODE_ENV=production guaranteed in the
// child environment -- cross-platform, no shell env syntax -- so the leg can
// never silently run in dev mode. The dev leg is the plain sweep (npm test);
// this leg re-proves, under the PRODUCTION write-path variants (src/mode.js):
//
// - the golden wire and family pins, byte for byte (golden-wire, smoke, the
//   operation accept suites listed below);
// - the 256-program property sweep: write == read, measure >= write;
// - the read-side refusal batteries: ruling #8 content refusals and the
//   error model bind in EVERY mode -- the wire stays a trust boundary;
// - the production spine (test/production/): overflow still latches sticky,
//   and every dev assert is proven ABSENT -- calls that throw or latch in
//   dev pass through, the caller-trust contract.
//
// Membership: every test file that asserts no dev-only caller validation.
// The files NOT listed are exactly the misuse and write-refusal suites --
// they assert the throws and latches production removes, so they are
// dev-leg-only by design. A new test file joins this list unless it asserts
// dev-mode caller validation.

import { spawnSync } from 'node:child_process';

const files = [
  'test/align.test.js',
  'test/bitreader.test.js',
  'test/bits-required-wide.test.js',
  'test/bits-required.test.js',
  'test/golden-wire.test.js',
  'test/measure.test.js',
  'test/property-sweep.test.js',
  'test/serialize-compressed-float.test.js',
  'test/serialize-fixed.test.js',
  'test/serialize-int-relative.test.js',
  'test/serialize-string-refusals.test.js',
  'test/serialize-uint128.test.js',
  'test/serialize-wstring-refusals.test.js',
  'test/smoke.test.js',
  'test/stream-errors.test.js',
  'test/uint-helpers.test.js',
  'test/writer-tail-span.test.js',
  'test/production/production-write-path.test.js',
];

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

process.exit(result.status ?? 1);
