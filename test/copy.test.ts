import { test } from "node:test";
import assert from "node:assert/strict";
import { NemauApiError } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const COPIED = {
  container: "archive",
  key: "reports/copy.csv",
  size: 1234,
  etag: "9b2cf535f27731c974343645a3985328",
  last_modified: "2026-09-23T10:00:00Z",
};

test("copyObject names the source container in the path and the key in the body", async () => {
  // The key travels in the body: it can contain slashes, which in the path
  // would open extra segments and stop the route matching.
  const stub = await startStub((_req, res) => json(res, COPIED, 201));
  try {
    await clientFor(stub).storage.copyObject("a/b", "reports/2026.csv", {
      destinationContainer: "archive",
      destinationKey: "reports/copy.csv",
      replaceMetadata: true,
      contentType: "text/csv",
      metadata: { owner: "finance" },
    });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/storage/containers/a%2Fb/copy");
    assert.equal(seen.query, "");
    assert.deepEqual(JSON.parse(seen.body), {
      key: "reports/2026.csv",
      destination_container: "archive",
      destination_key: "reports/copy.csv",
      replace_metadata: true,
      content_type: "text/csv",
      metadata: { owner: "finance" },
    });
  } finally {
    await stub.close();
  }
});

test("options left empty are not sent", async () => {
  // Every default is the server's, so an empty option is left out rather than
  // sent as "".
  const stub = await startStub((_req, res) => json(res, COPIED, 201));
  try {
    const storage = clientFor(stub).storage;
    await storage.copyObject("photos", "a/b.jpg");
    await storage.copyObject("photos", "a/b.jpg", {
      destinationContainer: "",
      destinationKey: "",
      replaceMetadata: false,
      contentType: "",
      metadata: {},
    });
    for (const seen of stub.requests) {
      assert.deepEqual(JSON.parse(seen.body), { key: "a/b.jpg" });
    }
  } finally {
    await stub.close();
  }
});

test("a copy decodes with and without retention", async () => {
  const locked = {
    ...COPIED,
    version_id: "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY",
    retention: { mode: "COMPLIANCE", retain_until: "2026-10-23T10:00:01Z" },
  };
  let calls = 0;
  const stub = await startStub((_req, res) => json(res, calls++ === 0 ? COPIED : locked, 201));
  try {
    const storage = clientFor(stub).storage;

    const plain = await storage.copyObject("reports", "2026.csv");
    assert.equal(plain.container, "archive");
    assert.equal(plain.key, "reports/copy.csv");
    assert.equal(plain.size, 1234);
    assert.equal(plain.etag, COPIED.etag);
    assert.equal(plain.last_modified, "2026-09-23T10:00:00Z");
    assert.equal(plain.version_id, undefined);
    assert.equal(plain.retention, undefined);

    const worm = await storage.copyObject("reports", "2026.csv", { destinationContainer: "archive" });
    assert.equal(worm.version_id, locked.version_id);
    assert.deepEqual(worm.retention, { mode: "COMPLIANCE", retain_until: "2026-10-23T10:00:01Z" });
  } finally {
    await stub.close();
  }
});

test("metadata or a content type without replaceMetadata is refused before any call", async () => {
  // Refused client-side so the caller learns the rule from the message rather
  // than from a 400 after a round trip.
  const stub = await startStub((_req, res) => json(res, COPIED, 201));
  try {
    const storage = clientFor(stub).storage;
    await assert.rejects(
      () => storage.copyObject("reports", "2026.csv", { metadata: { owner: "finance" } }),
      /require replaceMetadata/,
    );
    await assert.rejects(
      () => storage.copyObject("reports", "2026.csv", { contentType: "text/csv" }),
      /require replaceMetadata/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a source over the copy limit surfaces as an API error", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { error: "object exceeds the 5 GiB server-side copy limit" }, 413),
  );
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.storage.copyObject("backups", "disk.img", { destinationContainer: "archive" }),
      (error: unknown) => {
        assert.ok(error instanceof NemauApiError);
        assert.equal(error.statusCode, 413);
        assert.match(error.message, /5 GiB server-side copy limit/);
        return true;
      },
    );
    assert.equal(stub.requests.length, 1, "a 413 must not be retried");
  } finally {
    await stub.close();
  }
});
