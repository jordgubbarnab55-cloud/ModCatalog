// Offline tests for site/zip-lib.js (the browser-side .utoc reader).
// Test zips are built here with node:zlib (deflateRawSync) so the reader is
// checked against bytes it did not write.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deflateRawSync } from "node:zlib";
import {
  classifyMembers, readZipEntries, readZipMember, readUtocFromZip, shapeProblem, ZipError, MAX_UTOC_BYTES,
} from "../../site/zip-lib.js";

const enc = new TextEncoder();

function le(bytes, ...fields) {
  const b = Buffer.alloc(bytes);
  let o = 0;
  for (const [size, value] of fields) {
    if (size === 8) b.writeBigUInt64LE(BigInt(value), o); else if (size === 4) b.writeUInt32LE(value, o); else b.writeUInt16LE(value, o);
    o += size;
  }
  return b;
}

/** files: [{ name, data, method = 8, flags = 0 }] */
function buildZip(files, { zip64 = false, comment = "" } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const method = f.method ?? 8;
    const data = Buffer.from(f.data);
    const body = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.concat([
      le(30, [4, 0x04034b50], [2, 20], [2, f.flags ?? 0], [2, method], [4, 0], [4, 0], [4, body.length], [4, data.length], [2, name.length], [2, 0]),
      name, body]);
    const extra = zip64
      ? le(28, [2, 1], [2, 24], [8, data.length], [8, body.length], [8, offset])
      : Buffer.alloc(0);
    const max = 0xffffffff;
    central.push(Buffer.concat([
      le(46, [4, 0x02014b50], [2, 45], [2, 20], [2, f.flags ?? 0], [2, method], [4, 0], [4, 0],
        [4, zip64 ? max : body.length], [4, zip64 ? max : data.length], [2, name.length], [2, extra.length],
        [2, 0], [2, 0], [2, 0], [4, 0], [4, zip64 ? max : offset]),
      name, extra]));
    parts.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const tail = [cd];
  const cdOffset = offset;
  const commentBytes = Buffer.from(comment, "utf8");
  if (zip64) {
    const zip64At = cdOffset + cd.length;
    tail.push(le(56, [4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0], [8, files.length], [8, files.length], [8, cd.length], [8, cdOffset]));
    tail.push(le(20, [4, 0x07064b50], [4, 0], [8, zip64At], [4, 1]));
    tail.push(le(22, [4, 0x06054b50], [2, 0], [2, 0], [2, 0xffff], [2, 0xffff], [4, 0xffffffff], [4, 0xffffffff], [2, commentBytes.length]));
  } else {
    tail.push(le(22, [4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, cd.length], [4, cdOffset], [2, commentBytes.length]));
  }
  tail.push(commentBytes);
  return new Blob([...parts, ...tail]);
}

/** A Blob wrapper that records every sliced range. */
function spy(blob) {
  const ranges = [];
  return {
    size: blob.size,
    ranges,
    slice(a, b) { ranges.push([a, b]); return blob.slice(a, b); },
    get sliced() { return ranges.reduce((s, [a, b]) => s + (b - a), 0); },
  };
}

const UTOC = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 251);
const set = (dir = "") => [
  { name: `${dir}mod.pak`, data: enc.encode("PAK".repeat(100)) },
  { name: `${dir}mod.ucas`, data: enc.encode("UCAS".repeat(100)) },
  { name: `${dir}mod.utoc`, data: UTOC },
];

// ----------------------------------------------------------------- reading

test("reads a deflated .utoc from a flat zip", async () => {
  const r = await readUtocFromZip(buildZip(set()));
  assert.equal(r.shape.result, "ok");
  assert.equal(r.utocName, "mod.utoc");
  assert.deepEqual(r.utoc, UTOC);
});

test("reads a stored (method 0) .utoc", async () => {
  const files = set().map((f) => ({ ...f, method: 0 }));
  const r = await readUtocFromZip(buildZip(files));
  assert.deepEqual(r.utoc, UTOC);
});

test("nested paths, directory entries and unrelated members", async () => {
  const files = [
    { name: "Content/", data: "", method: 0 },
    { name: "readme.txt", data: "hi" },
    ...set("Content/Paks/~mods/"),
  ];
  const r = await readUtocFromZip(buildZip(files));
  assert.equal(r.shape.result, "ok");
  assert.equal(r.utocName, "Content/Paks/~mods/mod.utoc");
  assert.deepEqual(r.utoc, UTOC);
});

test("a ZIP64 archive (sizes and offsets in the extra field)", async () => {
  const blob = buildZip(set(), { zip64: true });
  const entries = await readZipEntries(blob);
  assert.deepEqual(entries.map((e) => e.name), ["mod.pak", "mod.ucas", "mod.utoc"]);
  assert.deepEqual((await readUtocFromZip(blob)).utoc, UTOC);
});

test("a trailing archive comment does not hide the central directory", async () => {
  const blob = buildZip(set(), { comment: "made by hand — ".repeat(200) });
  assert.deepEqual((await readUtocFromZip(blob)).utoc, UTOC);
});

test("only the tail, the central directory and the .utoc are read", async () => {
  const big = enc.encode("x".repeat(3 * 1024 * 1024));
  const files = [
    { name: "mod.pak", data: big, method: 0 },
    { name: "mod.ucas", data: big, method: 0 },
    { name: "mod.utoc", data: UTOC },
  ];
  const s = spy(buildZip(files));
  assert.deepEqual((await readUtocFromZip(s)).utoc, UTOC);
  assert.ok(s.size > 6 * 1024 * 1024);
  assert.ok(s.sliced < 100 * 1024, `sliced ${s.sliced} bytes of ${s.size}`);
});

test("a shape problem is reported without reading any member", async () => {
  const two = [...set(), ...set().map((f) => ({ ...f, name: "b" + f.name }))];
  const s = spy(buildZip(two));
  const r = await readUtocFromZip(s);
  assert.equal(r.shape.result, "multiple-sets");
  assert.equal(r.utoc, null);
  assert.match(shapeProblem(r.shape.result), /one mod per package/);
});

// ------------------------------------------------------------------ errors

test("not a zip, too short, and truncated archives throw ZipError", async () => {
  await assert.rejects(readUtocFromZip(new Blob(["this is plainly not a zip file at all"])), ZipError);
  await assert.rejects(readUtocFromZip(new Blob([])), ZipError);
  const good = await buildZip(set()).arrayBuffer();
  await assert.rejects(readUtocFromZip(new Blob([good.slice(0, good.byteLength - 30)])), ZipError);
  await assert.rejects(readUtocFromZip(new Blob([good.slice(0, 100)])), ZipError);
});

test("encrypted, unsupported-method and wrong-size members throw ZipError", async () => {
  const enc1 = set().map((f) => (f.name === "mod.utoc" ? { ...f, flags: 1 } : f));
  await assert.rejects(readUtocFromZip(buildZip(enc1)), /encrypted/);

  const blob = buildZip(set());
  const [utoc] = (await readZipEntries(blob)).filter((e) => e.name === "mod.utoc");
  await assert.rejects(readZipMember(blob, { ...utoc, method: 14 }), /unsupported compression/);
  await assert.rejects(readZipMember(blob, { ...utoc, size: utoc.size + 1 }), /recorded size/);
  await assert.rejects(readZipMember(blob, { ...utoc, size: MAX_UTOC_BYTES + 1 }), /too large/);
});

// -------------------------------------------------------- the shape rule

const fixtures = JSON.parse(fs.readFileSync(new URL("../../mod-contract/fixtures/packages.json", import.meta.url), "utf8"));
for (const c of fixtures.zip) {
  test(`zip package rule (shared fixture): ${c.note}`, () => {
    const got = classifyMembers(c.members);
    assert.equal(got.result, c.expect.result);
    if (c.expect.result === "ok") assert.equal(got.base, c.expect.base);
  });
}
