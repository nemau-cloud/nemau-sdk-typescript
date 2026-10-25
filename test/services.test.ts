import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotFound } from "../src/index.ts";
import { clientFor, json, startStub } from "./helpers.ts";

const VOLID = "nemau-storage:104/vm-104-disk-0.qcow2";

/**
 * A volume id can contain a slash, so it must travel as ?id=. In the path it
 * would add a segment, the route would stop matching, and the caller would get
 * a bare 404 instead of a readable error.
 */
test("volume operations carry the id in the query", async () => {
  const cases: Array<[string, (c: ReturnType<typeof clientFor>) => Promise<unknown>, string, string]> = [
    ["delete", (c) => c.storage.deleteVolume(VOLID), "DELETE", "/api/v1/storage/volumes"],
    ["attach", (c) => c.storage.attachVolume(VOLID, "inst-1"), "POST", "/api/v1/storage/volumes/attach"],
    ["detach", (c) => c.storage.detachVolume(VOLID, "inst-1"), "POST", "/api/v1/storage/volumes/detach"],
    ["extend", (c) => c.storage.extendVolume(VOLID, 50), "PUT", "/api/v1/storage/volumes/extend"],
  ];

  for (const [name, call, method, path] of cases) {
    const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
    try {
      await call(clientFor(stub));
      const seen = stub.requests[0]!;
      assert.equal(seen.method, method, name);
      assert.equal(seen.path, path, name);
      assert.equal(new URLSearchParams(seen.query).get("id"), VOLID, name);
    } finally {
      await stub.close();
    }
  }
});

test("a DNS record set carries its id in the query", async () => {
  // "app.example.com./A" contains a slash too, so it also travels in the query.
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).dns.deleteRecordSet("zone-1", "app.example.com./A");
    const seen = stub.requests[0]!;
    assert.equal(seen.path, "/api/v1/dns/zones/zone-1/recordsets");
    assert.equal(new URLSearchParams(seen.query).get("id"), "app.example.com./A");
  } finally {
    await stub.close();
  }
});

test("an empty security-group list is sent as-is", async () => {
  // An empty list removes every group from the instance, so the empty array
  // must reach the API.
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    await clientFor(stub).compute.setSecurityGroups("inst-1", []);
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "PUT");
    assert.equal(seen.path, "/api/v1/compute/instances/inst-1/security-groups");
    assert.equal(seen.body, '{"security_groups":[]}');
  } finally {
    await stub.close();
  }
});

test("floating IPs are read under the floatingips key", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { floatingips: [{ id: "fip-1", address: "203.0.113.7", status: "ACTIVE" }], count: 1 }),
  );
  try {
    const fips = await clientFor(stub).network.listFloatingIPs();
    assert.equal(fips[0]!.address, "203.0.113.7");
  } finally {
    await stub.close();
  }
});

test("a list-and-filter read produces a real 404", async () => {
  const stub = await startStub((_req, res) => json(res, { networks: [{ id: "net-1" }] }));
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      () => nemau.network.getNetwork("net-absent"),
      (error: unknown) => {
        assert.ok(isNotFound(error));
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("an object upload sets Content-Length and encodes the key", async () => {
  // The API answers 411 without a Content-Length.
  const stub = await startStub((_req, res) => json(res, { object_name: "a/b.txt", size: 5 }, 201));
  try {
    const uploaded = await clientFor(stub).storage.uploadObject("bucket", "a/b.txt", "hello", "text/plain");
    const seen = stub.requests[0]!;
    assert.equal(seen.headers["content-length"], "5");
    assert.equal(seen.headers["content-type"], "text/plain");
    assert.equal(new URLSearchParams(seen.query).get("key"), "a/b.txt");
    assert.equal(uploaded.size, 5);
  } finally {
    await stub.close();
  }
});

test("a Kubernetes cluster is addressed by name", async () => {
  const stub = await startStub((_req, res) =>
    json(res, { id: "c1", name: "prod", status: { phase: "Provisioned" } }),
  );
  try {
    const cluster = await clientFor(stub).kubernetes.getCluster("prod");
    assert.equal(stub.requests[0]!.path, "/api/v1/kubernetes/clusters/prod");
    assert.equal(cluster.status.phase, "Provisioned");
  } finally {
    await stub.close();
  }
});

test("a cluster creation carries its control-plane replicas and node pools", async () => {
  // The API refuses a cluster without them; a pool of zero nodes keeps its 0.
  const stub = await startStub((_req, res) => json(res, { task_id: "t1", status: "queued" }, 202));
  try {
    await clientFor(stub).kubernetes.createCluster({
      name: "prod",
      kubernetes_version: "v1.31.0",
      network_id: "6f1c2a9e-3b7d-4e8f-9a10-2c5d7e8f9a01",
      subnet_id: "0b2e4d6f-8a1c-4b3e-9d5f-7a9c1e3b5d70",
      control_plane_vcpus: 2,
      control_plane_ram_mb: 4096,
      control_plane_disk_gb: 20,
      control_plane_replicas: 3,
      node_pools: [
        { name: "workers", class: "default-worker", vcpus: 2, ram_mb: 4096, disk_gb: 20, replicas: 3 },
        { name: "standby", class: "default-worker", flavor_id: "flavor-1", replicas: 0 },
      ],
    });
    const request = stub.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/v1/kubernetes/clusters");
    const body = JSON.parse(request.body);
    assert.equal(body.control_plane_replicas, 3);
    assert.equal(body.node_pools.length, 2);
    assert.equal(body.node_pools[1].replicas, 0);
    assert.equal(body.node_pools[1].flavor_id, "flavor-1");
  } finally {
    await stub.close();
  }
});

test("regions are not wrapped in an object", async () => {
  // GET /regions returns a bare array, unlike every other list.
  const stub = await startStub((_req, res) =>
    json(res, [{ slug: "fr-occitanie-1", displayName: "Occitanie", country: "FR", enabled: true }]),
  );
  try {
    const regions = await clientFor(stub).regions.list();
    assert.equal(regions[0]!.slug, "fr-occitanie-1");
  } finally {
    await stub.close();
  }
});

test("restoring a snapshot posts to its restore route without a body", async () => {
  const stub = await startStub((_req, res) => json(res, { task_id: "t", status: "pending" }, 202));
  try {
    const ref = await clientFor(stub).compute.restoreSnapshot("snap-1");
    assert.equal(ref.task_id, "t");
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/compute/snapshots/snap-1/restore");
    assert.equal(seen.body, "");
  } finally {
    await stub.close();
  }
});

test("a snapshot listing carries storage, size and cost", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      snapshots: [
        {
          id: "s1", name: "a", instance_id: "i1", status: "active", storage: "object_store",
          size_bytes: 2147483648, source_disk_gb: 20, monthly_cost: 0.1, currency: "eur", restorable: true,
        },
        { id: "s2", name: "b", instance_id: "i1", status: "active", storage: "hypervisor", restorable: false },
      ],
      count: 2,
    }),
  );
  try {
    const items = await clientFor(stub).compute.listSnapshots("i1");
    assert.equal(stub.requests[0]!.query, "instance_id=i1");
    assert.equal(items[0]!.size_bytes, 2147483648);
    assert.equal(items[0]!.monthly_cost, 0.1);
    assert.equal(items[0]!.restorable, true);
    assert.equal(items[1]!.storage, "hypervisor");
    assert.equal(items[1]!.size_bytes, undefined);
  } finally {
    await stub.close();
  }
});
