// The flushed tail span: "bytes past the end of the written data are only
// ever written as zeros" is a documented property of the writer, and these
// tests pin it for EVERY bit count rather than for the convenient ones.
//
// The buffer is prefilled with 0xff so a byte the writer never touches is
// distinguishable from one it zeroed. The writer stores whole 32-bit words
// and pairs them into the 8-byte span the buffer-length contract is stated
// in, so after flushBits the memory is exactly:
//
//   [0, bytesWritten)             the packet
//   [bytesWritten, 8*ceil(k/64))  zeros, written by the flush
//   [8*ceil(k/64), buffer.length) never touched
//
// The bit counts that need saying out loud are k = 32 and k = 96 — a write
// ending exactly on a 32-bit boundary has already stored its word, so the
// flush has no partial word to store and must still pair the span. Under a
// flush that pairs only when it stores, those are precisely the counts that
// leak whatever the caller's buffer held before.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter } from '../src/index.js';

const SIZE = 64;

// Writes k bits in pseudo-random chunks of 1..32 and flushes. The chunk
// widths are varied so the scratch lands on every phase on the way to k.
function writeBits(k) {
  const buffer = new Uint8Array(SIZE).fill(0xff);
  const writer = new BitWriter(buffer);
  let left = k;
  let seed = (0x12345 ^ k) >>> 0;
  while (left > 0) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const bits = Math.min(left, 1 + (seed % 32));
    const mask = bits === 32 ? 0xffffffff : ((1 << bits) >>> 0) - 1;
    writer.writeBits(seed & mask, bits);
    left -= bits;
  }
  writer.flushBits();
  return { buffer, bytes: writer.bytesWritten() };
}

function spanEnd(k) {
  return 8 * Math.ceil(k / 64);
}

function assertTail(k, buffer, bytes) {
  const end = spanEnd(k);
  assert.equal(bytes, Math.ceil(k / 8), `k=${k}: bytesWritten`);
  for (let i = bytes; i < end; i++) {
    assert.equal(buffer[i], 0, `k=${k}: byte ${i} is inside the flushed span and must be zero`);
  }
  for (let i = end; i < SIZE; i++) {
    assert.equal(buffer[i], 0xff, `k=${k}: byte ${i} is past the flushed span and must be untouched`);
  }
}

test('tail span: a write ending on a 32-bit boundary still pairs its 8-byte span', () => {
  // k = 32: one full word stored by the merge itself, so the flush has no
  // partial word — and bytes 4..7 must still come back zeroed, not 0xff.
  const { buffer, bytes } = writeBits(32);
  assert.equal(bytes, 4);
  assert.deepEqual(Array.from(buffer.subarray(4, 8)), [0, 0, 0, 0]);
  assert.equal(buffer[8], 0xff); // and nothing beyond the span was touched
  assertTail(32, buffer, bytes);
});

test('tail span: the same at the second 8-byte span', () => {
  // k = 96: words 0 and 1 are a full span, word 2 is stored by the merge,
  // and word 3 is the pairing store the flush owes.
  const { buffer, bytes } = writeBits(96);
  assert.equal(bytes, 12);
  assert.deepEqual(Array.from(buffer.subarray(12, 16)), [0, 0, 0, 0]);
  assert.equal(buffer[16], 0xff);
  assertTail(96, buffer, bytes);
});

test('tail span: every bit count from 0 to 384', () => {
  for (let k = 0; k <= 384; k++) {
    const { buffer, bytes } = writeBits(k);
    assertTail(k, buffer, bytes);
  }
});

test('tail span: a byte-aligned writeBytes payload flushes the same way', () => {
  // writeBytes takes the bulk-copy path rather than the scratch, so the span
  // pairing has to hold for the cursor it leaves behind too.
  for (let n = 0; n <= 48; n++) {
    const buffer = new Uint8Array(SIZE).fill(0xff);
    const writer = new BitWriter(buffer);
    const payload = new Uint8Array(n);
    for (let i = 0; i < n; i++) payload[i] = (i * 37 + 11) & 0xff;
    writer.writeBytes(payload);
    writer.flushBits();
    assert.equal(writer.bytesWritten(), n, `n=${n}: bytesWritten`);
    for (let i = 0; i < n; i++) assert.equal(buffer[i], payload[i], `n=${n}: payload byte ${i}`);
    const end = spanEnd(n * 8);
    for (let i = n; i < end; i++) assert.equal(buffer[i], 0, `n=${n}: byte ${i} must be zero`);
    for (let i = end; i < SIZE; i++) assert.equal(buffer[i], 0xff, `n=${n}: byte ${i} must be untouched`);
  }
});

test('tail span: flushBits is idempotent — a second call writes nothing new', () => {
  for (const k of [0, 1, 31, 32, 33, 63, 64, 65, 95, 96, 97]) {
    const buffer = new Uint8Array(SIZE).fill(0xff);
    const writer = new BitWriter(buffer);
    if (k > 0) {
      let left = k;
      while (left > 0) {
        const bits = Math.min(left, 32);
        writer.writeBits(0xa5a5a5a5 & (bits === 32 ? 0xffffffff : ((1 << bits) >>> 0) - 1), bits);
        left -= bits;
      }
    }
    writer.flushBits();
    const once = Uint8Array.from(buffer);
    writer.flushBits();
    assert.deepEqual(Array.from(buffer), Array.from(once), `k=${k}: second flush changed memory`);
  }
});
