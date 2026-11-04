// site/trailer.js and site/upload-lib.js against the shared mod-contract fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readTrailer, writeTrailer, TrailerError } from "../../site/trailer.js";
import { classifyRawSet } from "../../site/upload-lib.js";

const FIXTURES = new URL("../../mod-contract/fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const fixture = (file) => new Uint8Array(readFileSync(new URL(`trailer/${file}`, FIXTURES)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function reported(meta) {
  const { title, author, description, version, game_version, guid, identifier, tags, image } = meta;
  return {
    title, author, description, version, game_version, guid, identifier, tags,
    image: image === null ? null : { mime: image.mime, size: image.data.length, sha256: sha256(image.data) },
  };
}

function assertKind(fn, kind) {
  assert.throws(fn, (e) => e instanceof TrailerError && e.kind === kind, `expected ${kind}`);
}

const cases = load("trailer-cases.json");

for (const c of cases.read) {
  test(`trailer read: ${c.file}`, () => {
    const bytes = fixture(c.file);
    if (c.expect.result === "error") return assertKind(() => readTrailer(bytes), c.expect.kind);
    const { trailer } = readTrailer(bytes);
    if (c.expect.result === "none") return assert.equal(trailer, null);
    assert.ok(trailer, "expected a trailer");
    assert.equal(trailer.offset, c.expect.offset);
    assert.deepEqual(reported(trailer.meta), c.expect.metadata);
  });
}

for (const c of cases.write) {
  test(`trailer write: ${c.file}`, () => {
    const bytes = fixture(c.file);
    if (c.expect.result === "error") return assertKind(() => writeTrailer(bytes, c.metadata), c.expect.kind);
    const { bytes: out, replaced, tocEnd } = writeTrailer(bytes, c.metadata);
    assert.equal(tocEnd, c.expect.toc_end);
    assert.equal(replaced, c.expect.replaced);
    const size = new DataView(out.buffer).getUint32(tocEnd + 0x18, true);
    assert.equal(new TextDecoder().decode(out.subarray(tocEnd + 0x20, tocEnd + 0x20 + size)), c.expect.payload);
    assert.equal(out.length, c.expect.size);
    assert.equal(sha256(out), c.expect.sha256);
  });
}

for (const c of load("packages.json").raw) {
  test(`raw set rule: ${c.note}`, () => {
    const { result, base } = classifyRawSet(c.files);
    assert.equal(result, c.expect.result);
    if (result === "ok") assert.equal(base, c.expect.base);
  });
}
