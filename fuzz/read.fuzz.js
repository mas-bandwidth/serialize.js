// Fuzz target 1: hostile read of arbitrary bytes through every ReadStream
// primitive (harness.js, pass 1). Run with Jazzer.js from this directory:
//   npx jazzer read.fuzz.js corpus/read -- -max_total_time=60

import { hostileRead, splitInput } from './harness.js';

export function fuzz(data) {
  const input = splitInput(data);
  if (input !== null) {
    hostileRead(input.ops, input.payload);
  }
}
