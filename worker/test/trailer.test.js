// Offline tests for site/trailer.js (the .utoc trailer twin of trailer.py).

import test from "node:test";
import assert from "node:assert/strict";
import { crc32, hasTrailer, readTrailerMeta, appendTrailer, findTrailer, ALIGNMENT, HEADER_SIZE } from "../../site/trailer.js";

function meta(over = {}) {
  return { title: "Test Mod", author: "Tester", description: "a test", version: "1.0.0",
    guid: "11111111-2222-3333-4444-555555555555", ...over };
}

test("crc32 known vector (IEEE, as Python's zlib.crc32)", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("appendTrailer output: alignment, size, and magic position", () => {
  const utoc = new Uint8Array(4096).fill(0);
  out: {
    const out = appendTrailer(utoc, meta());
    const total = out.length - 4096;
    assert.equal(total % ALIGNMENT, 0);
    assert.ok(total >= HEADER_SIZE + 50); // header + payload, padded
    const magic = String.fromCharCode(...out.slice(4096, 4096 + 8));
    assert.equal(magic, "UEMODMET");
  }
});

test("round trip: hasTrailer + readTrailerMeta return what appendTrailer wrote", () => {
  const utoc = new Uint8Array(8192).fill(7);
  const m = meta({ title: "Ünïcode Tïtle", description: "desc with ünïcode" });
  const withTrailer = appendTrailer(utoc, m);
  assert.ok(hasTrailer(withTrailer));
  assert.deepEqual(readTrailerMeta(withTrailer), m);
  // the original .utoc prefix is untouched
  assert.deepEqual(withTrailer.slice(0, 8192), utoc);
});

test("plain bytes have no trailer", () => {
  assert.equal(hasTrailer(new Uint8Array(2048)), false);
  assert.equal(hasTrailer(new Uint8Array(16)), false); // too small
});

test("a corrupted payload (crc mismatch) is not a trailer", () => {
  const out = appendTrailer(new Uint8Array(4096), meta());
  // flip one payload byte (header is 32 bytes; payload starts at offset+32)
  out[out.length - 65536 + HEADER_SIZE + 5] ^= 0xff;
  assert.equal(hasTrailer(out), false);
});

test("a stray magic without a valid header is not a trailer", () => {
  const bytes = new Uint8Array(8192);
  bytes.set(new TextEncoder().encode("UEMODMET"), 100); // magic, garbage header
  assert.equal(hasTrailer(bytes), false);
});

test("findTrailer rejects a wrong version and a non-multiple-of-64KiB total", () => {
  const out = appendTrailer(new Uint8Array(4096), meta());
  const off = 4096;
  const bad = out.slice();
  new DataView(bad.buffer).setUint16(off + 8, 2, true); // version 2
  assert.equal(hasTrailer(bad), false);

  const bad2 = out.slice();
  const dv = new DataView(bad2.buffer);
  // total_size low word +1 (was a multiple of 65536) -> not aligned
  dv.setUint32(off + 0x10, dv.getUint32(off + 0x10, true) + 1, true);
  assert.equal(hasTrailer(bad2), false);
});

test("appendTrailer validates its inputs", () => {
  assert.throws(() => appendTrailer(new Uint8Array(8), meta({ title: "" })), /title/);
  assert.throws(() => appendTrailer(new Uint8Array(8), meta({ guid: "" })), /guid/);
  assert.throws(() => appendTrailer(new Uint8Array(8), meta({ title: "x".repeat(257) })), /title/);
});

test("a trailer is still found when prefixed bytes contain the magic", () => {
  const prefix = new Uint8Array(4096);
  prefix.set(new TextEncoder().encode("UEMODMET"), 10); // stray magic in the body
  const out = appendTrailer(prefix, meta());
  assert.ok(hasTrailer(out));
  assert.deepEqual(readTrailerMeta(out), meta());
});
