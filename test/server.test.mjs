import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

async function withServer(env, fn) {
  const server = createApp(loadConfig({ PORT: "0", ...env }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); await once(server, "close"); }
}

test("strict eligibility blocks non-opted-in contacts", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/contacts/eligibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "15550000000", consent_status: "unknown", suppressed: false })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eligible, false);
    assert.ok(body.reasons.includes("consent_not_opted_in"));
  });
});

test("production send is fail-closed by default", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 423);
    const body = await res.json();
    assert.equal(body.error.code, "whatsapp_production_send_disabled");
  });
});

test("readiness reports Middleware registry dependency", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + "/readyz");
    const body = await res.json();
    assert.equal(body.middleware_command_type_configured, false);
    assert.equal(body.safe_mode, true);
  });
});


test("WhatsApp production flag alone cannot bypass governance effect gates", async () => {
  const approved = {
    WHATSAPP_PRODUCTION_SEND: "true", PRODUCTION_GO: "YES",
    LIVE_CAPABILITIES_ENABLED: "YES", EXTERNAL_EFFECTS: "true"
  };
  assert.equal(loadConfig(approved).productionSend, true);
  for (const missing of ["WHATSAPP_PRODUCTION_SEND", "PRODUCTION_GO", "LIVE_CAPABILITIES_ENABLED", "EXTERNAL_EFFECTS"]) {
    const env = { ...approved }; delete env[missing];
    assert.equal(loadConfig(env).productionSend, false, `missing ${missing} must fail closed`);
  }
  for (const disabled of ["NO", "false", "0", ""]) {
    assert.equal(loadConfig({ ...approved, PRODUCTION_GO: disabled }).productionSend, false);
  }
  await withServer({ WHATSAPP_PRODUCTION_SEND: "true" }, async base => {
    const response = await fetch(base + "/platform/v1/whatsapp/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 423);
    assert.equal((await response.json()).error.code,"whatsapp_production_send_disabled");
  });
});
