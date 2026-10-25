import { test } from "node:test";
import assert from "node:assert/strict";
import { isIdempotencyKeyMismatch, isRateLimited, NemauApiError } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";
import type { ServerResponse } from "node:http";

const accepted = (res: ServerResponse, extra: Record<string, string> = {}) => {
  res.writeHead(202, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify({ task_id: "task-1", status: "pending" }));
};

const instance = { name: "web", image_id: "ubuntu", vcpus: 1, ram_mb: 512, disk_gb: 10 };

test("every asynchronous write carries a fresh Idempotency-Key", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    await nemau.compute.createInstance(instance);
    await nemau.compute.createInstance(instance);
    const [a, b] = stub.requests.map((r) => String(r.headers["idempotency-key"]));
    assert.match(a!, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.notEqual(a, b, "two logical writes must not share a key");
  } finally {
    await stub.close();
  }
});

test("reads send no Idempotency-Key", async () => {
  const stub = await startStub((_req, res) => json(res, { instances: [] }));
  try {
    await clientFor(stub).compute.listInstances();
    assert.equal(stub.requests[0]!.headers["idempotency-key"], undefined);
  } finally {
    await stub.close();
  }
});

test("withIdempotencyKey overrides the generated key and leaves the original client alone", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    await nemau.withIdempotencyKey("order-42:create").compute.createInstance(instance);
    await nemau.compute.createInstance(instance);
    assert.equal(stub.requests[0]!.headers["idempotency-key"], "order-42:create");
    assert.notEqual(stub.requests[1]!.headers["idempotency-key"], "order-42:create");
  } finally {
    await stub.close();
  }
});

test("a malformed key is refused before any request", async () => {
  const stub = await startStub((_req, res) => accepted(res));
  try {
    const nemau = clientFor(stub);
    for (const bad of ["", "has space", "a/b", "x".repeat(129), "café"]) {
      assert.throws(() => nemau.withIdempotencyKey(bad), /Idempotency-Key/, JSON.stringify(bad));
    }
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a replay is flagged on the task reference", async () => {
  let n = 0;
  const stub = await startStub((_req, res) => accepted(res, ++n === 2 ? { "Idempotent-Replayed": "true" } : {}));
  try {
    const nemau = clientFor(stub);
    const first = await nemau.withIdempotencyKey("k1").compute.createInstance(instance);
    const second = await nemau.withIdempotencyKey("k1").compute.createInstance(instance);
    assert.equal(first.replayed, undefined);
    assert.equal(second.replayed, true);
    assert.equal(second.task_id, first.task_id);
  } finally {
    await stub.close();
  }
});

test("a 422 key mismatch is classified and never retried", async () => {
  const stub = await startStub((_req, res) => json(res, { error: "idempotency_key_mismatch" }, 422));
  try {
    const error = await clientFor(stub)
      .withIdempotencyKey("k1")
      .compute.createInstance(instance)
      .then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NemauApiError);
    assert.equal(error.statusCode, 422);
    assert.ok(isIdempotencyKeyMismatch(error));
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
  assert.equal(isIdempotencyKeyMismatch(new Error("x")), false);
});

test("a write refused with 429 is retried under the same key", async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    if (++calls < 3) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      return res.end(JSON.stringify({ error: "rate limit exceeded", code: "rate_limited" }));
    }
    accepted(res);
  });
  try {
    const ref = await clientFor(stub).compute.createInstance(instance);
    assert.equal(ref.task_id, "task-1");
    assert.equal(calls, 3);
    const keys = new Set(stub.requests.map((r) => r.headers["idempotency-key"]));
    assert.equal(keys.size, 1, "a retry must reuse the key");
  } finally {
    await stub.close();
  }
});

test("a 503 on a write is retried, and Retry-After is honoured", async () => {
  let calls = 0;
  const stub = await startStub((_req, res) => {
    if (++calls === 1) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ error: "service temporarily unavailable", code: "unavailable" }));
    }
    accepted(res);
  });
  try {
    const started = Date.now();
    await clientFor(stub).compute.createInstance(instance);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 900, "the one-second Retry-After must be waited out");
  } finally {
    await stub.close();
  }
});

test("a Retry-After beyond the bound is surfaced, not slept through", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
    res.end(JSON.stringify({ error: "rate limit exceeded", code: "rate_limited" }));
  });
  try {
    const nemau = clientFor(stub, { retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 5000 } });
    const error = await nemau.compute.createInstance(instance).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NemauApiError);
    assert.ok(isRateLimited(error));
    assert.equal(error.retryAfterMs, 60_000);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test("retries are bounded", async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
    res.end(JSON.stringify({ error: "rate limit exceeded", code: "rate_limited" }));
  });
  try {
    await assert.rejects(clientFor(stub).compute.createInstance(instance), NemauApiError);
    assert.equal(stub.requests.length, 3, "maxAttempts of the test client");
  } finally {
    await stub.close();
  }
});

test("a write without a key is not replayed after a 429 or 503", async () => {
  for (const status of [429, 503]) {
    const stub = await startStub((_req, res) => json(res, { error: "busy" }, status));
    try {
      // IAM writes are synchronous and carry no key.
      await assert.rejects(clientFor(stub).iam.createUser({ username: "ada", email: "ada@example.com" }), NemauApiError);
      assert.equal(stub.requests.length, 1, `status ${status}`);
    } finally {
      await stub.close();
    }
  }
});

test("a 500 on an unkeyed write is not replayed, a 500 on a read is", async () => {
  const post = await startStub((_req, res) => json(res, { error: "boom" }, 500));
  try {
    await assert.rejects(clientFor(post).iam.createUser({ username: "ada", email: "ada@example.com" }));
    assert.equal(post.requests.length, 1);
  } finally {
    await post.close();
  }
  const get = await startStub((_req, res) => json(res, { error: "boom" }, 500));
  try {
    await assert.rejects(clientFor(get).compute.listInstances());
    assert.equal(get.requests.length, 3);
  } finally {
    await get.close();
  }
});

test("a 429 that names a cap is not retried", async () => {
  const stub = await startStub((_req, res) => json(res, { error: "full", code: "credential_limit" }, 429));
  try {
    await assert.rejects(clientFor(stub).storage.createCredential("photos", { access: "read_write" }), NemauApiError);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test("Retry-After is read as seconds or as an HTTP date", async () => {
  const { parseRetryAfter } = await import("../src/errors.ts");
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(parseRetryAfter("soon"), 0);
  const now = Date.parse("2026-10-10T10:00:00Z");
  assert.equal(parseRetryAfter("Sat, 10 Oct 2026 10:00:45 GMT", now), 45_000);
  assert.equal(parseRetryAfter("Sat, 10 Oct 2026 09:00:00 GMT", now), 0);
});
