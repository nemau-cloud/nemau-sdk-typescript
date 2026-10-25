import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESIGN_TTL_CAP_SECONDS } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const PRESIGNED = {
  url: "https://s3.example.test/bucket/a.txt?X-Amz-Signature=abc",
  method: "GET",
  expires_at: "2099-01-01T00:00:00Z",
};

test("presignGet calls the endpoint and passes the expiry", async () => {
  const stub = await startStub((_req, res) => json(res, PRESIGNED));
  try {
    const presigned = await clientFor(stub).storage.presignGet("bucket", "a/b.txt", 300);
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/storage/containers/bucket/presign");
    assert.deepEqual(JSON.parse(seen.body), { key: "a/b.txt", method: "GET", expires_in: 300 });
    assert.equal(presigned.url, PRESIGNED.url);
  } finally {
    await stub.close();
  }
});

test("an expiry over the cap is refused before any call", async () => {
  // Refused client-side so the caller learns the cap from the message rather
  // than from a 400 after a round trip.
  const stub = await startStub((_req, res) => json(res, PRESIGNED));
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.storage.presignGet("bucket", "k", PRESIGN_TTL_CAP_SECONDS + 1),
      /exceeds the/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("fetchPresigned sends no credential to the object store", async () => {
  // A presigned URL is already authorised; attaching the access key would hand
  // it to a host that is not the API.
  const store = await startStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("content");
  });
  const api = await startStub((_req, res) => json(res, { ...PRESIGNED, url: store.url + "/o" }));
  try {
    const { AccessKey } = await import("../src/index.ts");
    const nemau = clientFor(api, { credential: new AccessKey("AKIA", "s3cr3t") });

    const presigned = await nemau.storage.presignGet("bucket", "a.txt");
    const response = await nemau.storage.fetchPresigned(presigned);
    assert.equal(await response.text(), "content");

    const seen = store.requests[0]!;
    assert.equal(seen.headers["x-access-key-id"], undefined);
    assert.equal(seen.headers["authorization"], undefined);
  } finally {
    await api.close();
    await store.close();
  }
});

test("a download error does not leak the signature", async () => {
  const store = await startStub((_req, res) => {
    res.writeHead(403);
    res.end("expired");
  });
  const api = await startStub((_req, res) =>
    json(res, { ...PRESIGNED, url: store.url + "/o?X-Amz-Signature=deadbeefsecret" }),
  );
  try {
    const nemau = clientFor(api);
    const presigned = await nemau.storage.presignGet("bucket", "a.txt");
    await assert.rejects(
      () => nemau.storage.fetchPresigned(presigned),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("deadbeefsecret"), "the signature leaks into the error");
        return true;
      },
    );
  } finally {
    await api.close();
    await store.close();
  }
});
