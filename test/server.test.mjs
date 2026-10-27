import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

function messageRequest(overrides = {}) {
  return {
    tenant_id: "22222222-2222-4222-8222-222222222222",
    requested_by: "commerce-worker",
    command_id: "11111111-1111-4111-8111-111111111111",
    correlation_id: "commerce-correlation-1",
    idempotency_key: "commerce-message-1",
    recipient: "15550000000",
    instance_id: "verified-account-1",
    phone_number_id: "verified-phone-1",
    provider: "meta",
    message: { type: "text", text: "Order received" },
    consent_status: "opted_in",
    opted_out: false,
    campaign_id: "approved-campaign-1",
    business_context: { source: "commerce", consent_evidence: "consent-record-1" },
    ...overrides
  };
}

function acceptedOperation(overrides = {}) {
  return {
    // A distinct operation UUID proves that the API uses the actual acknowledgement.
    operation_id: "33333333-3333-4333-8333-333333333333",
    command_id: "11111111-1111-4111-8111-111111111111",
    state: "QUEUED",
    correlation_id: "commerce-correlation-1",
    duplicate: false,
    ...overrides
  };
}

async function postMessage(base, body) {
  return fetch(base + "/platform/v1/whatsapp/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-test-credential"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000)
  });
}

async function withMiddleware(reply, fn, env = {}) {
  const requests = [];
  const middleware = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    };
    requests.push(request);
    const response = reply(request, requests.length);
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(response.raw ?? JSON.stringify(response.body));
  });
  middleware.listen(0, "127.0.0.1");
  await once(middleware, "listening");
  try {
    await withServer({
      WHATSAPP_PRODUCTION_SEND: "true",
      WHATSAPP_EXTERNAL_RECIPIENTS: "true",
      MIDDLEWARE_COMMAND_TYPE: "whatsapp.message.send.v1",
      ...env,
      MIDDLEWARE_BASE_URL: `http://127.0.0.1:${middleware.address().port}`
    }, (base) => fn(base, requests));
  } finally {
    middleware.close();
    await once(middleware, "close");
  }
}

test("message submission preserves campaign and command identity in the Middleware envelope", async () => {
  await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
    const response = await postMessage(base, messageRequest());
    assert.equal(response.status, 202);
    await response.json();
    assert.equal(requests.length, 1);
    const sent = requests[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/platform/v1/commands");
    assert.equal(sent.headers.authorization, "Bearer local-test-credential");
    assert.equal(sent.headers["x-tenant-id"], "22222222-2222-4222-8222-222222222222");
    assert.equal(sent.headers["x-correlation-id"], "commerce-correlation-1");
    assert.equal(sent.headers["idempotency-key"], "commerce-message-1");
    assert.deepEqual(sent.body, {
      command_id: "11111111-1111-4111-8111-111111111111",
      command_type: "whatsapp.message.send.v1",
      command_version: "1.0",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      requested_by: "commerce-worker",
      correlation_id: "commerce-correlation-1",
      idempotency_key: "commerce-message-1",
      payload: {
        channel: "whatsapp",
        campaign_id: "approved-campaign-1",
        recipient: "15550000000",
        instance_id: "verified-account-1",
        message: { type: "text", text: "Order received" },
        business_context: { source: "commerce", consent_evidence: "consent-record-1" }
      }
    });
  });
});

for (const [name, campaign] of [
  ["missing", undefined], ["null", null], ["empty", ""],
  ["whitespace", " \t "], ["number", 7], ["object", {}]
]) {
  test(`message submission rejects a ${name} campaign before Middleware`, async () => {
    await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
      const response = await postMessage(base, messageRequest({
        campaign_id: campaign,
        business_context: { campaign_id: "context-is-not-campaign-authority" }
      }));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_request");
      assert.equal(requests.length, 0);
    });
  });
}

test("commerce consent evidence is accepted when canonical consent status is absent", async () => {
  await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
    const response = await postMessage(base, messageRequest({ consent_status: undefined, consent_verified: true }));
    assert.equal(response.status, 202);
    await response.json();
    assert.equal(requests.length, 1);
  });
});

for (const [name, consent, reason] of [
  ["missing evidence", { consent_status: undefined }, "consent_not_opted_in"],
  ["false evidence", { consent_status: undefined, consent_verified: false }, "consent_not_opted_in"],
  ["truthy string evidence", { consent_status: undefined, consent_verified: "true" }, "consent_not_opted_in"],
  ["unknown canonical status", { consent_status: "unknown", consent_verified: true }, "consent_not_opted_in"],
  ["opted-out canonical status", { consent_status: "opted_out", consent_verified: true }, "consent_not_opted_in"],
  ["null canonical status", { consent_status: null, consent_verified: true }, "consent_not_opted_in"],
  ["blank canonical status", { consent_status: "", consent_verified: true }, "consent_not_opted_in"],
  ["suppressed commerce contact", { consent_status: undefined, consent_verified: true, suppressed: true }, "suppressed"],
  ["opted-out commerce contact", { consent_status: undefined, consent_verified: true, opted_out: true }, "opted_out"],
  ["suppressed canonical contact", { suppressed: true }, "suppressed"],
  ["opted-out canonical contact", { opted_out: true }, "opted_out"]
]) {
  test(`message submission denies ${name} before Middleware`, async () => {
    await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
      const response = await postMessage(base, messageRequest(consent));
      assert.equal(response.status, 403);
      const result = await response.json();
      assert.equal(result.error.code, "recipient_not_eligible");
      assert.ok(result.error.reasons.includes(reason));
      assert.equal(requests.length, 0);
    });
  });
}

test("canonical opted-in status remains authoritative when compatibility evidence is false", async () => {
  await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
    const response = await postMessage(base, messageRequest({ consent_verified: false }));
    assert.equal(response.status, 202);
    await response.json();
    assert.equal(requests.length, 1);
  });
});

for (const status of [200, 201, 202]) {
  test(`HTTP ${status} exposes the validated durable operation at the top level`, async () => {
    const acknowledgement = acceptedOperation({ duplicate: status === 200 });
    await withMiddleware(() => ({ status, body: acknowledgement }), async (base) => {
      const response = await postMessage(base, messageRequest());
      assert.equal(response.status, status);
      assert.equal(response.headers.get("location"), "/platform/v1/operations/33333333-3333-4333-8333-333333333333");
      assert.deepEqual(await response.json(), {
        command_authority: "middleware-v3",
        command_id: "11111111-1111-4111-8111-111111111111",
        correlation_id: "commerce-correlation-1",
        operation_id: "33333333-3333-4333-8333-333333333333",
        middleware: acknowledgement
      });
    });
  });
}

for (const commandId of [
  "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  "  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa  ",
  "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
  "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa"
]) {
  test(`canonical Middleware UUID acknowledgement matches submitted ${JSON.stringify(commandId)}`, async () => {
    await withMiddleware((_request, count) => ({
      status: count === 1 ? 202 : 200,
      body: acceptedOperation({ command_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", duplicate: count > 1 })
    }), async (base, requests) => {
      for (const status of [202, 200]) {
        const response = await postMessage(base, messageRequest({ command_id: commandId }));
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(body.command_id, commandId);
        assert.equal(body.operation_id, "33333333-3333-4333-8333-333333333333");
      }
      assert.equal(requests[0].body.command_id, commandId.trim());
      assert.deepEqual(requests[0].body, requests[1].body);
    });
  });
}

test("case differences in opaque command references do not acknowledge a different command", async () => {
  await withMiddleware(() => ({ status: 202, body: acceptedOperation({ command_id: "opaque-command" }) }), async (base) => {
    const response = await postMessage(base, messageRequest({ command_id: "OPAQUE-COMMAND" }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "middleware_ack_invalid");
  });
});

for (const [name, response] of [
  ["missing operation", { status: 202, body: acceptedOperation({ operation_id: undefined }) }],
  ["null operation", { status: 202, body: acceptedOperation({ operation_id: null }) }],
  ["non-string operation", { status: 202, body: acceptedOperation({ operation_id: 42 }) }],
  ["empty operation", { status: 202, body: acceptedOperation({ operation_id: "" }) }],
  ["whitespace operation", { status: 202, body: acceptedOperation({ operation_id: " \t " }) }],
  ["oversized operation", { status: 202, body: acceptedOperation({ operation_id: "o".repeat(201) }) }],
  ["invalid Unicode operation", { status: 202, body: acceptedOperation({ operation_id: "\uD800" }) }],
  ["wrong command", { status: 202, body: acceptedOperation({ command_id: "44444444-4444-4444-8444-444444444444" }) }],
  ["missing command", { status: 202, body: acceptedOperation({ command_id: undefined }) }],
  ["array body", { status: 202, body: [] }],
  ["null body", { status: 202, body: null }],
  ["malformed JSON", { status: 202, raw: "private-upstream-body" }],
  ["empty duplicate response", { status: 200, body: {} }],
  ["empty created response", { status: 201, body: {} }],
  ["no-content response", { status: 204, raw: "" }],
  ["partial-content response", { status: 206, body: acceptedOperation() }]
]) {
  test(`a successful Middleware ${name} is a safe retryable acknowledgement failure`, async () => {
    await withMiddleware(() => response, async (base, requests) => {
      const result = await postMessage(base, messageRequest());
      assert.equal(result.status, 502);
      assert.deepEqual(await result.json(), {
        error: {
          code: "middleware_ack_invalid",
          message: "Middleware acknowledgement is invalid",
          retryable: true
        }
      });
      assert.equal(requests.length, 1);
    });
  });
}

test("a 200-character operation ID is accepted without substitution", async () => {
  const operation = "o".repeat(200);
  await withMiddleware(() => ({ status: 202, body: acceptedOperation({ operation_id: operation }) }), async (base) => {
    const response = await postMessage(base, messageRequest());
    assert.equal(response.status, 202);
    assert.equal((await response.json()).operation_id, operation);
  });
});

test("the operation location encodes an opaque ID as one path segment", async () => {
  await withMiddleware(() => ({ status: 202, body: acceptedOperation({ operation_id: "durable/op?part#fragment" }) }), async (base) => {
    const response = await postMessage(base, messageRequest());
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("location"), "/platform/v1/operations/durable%2Fop%3Fpart%23fragment");
    assert.equal((await response.json()).operation_id, "durable/op?part#fragment");
  });
});

test("retry after an ambiguous acknowledgement preserves the original submitted command", async () => {
  await withMiddleware((_request, count) => ({
    status: count === 1 ? 202 : 200,
    body: acceptedOperation(count === 1 ? { operation_id: undefined } : { duplicate: true })
  }), async (base, requests) => {
    const first = await postMessage(base, messageRequest());
    assert.equal(first.status, 502);
    assert.equal((await first.json()).error.retryable, true);
    const second = await postMessage(base, messageRequest());
    assert.equal(second.status, 200);
    const result = await second.json();
    assert.equal(result.command_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.operation_id, "33333333-3333-4333-8333-333333333333");
    assert.equal(result.middleware.duplicate, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
    assert.equal(requests[0].headers["x-correlation-id"], requests[1].headers["x-correlation-id"]);
  });
});

for (const status of [400, 401, 403, 408, 409, 429, 500, 503]) {
  test(`Middleware HTTP ${status} rejection semantics are preserved`, async () => {
    const rejection = { error: { code: "upstream_rejected", retryable: status === 408 || status === 429 || status >= 500 } };
    await withMiddleware(() => ({ status, body: rejection }), async (base) => {
      const response = await postMessage(base, messageRequest());
      assert.equal(response.status, status);
      const result = await response.json();
      assert.deepEqual(result.middleware, rejection);
      assert.equal(result.command_id, "11111111-1111-4111-8111-111111111111");
      assert.equal(Object.hasOwn(result, "operation_id"), false);
    });
  });
}

for (const [name, env, status, code] of [
  ["production send", { WHATSAPP_PRODUCTION_SEND: "false" }, 423, "whatsapp_production_send_disabled"],
  ["external recipients", { WHATSAPP_EXTERNAL_RECIPIENTS: "false" }, 423, "external_recipients_disabled"],
  ["command registration", { MIDDLEWARE_COMMAND_TYPE: "" }, 503, "middleware_whatsapp_command_unregistered"]
]) {
  test(`disabled ${name} prevents any Middleware submission`, async () => {
    await withMiddleware(() => ({ status: 202, body: acceptedOperation() }), async (base, requests) => {
      const response = await postMessage(base, messageRequest());
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
      assert.equal(requests.length, 0);
    }, env);
  });
}
