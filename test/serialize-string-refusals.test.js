// serializeString refusal tests (STANDARD.md, "Readers must refuse malformed
// string payloads", adopted 2026-08-15). Every refused stream is DOCTORED
// with raw operations -- serializeInt for the length, serializeBytes for the
// payload -- because no conforming writer can produce it, and the refusal
// binds in every build mode: hostile input latches an error, never throws.
// Every refusal is proven BOTH WAYS: the doctored vector refused, and an
// accept-boundary neighbor -- the closest conforming stream -- accepted.
// The malformation classes are the C++ suite's (0xFF bytes, a truncated
// multi-byte lead, the interior NUL two-lengths primitive) plus the full
// validator surface: overlong encodings, surrogate code points, values above
// U+10FFFF, stray continuation bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WriteStream,
  ReadStream,
  SerializeError,
} from '../src/index.js';

const BUFFER_SIZE = 16;

// Builds a wire whose string field carries exactly `payload` with a length
// field of payload.length -- the doctoring tool: serializeBytes places
// bytes serializeString would refuse to write.
function doctoredWire(payload) {
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeInt({ value: payload.length }, 0, BUFFER_SIZE - 1), true);
  assert.equal(writer.serializeBytes(Uint8Array.from(payload)), true);
  writer.flush();
  return writer.data();
}

function expectRefused(payload, error, label) {
  const reader = new ReadStream(doctoredWire(payload));
  const ref = { value: 'sentinel' };
  assert.equal(reader.serializeString(ref, BUFFER_SIZE), false, `${label} refused`);
  assert.equal(reader.error, error, `${label} latches ${error}`);
  assert.equal(ref.value, 'sentinel', `${label} leaves the ref untouched`);
}

function expectAccepted(payload, expected, label) {
  const reader = new ReadStream(doctoredWire(payload));
  const ref = {};
  assert.equal(reader.serializeString(ref, BUFFER_SIZE), true, `${label} accepted`);
  assert.equal(reader.ok, true);
  assert.equal(ref.value, expected, `${label} decodes`);
}

test('0xFF can never appear in well-formed UTF-8: refused; a valid payload of the same length accepted', () => {
  // the C++ suite's first class: { FF FE FF }
  expectRefused([0xff, 0xfe, 0xff], SerializeError.InvalidString, '0xFF payload');
  // accept neighbor: three valid bytes -- 'a' then a 2-byte e-acute
  expectAccepted([0x61, 0xc3, 0xa9], 'a\u00E9', 'valid 3-byte payload');
});

test('a truncated multi-byte lead as the final transmitted byte: refused; the completed sequence accepted', () => {
  // the C++ suite's second class: 'a' then a 3-byte lead with no
  // continuation bytes inside the transmitted length
  expectRefused([0x61, 0xe2], SerializeError.InvalidString, 'truncated lead');
  // accept neighbor: the same lead completed -- 'a' then the euro sign
  expectAccepted([0x61, 0xe2, 0x82, 0xac], 'a\u20AC', 'completed sequence');
});

test('an interior NUL is the two-lengths smuggling primitive: refused at every position; the nearest nonzero byte accepted', () => {
  // the C++ suite's third class. A conforming writer derives the length
  // from the terminator, so a transmitted 0x00 only arrives doctored --
  // and it hands the payload two lengths, the wire length and the strlen
  // every downstream consumer computes. NUL is valid UTF-8, which is why
  // the refusal is an explicit scan, proven here at the first, an
  // interior, and the last byte.
  expectRefused([0x00, 0x61, 0x62], SerializeError.InvalidString, 'NUL first');
  expectRefused([0x61, 0x00, 0x62], SerializeError.InvalidString, 'NUL interior');
  expectRefused([0x61, 0x62, 0x00], SerializeError.InvalidString, 'NUL last');
  // accept neighbor: 0x01 -- the nearest byte that is not NUL
  expectAccepted([0x61, 0x01, 0x62], 'ab', 'nonzero neighbor');
});

test('overlong encodings refused at both widths, the smallest legal sequences accepted', () => {
  // 2-byte: C1 81 would decode to U+0041 in two bytes; C2 80 is the
  // smallest code point that legitimately takes two (U+0080)
  expectRefused([0xc1, 0x81], SerializeError.InvalidString, 'overlong 2-byte');
  expectAccepted([0xc2, 0x80], '\u0080', 'U+0080');
  // 3-byte: E0 9F BF would decode to U+07FF in three bytes; E0 A0 80 is
  // the smallest legal 3-byte sequence (U+0800)
  expectRefused([0xe0, 0x9f, 0xbf], SerializeError.InvalidString, 'overlong 3-byte');
  expectAccepted([0xe0, 0xa0, 0x80], '\u0800', 'U+0800');
  // 4-byte: F0 8F BF BF would decode to U+FFFF in four bytes; F0 90 80 80
  // is the smallest legal 4-byte sequence (U+10000)
  expectRefused([0xf0, 0x8f, 0xbf, 0xbf], SerializeError.InvalidString, 'overlong 4-byte');
  expectAccepted([0xf0, 0x90, 0x80, 0x80], '\u{10000}', 'U+10000');
});

test('surrogate code points are not UTF-8: refused; both sides of the gap accepted', () => {
  // ED A0 80 encodes U+D800, ED BF BF encodes U+DFFF: the whole surrogate
  // block is malformed in UTF-8
  expectRefused([0xed, 0xa0, 0x80], SerializeError.InvalidString, 'U+D800');
  expectRefused([0xed, 0xbf, 0xbf], SerializeError.InvalidString, 'U+DFFF');
  // accept neighbors: the code points fencing the gap from both sides
  expectAccepted([0xed, 0x9f, 0xbf], '\uD7FF', 'U+D7FF below the gap');
  expectAccepted([0xee, 0x80, 0x80], '\uE000', 'U+E000 above the gap');
});

test('code points above U+10FFFF refused, the last code point accepted', () => {
  // F4 90 80 80 would be U+110000; F4 8F BF BF is U+10FFFF exactly
  expectRefused([0xf4, 0x90, 0x80, 0x80], SerializeError.InvalidString, 'U+110000');
  // F5 and above can never lead a sequence at all
  expectRefused([0xf5, 0x80, 0x80, 0x80], SerializeError.InvalidString, '0xF5 lead');
  expectAccepted([0xf4, 0x8f, 0xbf, 0xbf], '\u{10FFFF}', 'U+10FFFF');
});

test('a stray continuation byte refused, the last 1-byte code point accepted', () => {
  expectRefused([0x80], SerializeError.InvalidString, 'stray continuation');
  expectAccepted([0x7f], '\u007F', 'U+007F');
});

test('a length that overruns the data latches Overflow, the full payload accepted', () => {
  // length 5 with only two payload bytes on the wire: the byte count
  // refusal fires before any decoding
  const writer = new WriteStream(new Uint8Array(64));
  assert.equal(writer.serializeInt({ value: 5 }, 0, BUFFER_SIZE - 1), true);
  assert.equal(writer.serializeBytes(Uint8Array.from([0x61, 0x62])), true);
  writer.flush();

  const refused = new ReadStream(writer.data());
  const ref = { value: 'sentinel' };
  assert.equal(refused.serializeString(ref, BUFFER_SIZE), false);
  assert.equal(refused.error, SerializeError.Overflow);
  assert.equal(ref.value, 'sentinel');

  // accept neighbor: the honest length reads the same bytes through
  expectAccepted([0x61, 0x62], 'ab', 'honest length');
});

test('doctored align padding inside the string operation latches Align, the clean wire accepted', () => {
  // 'a' at bufferSize 16: length 1 in 4 bits, pad bits [4,8), payload byte
  // 0x61 -> wire 01 61. Doctor each padding bit in turn.
  for (let p = 4; p <= 7; p++) {
    const doctored = Uint8Array.from([0x01 | (1 << p), 0x61]);
    const reader = new ReadStream(doctored);
    const ref = { value: 'sentinel' };
    assert.equal(reader.serializeString(ref, BUFFER_SIZE), false, `padding bit ${p} refused`);
    assert.equal(reader.error, SerializeError.Align);
    assert.equal(ref.value, 'sentinel');
  }
  const clean = new ReadStream(Uint8Array.from([0x01, 0x61]));
  const ref = {};
  assert.equal(clean.serializeString(ref, BUFFER_SIZE), true);
  assert.equal(ref.value, 'a');
});

test('the control content still round trips: the refusals cost no valid stream', () => {
  // the C++ control: h, e-acute, euro sign, U+1F600 -- 1, 2, 3 and 4 byte
  // sequences in one payload, built from explicit bytes
  const payload = [0x68, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80];
  expectAccepted(payload, 'h\u00E9\u20AC\u{1F600}', 'control content');
});

test('a latched stream refuses serializeString without touching the ref', () => {
  const reader = new ReadStream(doctoredWire([0xff]));
  const ref = { value: 'sentinel' };
  assert.equal(reader.serializeString(ref, BUFFER_SIZE), false); // latches InvalidString
  assert.equal(reader.serializeString(ref, BUFFER_SIZE), false); // still refused
  assert.equal(reader.error, SerializeError.InvalidString);
  assert.equal(ref.value, 'sentinel');
});
