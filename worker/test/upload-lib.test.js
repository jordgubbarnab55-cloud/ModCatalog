// Offline tests for the pure helpers behind site/upload.html
// (run together with the worker tests: `node --test` from worker/ or the repo root).

import test from "node:test";
import assert from "node:assert/strict";
import {
  configOk, statusMessage, findNewMod, findNewModByName, POLL_MAX_MS,
  whoamiUrl, checkToken, forcedFields, authorMismatchNote, resolveForm, buildMetadataJson,
} from "../../site/upload-lib.js";

test("configOk rejects placeholders, empty, non-http and missing values", () => {
  assert.equal(configOk("REPLACE_ME_WORKER_URL"), false);
  assert.equal(configOk("REPLACE_ME"), false);
  assert.equal(configOk(""), false);
  assert.equal(configOk(undefined), false);
  assert.equal(configOk(null), false);
  assert.equal(configOk("http://insecure.example.com"), false);
  assert.equal(configOk("https://modcatalog.example.workers.dev"), true);
  assert.equal(configOk("https://modcatalog.example.workers.dev/discord?x=1"), true);
});

test("statusMessage covers every documented status", () => {
  assert.match(statusMessage(202), /queued/i);
  assert.match(statusMessage(401), /token/i);
  assert.match(statusMessage(411), /size/i);
  assert.match(statusMessage(413), /100 MB/i);
  assert.match(statusMessage(429), /daily/i);
  assert.match(statusMessage(400), /\.zip/i);
  assert.match(statusMessage(502), /github/i);
  assert.match(statusMessage(503), /inbox/i);
  assert.match(statusMessage(500), /HTTP 500/);
  assert.match(statusMessage(599), /server error/i);
  assert.match(statusMessage("network"), /network/i);
});

test("findNewMod matches by size and excludes previously known ids", () => {
  const before = [{ id: "a", size: 100 }, { id: "b", size: 200 }];
  const after = [
    { id: "a", size: 100 },
    { id: "b", size: 200 },
    { id: "c", size: 200 },
    { id: "d", size: 999 },
  ];
  const hit = findNewMod(before, after, 200);
  assert.ok(hit);
  assert.equal(hit["id"], "c");
  assert.equal(findNewMod(before, after, 12345), null, "unknown size: nothing new");
  assert.equal(findNewMod(null, after, 200)["id"], "b", "empty 'before': first matching mod is new");
});

test("findNewModByName matches by name (null = any new mod)", () => {
  const before = [{ id: "a", name: "Old Mod" }];
  const after = [
    { id: "a", name: "Old Mod" },
    { id: "b", name: "New Mod" },
    { id: "c", name: "Other Mod" },
  ];
  assert.equal(findNewModByName(before, after, "New Mod")["id"], "b");
  assert.equal(findNewModByName(before, after, "new mod")["id"], "b", "case-insensitive");
  assert.equal(findNewModByName(before, after, "Missing"), null);
  assert.equal(findNewModByName(before, after, null)["id"], "b", "null name: first new mod");
  assert.equal(findNewModByName(after, after, null), null, "nothing new: null");
});

test("POLL_MAX_MS is about 3 minutes", () => {
  assert.ok(POLL_MAX_MS >= 170000 && POLL_MAX_MS <= 190000);
});

// ------------------------------------------------------ verified authors

test("whoamiUrl sits next to the upload URL", () => {
  assert.equal(whoamiUrl("https://w.example.workers.dev/upload"), "https://w.example.workers.dev/whoami");
  assert.equal(whoamiUrl("https://w.example.workers.dev/upload/"), "https://w.example.workers.dev/whoami");
  assert.equal(whoamiUrl("https://example.com/api/upload?x=1#h"), "https://example.com/api/whoami");
  assert.equal(whoamiUrl("https://w.example.workers.dev"), "https://w.example.workers.dev/whoami");
});

function fakeFetch(status, body, seen = {}) {
  return async (url, init) => {
    seen.url = url;
    seen.init = init;
    return { status, json: async () => { if (body === undefined) throw new Error("no json"); return body; } };
  };
}

test("checkToken: 200 gives the identity, sending the bearer token", async () => {
  const seen = {};
  const r = await checkToken("https://w/whoami", "mm_x", fakeFetch(200, { discordId: "42", username: "alice" }, seen));
  assert.deepEqual(r, { ok: true, identity: { discordId: "42", username: "alice" } });
  assert.equal(seen.init.headers.Authorization, "Bearer mm_x");
  assert.equal(seen.url, "https://w/whoami");
});

test("checkToken: 401 is a rejected token and carries the server's reason", async () => {
  const r = await checkToken("u", "t", fakeFetch(401, { error: "this token predates verified author names; mint a new one with /token in Discord" }));
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.match(r.message, /predates verified author names/);
  const plain = await checkToken("u", "t", fakeFetch(401, undefined));
  assert.equal(plain.rejected, true);
  assert.match(plain.message, /\/token/);
});

test("checkToken: network and server trouble is not a rejection", async () => {
  const down = await checkToken("u", "t", async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual([down.ok, down.rejected], [false, false]);
  assert.match(down.message, /network/i);
  const boom = await checkToken("u", "t", fakeFetch(500, {}));
  assert.deepEqual([boom.ok, boom.rejected], [false, false]);
  const odd = await checkToken("u", "t", fakeFetch(200, { hello: 1 }));
  assert.deepEqual([odd.ok, odd.rejected], [false, false]);
});

test("forcedFields: the author is the username, the identifier follows the title", () => {
  const forced = forcedFields({ discordId: "42", username: "alice" });
  assert.equal(forced.author, "alice");
  const r = resolveForm({ title: " My  Mod ", author: "Someone Else" }, forced);
  assert.equal(r.author, "alice");
  assert.equal(r.identifier, "42.MyMod");
  assert.equal(r.authorForced && r.identifierForced, true);
  assert.equal(resolveForm({ title: "", author: "x" }, forced).identifier, "");
});

test("the forced author is what the metadata.json carries", () => {
  const forced = forcedFields({ discordId: "42", username: "alice" });
  const r = resolveForm({ title: "T", author: "Other" }, forced);
  assert.equal(JSON.parse(buildMetadataJson({ title: "T", author: r.author, version: "", gameVersion: "", description: "", tags: [] })).author, "alice");
});

test("authorMismatchNote only warns when the package names another author", () => {
  assert.equal(authorMismatchNote("alice", "alice"), null);
  assert.equal(authorMismatchNote("", "alice"), null);
  assert.equal(authorMismatchNote(undefined, "alice"), null);
  const note = authorMismatchNote("Alice B.", "alice");
  assert.equal(note.kind, "warn");
  assert.match(note.text, /“alice”/);
  assert.match(note.text, /“Alice B\.”/);
});
