// Offline tests for the #mods button-message script (node --test, Node 18+).
// A mock fetch stands in for the Discord API; nothing touches the network.

import test from "node:test";
import assert from "node:assert/strict";
import { buildModsMessage, postModsMessage } from "../scripts/post-mods-message.mjs";

// ------------------------------------------------------------- fakes

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler ? handler(url, init) : new Response(JSON.stringify({ id: "99" }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------- payload builder

test("buildModsMessage: two buttons in one action row, the right styles and custom_ids", () => {
  const msg = buildModsMessage();
  assert.ok(msg.content.length > 0, "explanatory copy");
  assert.ok(msg.content.includes("Upload or update a mod"));
  assert.equal(msg.components.length, 1);
  assert.equal(msg.components[0].type, 1, "one action row");
  const [a, b] = msg.components[0].components;
  assert.equal(a.custom_id, "mods_upload");
  assert.equal(a.style, 1, "primary");
  assert.equal(a.label, "Upload or update a mod");
  assert.equal(b.custom_id, "mods_signout");
  assert.equal(b.style, 2, "danger");
  assert.equal(b.label, "Sign out everywhere");
});

// --------------------------------------------------- post / edit

test("post: POST the payload into the channel, returns the message id", async () => {
  const f = makeFetch();
  const r = await postModsMessage("tok1", "1234", f);
  assert.deepEqual(r, { ok: true, status: 200, messageId: "99", detail: JSON.stringify({ id: "99" }) });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://discord.com/api/v10/channels/1234/messages");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Authorization"], "Bot tok1");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), buildModsMessage());
});

test("edit: PATCH the given message id, same payload", async () => {
  const f = makeFetch();
  const r = await postModsMessage("tok1", "1234", f, { messageId: "777" });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://discord.com/api/v10/channels/1234/messages/777");
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), buildModsMessage());
});

test("dry-run: no request is sent", async () => {
  const f = makeFetch(() => { throw new Error("should not be called"); });
  const r = await postModsMessage("tok1", "1234", f, { dryRun: true });
  assert.equal(f.calls.length, 0);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
});

test("a non-2xx Discord response (and a thrown error) is a failure with the detail", async () => {
  const f503 = makeFetch(() => new Response("Missing Permissions", { status: 503 }));
  const r1 = await postModsMessage("tok1", "1234", f503);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 503);
  assert.equal(r1.detail, "Missing Permissions");

  const fThrow = makeFetch(() => { throw new Error("offline"); });
  const r2 = await postModsMessage("tok1", "1234", fThrow);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, null);
  assert.match(r2.detail, /offline/);
});
