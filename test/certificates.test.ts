import { test } from "node:test";
import assert from "node:assert/strict";
import { isCertificateInUse } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

// Placeholders ("CERT", "KEY"): the SDK relays PEM as given, the API validates.

test("importing a certificate posts the PEM and returns its metadata", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      id: "crt-1", name: "www", fingerprint_sha256: "AB:CD", subject: "www.example.com",
      domains: ["www.example.com"], issuer: "Example CA (R11)", not_before: "2026-09-01T00:00:00Z",
      not_after: "2026-12-01T00:00:00Z", key_algorithm: "ECDSA-P256", chain_length: 1, used_by: [],
      created_at: "2026-09-23T10:00:00Z",
    }, 201),
  );
  try {
    const cert = await clientFor(stub).loadBalancer.importCertificate({ name: "www", certificate: "CERT", private_key: "KEY" });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/network/load-balancer-certificates");
    assert.deepEqual(JSON.parse(seen.body), { name: "www", certificate: "CERT", private_key: "KEY" });
    assert.equal(cert.id, "crt-1");
    assert.equal(cert.domains[0], "www.example.com");
  } finally {
    await stub.close();
  }
});

test("certificates are listed, read and deleted", async () => {
  const stub = await startStub((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
    } else if (req.path.endsWith("/crt-1")) {
      json(res, { id: "crt-1", name: "www", used_by: [] });
    } else {
      json(res, { certificates: [{ id: "crt-1", name: "www", used_by: [{ listener_id: "lis-1", listener_name: "https" }] }], count: 1 });
    }
  });
  try {
    const lb = clientFor(stub).loadBalancer;
    const listed = await lb.listCertificates();
    assert.equal(listed[0]!.used_by[0]!.listener_name, "https");
    assert.equal((await lb.getCertificate("crt-1")).name, "www");
    await lb.deleteCertificate("crt-1");
    assert.deepEqual(stub.requests.map((r) => `${r.method} ${r.path}`), [
      "GET /api/v1/network/load-balancer-certificates",
      "GET /api/v1/network/load-balancer-certificates/crt-1",
      "DELETE /api/v1/network/load-balancer-certificates/crt-1",
    ]);
  } finally {
    await stub.close();
  }
});

test("deleting a certificate in use is recognizable", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { error: "certificate is used by a listener", reason: "certificate_in_use" }, 409),
  );
  try {
    await assert.rejects(clientFor(stub).loadBalancer.deleteCertificate("crt-1"), (error: unknown) => isCertificateInUse(error));
  } finally {
    await stub.close();
  }
});

test("a listener can be pointed at another certificate", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).loadBalancer.updateListener("lis-1", { tls_certificate_ref: "crt-2" });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "PATCH");
    assert.equal(seen.path, "/api/v1/network/listeners/lis-1");
    assert.deepEqual(JSON.parse(seen.body), { tls_certificate_ref: "crt-2" });
  } finally {
    await stub.close();
  }
});
