// A fake D1 matching prepared statements by their SQL string, with
// SQLite-like transition semantics and changed-row counts
// (`meta.changes`). Covers the auth statements (ASQL) and the mirror
// statements (MSQL). Nothing touches the network.

import { ASQL } from "../../src/auth.js";
import { MSQL } from "../../src/mirror.js";

export class FakeD1 {
  constructor() {
    this.tokens = new Map();    // tokens: hash -> row
    this.codes = new Map();     // login_codes: hash -> row
    this.threads = new Map();   // mod_threads: mod_key -> row
    this.seen = new Map();      // seen_events: event_id -> row
  }
  // -- test introspection
  tokenRows() { return [...this.tokens.values()]; }
  codeRows() { return [...this.codes.values()]; }
  modThread(key) { return this.threads.get(key) || null; }
  seenEvent(id) { return this.seen.get(id) || null; }
  prepare(sql) {
    const self = this;
    return {
      bind(...args) {
        const run = () => self.exec(sql, args);
        return {
          __exec: run,
          run: async () => ({ meta: { changes: run() } }),
          first: async () => {
            const out = run();
            return Array.isArray(out) ? (out[0] || null) : out;
          },
          all: async () => {
            const out = run();
            return { results: Array.isArray(out) ? out : (out ? [out] : []) };
          },
        };
      },
    };
  }
  batch(stmts) {
    const out = [];
    for (const st of stmts) out.push({ meta: { changes: st.__exec() } });
    return out;
  }
  // Returns the changed-row count (or the row/rows for reads).
  exec(sql, a) {
    switch (sql) {
      // ---- tokens + login_codes (ASQL)
      case ASQL.deleteManual: {
        let n = 0;
        for (const [h, r] of this.tokens)
          if (r.discord_id === a[0] && r.kind === "manual") { this.tokens.delete(h); n++; }
        return n;
      }
      case ASQL.insertToken:
        this.tokens.set(a[0], { hash: a[0], discord_id: a[1], username: a[2], kind: a[3],
          created_at: a[4], expires_at: a[5] });
        return 1;
      case ASQL.getToken:
        return this.tokens.get(a[0]) || null;
      case ASQL.deleteWeb: {
        const r = this.tokens.get(a[0]);
        if (r && r.kind === "web") { this.tokens.delete(a[0]); return 1; }
        return 0;
      }
      case ASQL.deleteAllTokens: {
        let n = 0;
        for (const [h, r] of this.tokens)
          if (r.discord_id === a[0]) { this.tokens.delete(h); n++; }
        return n;
      }
      case ASQL.codeCount60s:
        return { n: [...this.codes.values()].filter((r) => r.discord_id === a[0] && r.created_at > a[1]).length };
      case ASQL.invalidateCodes: {
        let n = 0;
        for (const r of this.codes.values())
          if (r.discord_id === a[0] && !r.used_at) { r.used_at = a[1]; n++; }
        return n;
      }
      case ASQL.insertCode:
        this.codes.set(a[0], { hash: a[0], discord_id: a[1], username: a[2],
          created_at: a[3], expires_at: a[4], used_at: null });
        return 1;
      case ASQL.deleteOldCodes: {
        let n = 0;
        for (const [h, r] of this.codes)
          if (r.created_at < a[0]) { this.codes.delete(h); n++; }
        return n;
      }
      case ASQL.getCode:
        return this.codes.get(a[0]) || null;
      case ASQL.burnCode: {
        const r = this.codes.get(a[1]);
        if (r && !r.used_at && r.expires_at > a[0]) { r.used_at = a[0]; return 1; }
        return 0;
      }
      // ---- mod_threads + seen_events (MSQL)
      case MSQL.seenGet:
        return this.seen.get(a[0]) || null;
      case MSQL.seenInsert:
        if (this.seen.has(a[0])) return 0;
        this.seen.set(a[0], { event_id: a[0], created_at: a[1] });
        return 1;
      case MSQL.seenSweep: {
        let n = 0;
        for (const [k, r] of [...this.seen]) if (r.created_at < a[0]) { this.seen.delete(k); n++; }
        return n;
      }
      case MSQL.threadGet:
        return this.threads.get(a[0]) || null;
      case MSQL.threadSet:
        this.threads.set(a[0], { mod_key: a[0], thread_id: a[1], created_at: a[2] });
        return 1;
      default:
        throw new Error(`FakeD1: unknown statement ${sql}`);
    }
  }
}
