// Fuzz target 2: differential write -> measure -> read round trip of values
// generated from the input (harness.js, pass 2). Run with Jazzer.js from
// this directory:
//   npx jazzer roundtrip.fuzz.js corpus/roundtrip -- -max_total_time=60
// SERIALIZE_FUZZ_SABOTAGE=<name> fuzzes a copy of src/ with a planted
// asymmetry instead: the negative control, which must be caught.

import { roundTrip, splitInput } from './harness.js';

export function fuzz(data) {
  const input = splitInput(data);
  if (input !== null) {
    roundTrip(input.ops, input.payload);
  }
}
