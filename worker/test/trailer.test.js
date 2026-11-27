// Offline unit tests for site/trailer.js (the read-only .utoc trailer parser).
// The cross-implementation cases live in contract.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  crc32, hasTrailer, readTrailerMeta, readTrailer, TrailerError,
  ALIGNMENT, HEADER_SIZE, TOC_HEADER_SIZE, TOC_MAGIC, TOC_SUPPORTED_VERSION,
} from "../../site/trailer.js";

/** A minimal valid v8 .utoc header with no sections: TocEnd = 144. */
function fakeToc() {
  const h = new Uint8Array(TOC_HEADER_SIZE);
  h.set(new TextEncoder().encode(TOC_MAGIC), 0);
  h[0x10] = TOC_SUPPORTED_VERSION;
  const dv = new DataView(h.buffer);
  dv.setInt32(0x14, TOC_HEADER_SIZE, true);
  dv.setInt32(0x20, 12, true);
  return h;
}

function payload(over = {}) {
  return { schema: 1, title: "Test Mod", author: "Tester", description: "a test", version: "1.0.0",
    game_version: "", guid: "11111111-2222-4333-8444-555555555555", identifier: "", ...over };
}

/** `utoc` followed by a hand-built trailer (header, CRC32, JSON payload, 64 KiB padding). */
function withTrailer(utoc, obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const total = Math.ceil((HEADER_SIZE + body.length) / ALIGNMENT) * ALIGNMENT;
  const out = new Uint8Array(utoc.length + total);
  out.set(utoc, 0);
  const t = utoc.length;
  out.set(new TextEncoder().encode("UEMODMET"), t);
  const dv = new DataView(out.buffer);
  dv.setUint16(t + 8, 1, true);
  dv.setUint32(t + 0x10, total, true);
  dv.setUint32(t + 0x18, body.length, true);
  dv.setUint32(t + 0x1c, crc32(body), true);
  out.set(body, t + HEADER_SIZE);
  return out;
}

test("crc32 known vector (IEEE, as Python's zlib.crc32)", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("readTrailerMeta returns the normalized metadata", () => {
  const got = readTrailerMeta(withTrailer(fakeToc(), payload({
    title: "Ünïcode Tïtle", description: "desc with ünïcode", tags: ["Skin"], game_version: "5.6",
  })));
  assert.equal(got.title, "Ünïcode Tïtle");
  assert.equal(got.description, "desc with ünïcode");
  assert.equal(got.guid, payload().guid);
  assert.deepEqual(got.tags, ["Skin"]);
  assert.equal(got.game_version, "5.6");
  assert.equal(got.identifier, "Tester.ÜnïcodeTïtle");
});

test("a trailer is found by the TocEnd read and by the scan fallback", () => {
  const out = withTrailer(fakeToc(), payload());
  assert.equal(readTrailer(out).trailer.offset, TOC_HEADER_SIZE);
  const bad = fakeToc();
  bad[0x10] = 9;
  const scanned = readTrailer(withTrailer(bad, payload()));
  assert.equal(scanned.trailer.offset, TOC_HEADER_SIZE);
  assert.match(scanned.warning, /scan mode/);
});

test("a vanilla container has no trailer; non-TOC bytes are not a .utoc", () => {
  assert.equal(readTrailer(fakeToc()).trailer, null);
  assert.equal(hasTrailer(fakeToc()), false);
  assert.equal(hasTrailer(new Uint8Array(16)), false);
  assert.throws(() => readTrailer(new Uint8Array(2048)), (e) => e.kind === "BadMagic");
});

test("a corrupted payload at TocEnd is an error, and hasTrailer says no", () => {
  const out = withTrailer(fakeToc(), payload());
  out[TOC_HEADER_SIZE + HEADER_SIZE + 5] ^= 0xff;
  assert.throws(() => readTrailer(out), (e) => e instanceof TrailerError && e.kind === "BadCrc");
  assert.equal(hasTrailer(out), false);
});

test("a payload violating the metadata schema is rejected", () => {
  for (const [field, bad] of [["title", ""], ["author", ""], ["title", "x".repeat(257)], ["version", "v".repeat(65)], ["guid", "nope"]])
    assert.throws(() => readTrailer(withTrailer(fakeToc(), payload({ [field]: bad }))),
      (e) => e.kind === "SchemaViolation", field);
});

test("unknown trailing data is no trailer, not an error", () => {
  const bytes = new Uint8Array(TOC_HEADER_SIZE + 10);
  bytes.set(fakeToc(), 0);
  assert.equal(readTrailer(bytes).trailer, null);
});

test("real fixture containers read back", () => {
  const real = new Uint8Array(readFileSync(new URL("../../mod-contract/fixtures/trailer/real-ue56-signed-with-trailer.utoc", import.meta.url)));
  assert.ok(readTrailer(real).trailer.meta.title);
});
