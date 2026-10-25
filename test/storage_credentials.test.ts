import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  IssuedCredential,
  NemauApiError,
  isCredentialLimit,
  isOrganizationReadOnly,
} from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const FAKE_SECRET = "EXAMPLE-SECRET-NOT-REAL-0123456789";

const ISSUED = {
  access_key_id: "AKEXAMPLE",
  secret_access_key: FAKE_SECRET,
  access: "read_only",
  container: "photos",
  s3_bucket: "nemau-dev-00000000000000000000000000000000",
  region: "fr-occitanie-1",
  endpoint: "",
  created_at: "2026-10-04T16:06:25Z",
  expires_at: null,
};

test("createCredential posts the access and omits an unset expiry", async () => {
  const stub = await startStub((_req, res) => json(res, ISSUED, 201));
  try {
    const got = await clientFor(stub).storage.createCredential("photos", { access: "read_only" });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/storage/containers/photos/credentials");
    assert.deepEqual(JSON.parse(seen.body), { access: "read_only" });
    assert.equal(got.secret_access_key, FAKE_SECRET);
    assert.equal(got.region, "fr-occitanie-1");
    assert.equal(got.endpoint, "");
    assert.equal(got.expires_at, null);
    // The bucket to address is the store's name, not the container's.
    assert.equal(got.container, "photos");
    assert.equal(got.s3_bucket, "nemau-dev-00000000000000000000000000000000");
  } finally {
    await stub.close();
  }
});

test("an issued credential from an older server has an empty s3_bucket, never undefined", () => {
  const { s3_bucket: _omitted, ...older } = ISSUED;
  const got = new IssuedCredential(older as ConstructorParameters<typeof IssuedCredential>[0]);
  assert.equal(got.s3_bucket, "");
});

test("getContainer carries the S3 bucket name next to the public name", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { containers: [{ id: "c-1", name: "photos", bytes: 0, count: 0, s3_bucket: "nemau-dev-11111111111111111111111111111111" }], count: 1 }),
  );
  try {
    const got = await clientFor(stub).storage.getContainer("photos");
    assert.equal(got?.name, "photos");
    assert.equal(got?.s3_bucket, "nemau-dev-11111111111111111111111111111111");
  } finally {
    await stub.close();
  }
});

test("createCredential sends the expiry as RFC 3339 UTC without milliseconds", async () => {
  const stub = await startStub((_req, res) => json(res, { ...ISSUED, expires_at: "2026-10-05T12:00:00Z" }, 201));
  try {
    const got = await clientFor(stub).storage.createCredential("photos", {
      access: "read_write",
      expiresAt: new Date("2026-10-05T12:00:00.789Z"),
    });
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { access: "read_write", expires_at: "2026-10-05T12:00:00Z" });
    assert.equal(got.expires_at, "2026-10-05T12:00:00Z");
  } finally {
    await stub.close();
  }
});

test("invalid input is refused before any call", async () => {
  const stub = await startStub((_req, res) => json(res, ISSUED, 201));
  try {
    const storage = clientFor(stub).storage;
    await assert.rejects(() => storage.createCredential("", { access: "read_only" }), /container is required/);
    await assert.rejects(
      () => storage.createCredential("photos", { access: "admin" as never }),
      /access must be/,
    );
    await assert.rejects(
      () => storage.createCredential("photos", { access: "read_only", expiresAt: new Date("nope") }),
      /not a valid date/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("listCredentials and revokeCredential use the container's own paths", async () => {
  const stub = await startStub((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    json(res, {
      credentials: [
        { access_key_id: "AK1", access: "read_write", container: "photos", created_at: "2026-10-04T16:06:25Z", expires_at: null },
        { access_key_id: "AK2", access: "read_only", container: "photos", created_at: "2026-10-04T16:07:25Z", expires_at: "2026-10-05T12:00:00Z" },
      ],
    });
  });
  try {
    const storage = clientFor(stub).storage;
    const list = await storage.listCredentials("photos");
    assert.equal(stub.requests[0]!.method, "GET");
    assert.equal(stub.requests[0]!.path, "/api/v1/storage/containers/photos/credentials");
    assert.equal(list.length, 2);
    assert.equal(list[0]!.expires_at, null);
    assert.equal(list[1]!.expires_at, "2026-10-05T12:00:00Z");
    assert.ok(!JSON.stringify(list).includes("secret"));

    await storage.revokeCredential("photos", "AKEXAMPLE1");
    assert.equal(stub.requests[1]!.method, "DELETE");
    assert.equal(stub.requests[1]!.path, "/api/v1/storage/containers/photos/credentials/AKEXAMPLE1");
  } finally {
    await stub.close();
  }
});

test("a refusal is classified by its stable code, not its wording", async () => {
  const cases: Array<[number, unknown, boolean, boolean]> = [
    [429, { error: "this container already has the maximum number of access keys", code: "credential_limit" }, true, false],
    [403, { error: "the organization is read-only", code: "organization_read_only" }, false, true],
    [429, { error: "rate limit exceeded" }, false, false],
    [403, { error: "forbidden", reason: "permission_denied" }, false, false],
  ];
  for (const [status, body, limit, readOnly] of cases) {
    const stub = await startStub((_req, res) => json(res, body, status));
    try {
      const error = await clientFor(stub, { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } })
        .storage.createCredential("photos", { access: "read_write" })
        .then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof NemauApiError, JSON.stringify(body));
      assert.equal(isCredentialLimit(error), limit, JSON.stringify(body));
      assert.equal(isOrganizationReadOnly(error), readOnly, JSON.stringify(body));
    } finally {
      await stub.close();
    }
  }
  assert.equal(isCredentialLimit(new Error("plain")), false);
  assert.equal(isCredentialLimit(undefined), false);
});

test("the secret never shows up when the credential is printed, serialised or inspected", () => {
  const cred = new IssuedCredential(ISSUED as ConstructorParameters<typeof IssuedCredential>[0]);
  const outputs = [String(cred), `${cred}`, JSON.stringify(cred), inspect(cred), inspect({ nested: cred }, { depth: 5 })];
  for (const out of outputs) {
    assert.ok(!out.includes(FAKE_SECRET), `leaks the secret: ${out}`);
    assert.ok(out.includes("AKEXAMPLE"), `dropped the access key id: ${out}`);
  }
  // The caller can still read it explicitly.
  assert.equal(cred.secret_access_key, FAKE_SECRET);
});

test("a credential-limit refusal carries its cap when the server says it", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ error: "limit", code: "credential_limit", limit: 10, scope: "bucket" }, 10, "bucket"],
    [{ error: "limit", code: "credential_limit", limit: 50, scope: "project" }, 50, "project"],
    [{ error: "limit", code: "credential_limit" }, 0, ""],
  ];
  for (const [body, limit, scope] of cases) {
    const stub = await startStub((_req, res) => json(res, body, 429));
    try {
      const error = await clientFor(stub, { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } })
        .storage.createCredential("photos", { access: "read_write" })
        .then(() => undefined, (e: unknown) => e);
      assert.ok(isCredentialLimit(error));
      assert.ok(error instanceof NemauApiError);
      assert.equal(error.limit, limit);
      assert.equal(error.scope, scope);
    } finally {
      await stub.close();
    }
  }
});

// Path segments are escaped once, where the method builds them; the transport must not escape again.
test("a name with special characters reaches the server encoded exactly once", async () => {
  for (const name of ["with space", "100%", "a/b", "a+b", "café", "a?b#c", "%2F"]) {
    const stub = await startStub((_req, res) => json(res, { credentials: [] }));
    try {
      await clientFor(stub).storage.listCredentials(name);
      assert.equal(stub.requests[0]!.path, `/api/v1/storage/containers/${encodeURIComponent(name)}/credentials`, name);
    } finally {
      await stub.close();
    }
  }
});
