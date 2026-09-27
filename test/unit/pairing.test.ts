import "../helpers/env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const db = await import("../../src/db.js");
const auth = await import("../../src/auth.js");
const pairing = await import("../../src/pairing.js");
const { normalizePublicUrl } = await import("../../src/config.js");
const { cookieMatchesDomain, selectProviderState, sessionDomains } = await import("../../src/providers/browser/domains.js");
const { GROK_DEFAULTS, CHATGPT_DEFAULTS } = await import("../../src/providers/defaults.js");

const req = (headers: Record<string, string> = {}, url = "/") => ({ headers, url, socket: { remoteAddress: "127.0.0.1" } }) as unknown as import("node:http").IncomingMessage;

describe("pairing: sign in from your own computer", () => {
  it("a code becomes a scoped token once, then dies with the import", async () => {
    const { row, code } = await pairing.createPairing("grok");
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, "unambiguous characters, shown in two groups");
    assert.equal(row.status, "waiting");
    assert.equal((await pairing.activePairing("grok"))?.status, "waiting");
    assert.equal(await pairing.exchangePairing("nope", "1.2.3.4"), null);

    const ex = await pairing.exchangePairing(code.toLowerCase().replace("-", " "), "1.2.3.4");
    assert.ok(ex, "spacing and case do not matter");
    assert.ok(ex!.token.startsWith("acp_pair_"));
    assert.equal(ex!.row.status, "paired");
    assert.equal(await pairing.exchangePairing(code, "1.2.3.4"), null, "a code is single use");

    const found = await pairing.pairingFromRequest(req({ authorization: `Bearer ${ex!.token}` }));
    assert.equal(found?.id, row.id);
    assert.equal(await pairing.pairingFromRequest(req({}, `/x?token=${ex!.token}`)), undefined, "never from the query string");
    assert.equal(await auth.isAdmin(req({ authorization: `Bearer ${ex!.token}` })), false, "the token is not an admin credential");
    assert.equal(await auth.isIngest(req({ authorization: `Bearer ${ex!.token}` })), false, "nor an ingest one");

    await pairing.markImporting(row.id);
    assert.equal((await pairing.activePairing("grok"))?.status, "importing");
    const done = await pairing.finishPairing(row.id, "done", "Grok connected");
    assert.equal(done?.token_hash, null, "the token is gone once the import completed");
    assert.equal(await pairing.pairingFromRequest(req({ authorization: `Bearer ${ex!.token}` })), undefined);
    assert.equal((await pairing.activePairing("grok"))?.status, "done", "a just-finished pairing stays visible briefly");
    const actions = (await db.listAudit({ limit: 20 })).map((a) => a.action);
    assert.ok(actions.includes("signin.pairing_created") && actions.includes("signin.pairing_exchanged"));
  });

  it("codes expire, a newer code retires an older one, and cancel ends whatever is open", async () => {
    const first = await pairing.createPairing("chatgpt");
    db.db.prepare("UPDATE pairings SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), first.row.id);
    assert.equal(await pairing.exchangePairing(first.code, "1.2.3.4"), null, "an expired code is refused");
    assert.equal((await db.getPairing(first.row.id))?.status, "expired");

    const a = await pairing.createPairing("chatgpt");
    const b = await pairing.createPairing("chatgpt");
    assert.equal((await db.getPairing(a.row.id))?.status, "replaced");
    assert.equal(await pairing.exchangePairing(a.code, "1.2.3.4"), null, "the replaced code no longer works");
    assert.ok(await pairing.exchangePairing(b.code, "1.2.3.4"));
    assert.equal(await pairing.cancelPairing("chatgpt"), true);
    assert.equal((await db.getPairing(b.row.id))?.status, "cancelled");
    assert.equal((await db.getPairing(b.row.id))?.token_hash, null);
    assert.equal(await pairing.cancelPairing("chatgpt"), false, "nothing left to cancel");
    const failed = await pairing.createPairing("chatgpt");
    await pairing.finishPairing(failed.row.id, "failed", "still signed out");
    assert.ok((await db.listAudit({ action: "signin.pairing_failed" })).length >= 1);
  });

  it("takes the deployment's address the way people write it", () => {
    // Whatever is in PUBLIC_URL ends up in the command someone pastes on another computer.
    assert.equal(normalizePublicUrl("my-app.up.railway.app"), "https://my-app.up.railway.app", "a bare domain is an address, not a mistake");
    assert.equal(normalizePublicUrl("  https://my-app.up.railway.app/  "), "https://my-app.up.railway.app");
    assert.equal(normalizePublicUrl("https://my-app.up.railway.app///"), "https://my-app.up.railway.app");
    assert.equal(normalizePublicUrl("http://localhost:8080"), "http://localhost:8080", "http is kept: it is someone's own machine");
    assert.equal(normalizePublicUrl(""), "");
    assert.equal(normalizePublicUrl(undefined), "");
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
