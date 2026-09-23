import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const auth = await import("../../src/auth.js");
const pairing = await import("../../src/pairing.js");
const { cookieMatchesDomain, selectProviderState, sessionDomains } = await import("../../src/providers/browser/domains.js");
const { GROK_DEFAULTS, CHATGPT_DEFAULTS } = await import("../../src/providers/defaults.js");

const req = (headers: Record<string, string> = {}, url = "/") => ({ headers, url, socket: { remoteAddress: "127.0.0.1" } }) as unknown as import("node:http").IncomingMessage;

describe("pairing: sign in from your own computer", () => {
  it("a code becomes a scoped token once, then dies with the import", () => {
    const { row, code } = pairing.createPairing("grok");
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, "unambiguous characters, shown in two groups");
    assert.equal(row.status, "waiting");
    assert.equal(pairing.activePairing("grok")?.status, "waiting");
    assert.equal(pairing.exchangePairing("nope", "1.2.3.4"), null);

    const ex = pairing.exchangePairing(code.toLowerCase().replace("-", " "), "1.2.3.4");
    assert.ok(ex, "spacing and case do not matter");
    assert.ok(ex!.token.startsWith("acp_pair_"));
    assert.equal(ex!.row.status, "paired");
    assert.equal(pairing.exchangePairing(code, "1.2.3.4"), null, "a code is single use");

    const found = pairing.pairingFromRequest(req({ authorization: `Bearer ${ex!.token}` }));
    assert.equal(found?.id, row.id);
    assert.equal(pairing.pairingFromRequest(req({}, `/x?token=${ex!.token}`)), undefined, "never from the query string");
    assert.equal(auth.isAdmin(req({ authorization: `Bearer ${ex!.token}` })), false, "the token is not an admin credential");
    assert.equal(auth.isIngest(req({ authorization: `Bearer ${ex!.token}` })), false, "nor an ingest one");

    pairing.markImporting(row.id);
    assert.equal(pairing.activePairing("grok")?.status, "importing");
    const done = pairing.finishPairing(row.id, "done", "Grok connected");
    assert.equal(done?.token_hash, null, "the token is gone once the import completed");
    assert.equal(pairing.pairingFromRequest(req({ authorization: `Bearer ${ex!.token}` })), undefined);
    assert.equal(pairing.activePairing("grok")?.status, "done", "a just-finished pairing stays visible briefly");
    const actions = db.listAudit({ limit: 20 }).map((a) => a.action);
    assert.ok(actions.includes("signin.pairing_created") && actions.includes("signin.pairing_exchanged"));
  });

  it("codes expire, a newer code retires an older one, and cancel ends whatever is open", () => {
    const first = pairing.createPairing("chatgpt");
    db.db.prepare("UPDATE pairings SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), first.row.id);
    assert.equal(pairing.exchangePairing(first.code, "1.2.3.4"), null, "an expired code is refused");
    assert.equal(db.getPairing(first.row.id)?.status, "expired");

    const a = pairing.createPairing("chatgpt");
    const b = pairing.createPairing("chatgpt");
    assert.equal(db.getPairing(a.row.id)?.status, "replaced");
    assert.equal(pairing.exchangePairing(a.code, "1.2.3.4"), null, "the replaced code no longer works");
    assert.ok(pairing.exchangePairing(b.code, "1.2.3.4"));
    assert.equal(pairing.cancelPairing("chatgpt"), true);
    assert.equal(db.getPairing(b.row.id)?.status, "cancelled");
    assert.equal(db.getPairing(b.row.id)?.token_hash, null);
    assert.equal(pairing.cancelPairing("chatgpt"), false, "nothing left to cancel");
    const failed = pairing.createPairing("chatgpt");
    pairing.finishPairing(failed.row.id, "failed", "still signed out");
    assert.ok(db.listAudit({ action: "signin.pairing_failed" }).length >= 1);
  });

  it("knows which cookies belong to a provider's session", () => {
    const grok = sessionDomains(GROK_DEFAULTS);
    assert.ok(grok.includes("grok.com") && grok.includes("x.ai"), `grok domains: ${grok.join(", ")}`);
    assert.ok(sessionDomains(CHATGPT_DEFAULTS).includes("openai.com"));
    assert.equal(cookieMatchesDomain(".x.ai", ["x.ai"]), true);
    assert.equal(cookieMatchesDomain("accounts.x.ai", ["x.ai"]), true);
    assert.equal(cookieMatchesDomain("notx.ai", ["x.ai"]), false);
    assert.equal(cookieMatchesDomain("grok.com.evil.example", ["grok.com"]), false);

    const picked = selectProviderState(
      {
        cookies: [
          { name: "sso", value: "abc", domain: ".grok.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "x", value: "1", domain: "accounts.x.ai", path: "/", expires: Date.now() / 1000 + 3600 },
          { name: "stale", value: "1", domain: ".grok.com", path: "/", expires: 1 },
          { name: "foreign", value: "1", domain: ".google.com", path: "/" },
          { value: "no name", domain: ".grok.com" },
          "garbage",
        ],
        origins: [
          { origin: "https://grok.com", localStorage: [{ name: "k", value: "v" }, { name: 1, value: "bad" }] },
          { origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] },
        ],
      },
      grok,
    );
    assert.deepEqual(picked.cookies.map((c) => c.name), ["sso", "x"]);
    assert.equal(picked.cookies[1].sameSite, "Lax", "defaults fill in what the helper did not send");
    assert.deepEqual(picked.origins, [{ origin: "https://grok.com", localStorage: [{ name: "k", value: "v" }] }]);
    assert.equal(picked.dropped, 6);
  });
});
