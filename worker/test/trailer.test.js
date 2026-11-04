// Offline unit tests for site/trailer.js (the .utoc trailer twin of trailer.py).
// The cross-implementation cases live in contract.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import {
  crc32, hasTrailer, readTrailerMeta, appendTrailer, readTrailer, writeTrailer, TrailerError,
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

function meta(over = {}) {
  return { title: "Test Mod", author: "Tester", description: "a test", version: "1.0.0",
    guid: "11111111-2222-4333-8444-555555555555", ...over };
}

test("crc32 known vector (IEEE, as Python's zlib.crc32)", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("appendTrailer writes at TocEnd, aligned", () => {
  const out = appendTrailer(fakeToc(), meta());
  const total = out.length - TOC_HEADER_SIZE;
  assert.equal(total % ALIGNMENT, 0);
  assert.ok(total >= HEADER_SIZE + 50);
  assert.equal(String.fromCharCode(...out.slice(TOC_HEADER_SIZE, TOC_HEADER_SIZE + 8)), "UEMODMET");
  assert.deepEqual(out.slice(0, TOC_HEADER_SIZE), fakeToc()); // prefix untouched
});

test("round trip: readTrailerMeta returns the normalized metadata", () => {
  const m = meta({ title: "Ünïcode Tïtle", description: "desc with ünïcode", tags: ["Skin"], game_version: "5.6" });
  const got = readTrailerMeta(appendTrailer(fakeToc(), m));
  assert.equal(got.title, m.title);
  assert.equal(got.description, m.description);
  assert.equal(got.guid, m.guid);
  assert.deepEqual(got.tags, ["Skin"]);
  assert.equal(got.game_version, "5.6");
  assert.equal(got.identifier, "Tester.ÜnïcodeTïtle");
});

test("writing again replaces the trailer and keeps the GUID", () => {
  const first = appendTrailer(fakeToc(), meta());
  const { bytes, replaced } = writeTrailer(first, meta({ guid: null, title: "Renamed" }));
  assert.equal(replaced, true);
  assert.equal(bytes.length, first.length);
  const got = readTrailerMeta(bytes);
  assert.equal(got.title, "Renamed");
  assert.equal(got.guid, meta().guid);
});

test("a missing GUID on a fresh container gets a v4", () => {
  const got = readTrailerMeta(appendTrailer(fakeToc(), meta({ guid: null })));
  assert.match(got.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("a vanilla container has no trailer; non-TOC bytes are not a .utoc", () => {
  assert.equal(readTrailer(fakeToc()).trailer, null);
  assert.equal(hasTrailer(fakeToc()), false);
  assert.equal(hasTrailer(new Uint8Array(16)), false);
  assert.throws(() => readTrailer(new Uint8Array(2048)), (e) => e.kind === "BadMagic");
});

test("a corrupted payload at TocEnd is an error, and hasTrailer says no", () => {
  const out = appendTrailer(fakeToc(), meta());
  out[TOC_HEADER_SIZE + HEADER_SIZE + 5] ^= 0xff;
  assert.throws(() => readTrailer(out), (e) => e instanceof TrailerError && e.kind === "BadCrc");
  assert.equal(hasTrailer(out), false);
});

test("each required field is actually validated", () => {
  for (const [field, bad] of [["title", ""], ["author", ""], ["title", "x".repeat(257)], ["version", "v".repeat(65)]])
    assert.throws(() => appendTrailer(fakeToc(), meta({ [field]: bad })), (e) => e.kind === "SchemaViolation", field);
  assert.throws(() => appendTrailer(fakeToc(), meta({ guid: "nope" })), /GUID/);
});

test("foreign trailing data is never clobbered", () => {
  const bytes = new Uint8Array(TOC_HEADER_SIZE + 10);
  bytes.set(fakeToc(), 0);
  assert.throws(() => appendTrailer(bytes, meta()), (e) => e.kind === "ForeignTrailer");
});
