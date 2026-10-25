import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccessKeyLimit, MAX_ACCESS_KEY_TTL_MS, NemauApiError } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

test("users are listed from /iam/users", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { data: [{ id: "u1", type: "owner" }], total: 1, page: 2, limit: 50, total_pages: 2, has_more: false }),
  );
  try {
    const page = await clientFor(stub).iam.listUsers({ page: 2, limit: 50 });
    assert.equal(stub.requests[0]!.path, "/api/v1/iam/users");
    assert.equal(stub.requests[0]!.query, "page=2&limit=50");
    assert.equal(page.data[0]!.id, "u1");
  } finally {
    await stub.close();
  }
});

test("iterateUsers walks every page", async () => {
  const stub = await startStub((req, res) => {
    const page = Number(new URLSearchParams(req.query).get("page"));
    json(res, { data: [{ id: `u${page}` }], total: 3, page, limit: 1, total_pages: 3, has_more: page < 3 });
  });
  try {
    const ids: string[] = [];
    for await (const user of clientFor(stub).iam.iterateUsers({ limit: 1 })) ids.push(user.id);
    assert.deepEqual(ids, ["u1", "u2", "u3"]);
  } finally {
    await stub.close();
  }
});

test("createUser sends only the declared fields", async () => {
  const stub = await startStub((_req, res) => json(res, { id: "u9", type: "member" }, 201));
  try {
    const request = { username: "ada", email: "ada@example.com", extra: "x" } as never;
    await clientFor(stub).iam.createUser(request);
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { username: "ada", email: "ada@example.com" });
  } finally {
    await stub.close();
  }
});

test("updateUser needs a field and sends only those given", async () => {
  const stub = await startStub((_req, res) => json(res, { id: "u1" }));
  try {
    const nemau = clientFor(stub);
    await assert.rejects(nemau.iam.updateUser("u1", {}), /at least one field/);
    assert.equal(stub.requests.length, 0);
    await nemau.iam.updateUser("u1", { surname: "Lovelace" });
    assert.equal(stub.requests[0]!.method, "PUT");
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { surname: "Lovelace" });
  } finally {
    await stub.close();
  }
});

test("deleteUser sends the confirmation the API requires", async () => {
  const stub = await startStub((_req, res) => json(res, { message: "User deleted successfully" }));
  try {
    await clientFor(stub).iam.deleteUser("u1", "ada@example.com");
    assert.equal(stub.requests[0]!.method, "DELETE");
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), {
      confirmUserId: "u1",
      confirmEmail: "ada@example.com",
      confirmPhrase: "DELETE",
    });
  } finally {
    await stub.close();
  }
});

test("an access key without expiresAt sends an empty object", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { accessKey: { id: "k1", accessKeyId: "AKIAEXAMPLE", expiresAt: "2027-01-08T00:00:00Z" }, secretAccessKey: "s" }, 201),
  );
  try {
    const out = await clientFor(stub).iam.createAccessKey("u1");
    assert.equal(stub.requests[0]!.path, "/api/v1/iam/users/u1/access-keys");
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), {});
    assert.equal(out.accessKey.expiresAt, "2027-01-08T00:00:00Z");
  } finally {
    await stub.close();
  }
});

test("expiresAt is sent as RFC 3339 and checked against the 365 day ceiling", async () => {
  const stub = await startStub((_req, res) => json(res, { accessKey: { id: "k1" }, secretAccessKey: "s" }, 201));
  try {
    const nemau = clientFor(stub);
    const ok = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await nemau.iam.createAccessKey("u1", { description: "ci", expiresAt: ok });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { description: "ci", expiresAt: ok.toISOString() });

    const refused: Array<Date | string> = [
      new Date(Date.now() - 1000),
      new Date(Date.now() + MAX_ACCESS_KEY_TTL_MS + 3600_000),
      "tomorrow",
    ];
    for (const bad of refused) {
      await assert.rejects(nemau.iam.createAccessKey("u1", { expiresAt: bad }), /expiresAt/, String(bad));
    }
    assert.equal(stub.requests.length, 1, "refused before any request");
  } finally {
    await stub.close();
  }
});

test("the sixth active key is a 409 access_key_limit, not retried", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { error: "maximum number of active access keys (5) reached", reason: "access_key_limit" }, 409),
  );
  try {
    const error = await clientFor(stub).iam.createAccessKey("u1").then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NemauApiError);
    assert.equal(error.statusCode, 409);
    assert.ok(isAccessKeyLimit(error));
    assert.equal(stub.requests.length, 1);

    assert.equal(isAccessKeyLimit(new NemauApiError({ statusCode: 409, message: "x", reason: "subnet_overlap", method: "POST", path: "/" })), false);
  } finally {
    await stub.close();
  }
});

test("accessKeyLimits reads the caller's count, or a named user's", async () => {
  const stub = await startStub((_req, res) => json(res, { maxAccessKeys: 5, current: 2 }));
  try {
    const nemau = clientFor(stub);
    assert.deepEqual(await nemau.iam.accessKeyLimits(), { maxAccessKeys: 5, current: 2 });
    await nemau.iam.accessKeyLimits("u 2");
    assert.equal(stub.requests[0]!.path, "/api/v1/iam/access-keys/limits");
    assert.equal(stub.requests[0]!.query, "");
    assert.equal(stub.requests[1]!.query, "userId=u+2");
  } finally {
    await stub.close();
  }
});

test("status, rotation and deletion use the key routes", async () => {
  const stub = await startStub((_req, res) => json(res, { accessKey: { id: "k1" }, secretAccessKey: "new", message: "ok" }));
  try {
    const nemau = clientFor(stub);
    await nemau.iam.setAccessKeyStatus("u1", "k1", "inactive");
    const rotated = await nemau.iam.rotateAccessKey("u1", "k1");
    await nemau.iam.deleteAccessKey("u1", "k1");
    assert.deepEqual(
      stub.requests.map((r) => `${r.method} ${r.path}`),
      [
        "PATCH /api/v1/iam/users/u1/access-keys/k1/status",
        "POST /api/v1/iam/users/u1/access-keys/k1/rotate",
        "DELETE /api/v1/iam/users/u1/access-keys/k1",
      ],
    );
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { status: "inactive" });
    assert.equal(rotated.secretAccessKey, "new");
  } finally {
    await stub.close();
  }
});

test("a reactivation beyond the cap is a 409 access_key_limit", async () => {
  const stub = await startStub((_req, res) => json(res, { error: "maximum", reason: "access_key_limit" }, 409));
  try {
    const error = await clientFor(stub).iam.setAccessKeyStatus("u1", "k1", "active").then(() => undefined, (e: unknown) => e);
    assert.ok(isAccessKeyLimit(error));
  } finally {
    await stub.close();
  }
});

test("without credentials the API's 401 is surfaced", async () => {
  const stub = await startStub((_req, res) => json(res, { error: "authentication required" }, 401));
  try {
    const error = await clientFor(stub).iam.listUsers().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof NemauApiError && error.unauthorized);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});
