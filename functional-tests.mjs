// Keep external test effects opt-in, including when a parent exports the flag.
import { spawnSync } from 'node:child_process';

const unit = process.argv.includes('--unit');
const files = unit ? [] : [
  'test/consumer/package-consumer.test.js',
  'test/conformance-controls.test.js',
  'test/production/production-operation-parity.test.js',
];
const args = unit ? ['--test'] : ['--test', '--test-name-pattern=^functional:', ...files];
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: { ...process.env, SERIALIZE_TEST_FUNCTIONAL: unit ? '0' : '1' },
});
process.exit(result.status ?? 1);
