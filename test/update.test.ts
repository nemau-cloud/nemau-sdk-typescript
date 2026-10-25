import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, json, startStub } from "./helpers.ts";

test("an update sends only the fields that were given", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    await clientFor(stub).network.updateNetwork("net-1", { description: "prod segment" });
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "PATCH");
    assert.equal(seen.path, "/api/v1/network/networks/net-1");
    // Only the given field is sent, so a client holding a stale copy cannot
    // overwrite a name another client has just written.
    assert.deepEqual(JSON.parse(seen.body), { description: "prod segment" });
  } finally {
    await stub.close();
  }
});

test("an update with no field never reaches the API", async () => {
  const stub = await startStub((_req, res) => json(res, {}));
  try {
    await assert.rejects(
      () => clientFor(stub).storage.updateVolume("vol-1", {}),
      /no field to change/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a volume update carries its id in the query", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
  try {
    // A volume id can contain a slash, which one path segment cannot carry.
    await clientFor(stub).storage.updateVolume("nemau-storage:104/vm-104-disk-0.qcow2", { name: "data" });
    const seen = stub.requests[0]!;
    assert.equal(seen.path, "/api/v1/storage/volumes");
    assert.ok(seen.query.includes("id="), `query = ${seen.query}`);
  } finally {
    await stub.close();
  }
});

test("each resource has its own update path", async () => {
  const cases: Array<[string, (c: ReturnType<typeof clientFor>) => Promise<unknown>, string]> = [
    ["instance", (c) => c.compute.updateInstance("i-1", { name: "web-2" }), "/api/v1/compute/instances/i-1"],
    ["pool member", (c) => c.loadBalancer.updatePoolMember("p-1", "m-1", { weight: 3 }),
      "/api/v1/network/pools/p-1/members/m-1"],
    ["container", (c) => c.storage.updateContainer("backups", { versioning: true }),
      "/api/v1/storage/containers/backups"],
    ["dns zone", (c) => c.dns.updateZone("example.com.", { ttl: 600 }), "/api/v1/dns/zones/example.com."],
  ];
  for (const [name, call, path] of cases) {
    const stub = await startStub((_req, res) => json(res, { task_id: "t-1", status: "pending" }, 202));
    try {
      await call(clientFor(stub));
      assert.equal(stub.requests[0]!.path, path, name);
    } finally {
      await stub.close();
    }
  }
});

test("createContainerWithOptions refuses a retention above the cap before any request", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t" }, 202));
  try {
    await assert.rejects(
      clientFor(stub).storage.createContainerWithOptions({
        name: "backups",
        object_lock: true,
        retention_mode: "COMPLIANCE",
        retention_days: 2556,
      }),
      /retention_days must not exceed 2555/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});
