import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFor, json, startStub } from "./helpers.ts";
import type { KubernetesCluster } from "../src/index.ts";

/** The read contract of a cluster, as the API returns it. */
const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/kubernetes_cluster.golden.json", import.meta.url), "utf8"),
) as KubernetesCluster;

test("the cluster view decodes the golden contract, field for field", async () => {
  const stub = await startStub((_req, res) => json(res, GOLDEN));
  try {
    const cluster = await clientFor(stub).kubernetes.getCluster("prod");
    assert.deepEqual(cluster, GOLDEN);
    assert.equal(cluster.spec.network_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(cluster.spec.subnet_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(cluster.spec.pod_cidr, "10.245.0.0/16");
    assert.equal(cluster.spec.service_cidr, "10.96.0.0/12");
    const [general, batch] = cluster.spec.topology.nodePools;
    assert.deepEqual(general!.labels, ["workload=general"]);
    assert.deepEqual(general!.taints, ["dedicated=general:NoSchedule"]);
    assert.deepEqual(batch!.labels, []);
    assert.deepEqual(batch!.taints, []);
  } finally {
    await stub.close();
  }
});

/**
 * The listing is the platform's resource row, not the live cluster object: a
 * lowercase status and the figures in specs.
 */
test("the cluster list decodes the summary row", async () => {
  const stub = await startStub((_req, res) =>
    json(res, {
      clusters: [
        {
          id: "c1",
          resourceType: "kubernetes_cluster",
          name: "prod",
          status: "active",
          specs: {
            phase: "Provisioned",
            control_plane_ready: true,
            kubernetes_version: "v1.35.0",
            control_plane_replicas: 3,
            node_pools_count: 1,
          },
          createdAt: "2026-09-01T10:00:00Z",
          updatedAt: "2026-09-01T10:05:00Z",
        },
        { id: "c2", name: "staging", status: "building", specs: {} },
      ],
      count: 2,
    }),
  );
  try {
    const clusters = await clientFor(stub).kubernetes.listClusters();
    assert.equal(stub.requests[0]!.path, "/api/v1/kubernetes/clusters");
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0]!.status, "active");
    assert.equal(clusters[0]!.specs.phase, "Provisioned");
    assert.equal(clusters[0]!.specs.kubernetes_version, "v1.35.0");
    assert.equal(clusters[1]!.status, "building");
    assert.equal(clusters[1]!.specs.phase, undefined);
  } finally {
    await stub.close();
  }
});

function upgradeStub(ready: boolean) {
  return startStub((req, res) => {
    if (req.path.endsWith("/preflight")) {
      json(res, {
        preflight_id: "pf-1",
        report: ready
          ? { clusterName: "prod", currentVersion: "v1.35.0", targetVersion: "v1.36.0", ready: true, checks: [] }
          : {
              clusterName: "prod",
              currentVersion: "v1.35.0",
              ready: false,
              checks: [{ name: "control_plane_ready", passed: false, details: "control plane is not ready" }],
              blockingIssues: ["control_plane_ready: control plane is not ready"],
            },
      });
    } else if (req.path.endsWith("/maintenance")) {
      json(res, { id: "mw-1", clusterName: "prod", name: "upgrade-prod", startsAt: "x", endsAt: "y" }, 201);
    } else if (req.path.endsWith("/upgrade")) {
      json(res, { task_id: "task-up", maintenance_window_id: "mw-1" }, 202);
    } else {
      json(res, { error: "no stub" }, 404);
    }
  });
}

/**
 * The upgrade task runs preflight, the maintenance window and the upgrade
 * itself: the SDK sends one request with `version`.
 */
test("upgradeCluster sends one request with version", async () => {
  const stub = await upgradeStub(true);
  try {
    const ref = await clientFor(stub).kubernetes.upgradeCluster("prod", "v1.36.0");
    assert.equal(ref.task_id, "task-up");
    assert.equal(stub.requests.length, 1, "no preflight or window call precedes it");
    assert.equal(stub.requests[0]!.method, "POST");
    assert.equal(stub.requests[0]!.path, "/api/v1/kubernetes/clusters/prod/upgrade");
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), { version: "v1.36.0" });
    assert.match(String(stub.requests[0]!.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
  } finally {
    await stub.close();
  }
});

test("upgradeCluster refuses a malformed version before any request", async () => {
  const stub = await upgradeStub(true);
  try {
    const nemau = clientFor(stub);
    for (const bad of ["", "latest", "1.36", "v1.36.0-rc1", "1.36.0; drop"]) {
      await assert.rejects(nemau.kubernetes.upgradeCluster("prod", bad), /must look like/, bad);
    }
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a cluster name is escaped in the upgrade path", async () => {
  const stub = await upgradeStub(true);
  try {
    await clientFor(stub).kubernetes.upgradeCluster("a/b", "1.36.0");
    assert.equal(stub.requests[0]!.path, "/api/v1/kubernetes/clusters/a%2Fb/upgrade");
  } finally {
    await stub.close();
  }
});

test("a preflight without a target version sends an empty object", async () => {
  const stub = await upgradeStub(true);
  try {
    const out = await clientFor(stub).kubernetes.preflight("prod");
    assert.equal(out.preflight_id, "pf-1");
    assert.equal(out.report.ready, true);
    assert.deepEqual(JSON.parse(stub.requests[0]!.body), {});
  } finally {
    await stub.close();
  }
});

test("a maintenance window sends RFC 3339 bounds without milliseconds", async () => {
  const stub = await upgradeStub(true);
  try {
    const window = await clientFor(stub).kubernetes.createMaintenanceWindow("prod", {
      name: "nightly",
      starts_at: new Date("2026-10-01T22:00:00.123Z"),
      ends_at: "2026-10-02T02:00:00Z",
    });
    assert.equal(window.id, "mw-1");
    const seen = stub.requests[0]!;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/v1/kubernetes/clusters/prod/maintenance");
    assert.deepEqual(JSON.parse(seen.body), {
      name: "nightly",
      starts_at: "2026-10-01T22:00:00Z",
      ends_at: "2026-10-02T02:00:00Z",
      reason: "",
    });
  } finally {
    await stub.close();
  }
});

const NETWORK_ID = "6f1c2a9e-3b7d-4e8f-9a10-2c5d7e8f9a01";
const SUBNET_ID = "0b2e4d6f-8a1c-4b3e-9d5f-7a9c1e3b5d70";

function createRequest(overrides: Record<string, unknown> = {}, pool: Record<string, unknown> = {}) {
  return {
    name: "prod",
    kubernetes_version: "v1.31.0",
    network_id: NETWORK_ID,
    subnet_id: SUBNET_ID,
    control_plane_replicas: 3,
    node_pools: [{ name: "workers", class: "default-worker", replicas: 3, flavor_id: "f1", ...pool }],
    ...overrides,
  } as Parameters<ReturnType<typeof clientFor>["kubernetes"]["createCluster"]>[0];
}

function createStub() {
  return startStub((_req, res) => json(res, { task_id: "t1", status: "queued" }, 202));
}

test("a cluster creation without network_id is refused before any request", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    const { network_id: _omitted, ...rest } = createRequest();
    await assert.rejects(nemau.kubernetes.createCluster(rest as never), /network_id is required/);
    await assert.rejects(nemau.kubernetes.createCluster(createRequest({ network_id: "" })), /network_id is required/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a cluster creation without subnet_id is refused before any request", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    const { subnet_id: _omitted, ...rest } = createRequest();
    await assert.rejects(nemau.kubernetes.createCluster(rest as never), /subnet_id is required/);
    await assert.rejects(nemau.kubernetes.createCluster(createRequest({ subnet_id: "" })), /subnet_id is required/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a network or subnet that is not a UUID is refused before any request", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    await assert.rejects(nemau.kubernetes.createCluster(createRequest({ network_id: "net-1" })), /network_id must be a UUID/);
    await assert.rejects(nemau.kubernetes.createCluster(createRequest({ subnet_id: "../subnet" })), /subnet_id must be a UUID/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a valid cluster creation sends network_id and subnet_id and omits unset CIDRs", async () => {
  const stub = await createStub();
  try {
    const ref = await clientFor(stub).kubernetes.createCluster(createRequest());
    assert.equal(ref.task_id, "t1");
    const seen = stub.requests[0]!;
    assert.equal(seen.path, "/api/v1/kubernetes/clusters");
    const body = JSON.parse(seen.body);
    assert.equal(body.network_id, NETWORK_ID);
    assert.equal(body.subnet_id, SUBNET_ID);
    assert.equal("pod_cidr" in body, false, "unset pod CIDR is omitted");
    assert.equal("service_cidr" in body, false, "unset service CIDR is omitted");
  } finally {
    await stub.close();
  }
});

test("set CIDRs are sent as given, the server validates them", async () => {
  const stub = await createStub();
  try {
    await clientFor(stub).kubernetes.createCluster(
      createRequest({ pod_cidr: "10.244.0.0/16", service_cidr: "10.96.0.0/12" }),
    );
    const body = JSON.parse(stub.requests[0]!.body);
    assert.equal(body.pod_cidr, "10.244.0.0/16");
    assert.equal(body.service_cidr, "10.96.0.0/12");
  } finally {
    await stub.close();
  }
});

test("valid labels and taints are sent unchanged", async () => {
  const stub = await createStub();
  try {
    await clientFor(stub).kubernetes.createCluster(
      createRequest(
        {},
        {
          labels: ["team=platform", "tier=gold_1.2", "zone=a", "x=0"],
          taints: ["dedicated=gpu:NoSchedule", "spot:PreferNoSchedule", "maintenance=now:NoExecute"],
        },
      ),
    );
    const pool = JSON.parse(stub.requests[0]!.body).node_pools[0];
    assert.deepEqual(pool.labels, ["team=platform", "tier=gold_1.2", "zone=a", "x=0"]);
    assert.deepEqual(pool.taints, ["dedicated=gpu:NoSchedule", "spot:PreferNoSchedule", "maintenance=now:NoExecute"]);
  } finally {
    await stub.close();
  }
});

test("addNodePool sends labels and taints unchanged, and refuses bad ones before any request", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    await nemau.kubernetes.addNodePool("prod", {
      pool_name: "gpu",
      class: "default-worker",
      flavor_id: "f1",
      replicas: 1,
      labels: ["team=platform"],
      taints: ["dedicated=gpu:NoSchedule"],
    });
    const body = JSON.parse(stub.requests[0]!.body);
    assert.deepEqual(body.labels, ["team=platform"]);
    assert.deepEqual(body.taints, ["dedicated=gpu:NoSchedule"]);
    assert.equal(stub.requests.length, 1);
    await assert.rejects(
      nemau.kubernetes.addNodePool("prod", { pool_name: "gpu", class: "default-worker", flavor_id: "f1", taints: ["dedicated=gpu"] }),
      /taint "dedicated=gpu" must end in/,
    );
    await assert.rejects(
      nemau.kubernetes.addNodePool("prod", { pool_name: "gpu", class: "default-worker", flavor_id: "f1", labels: ["Team=a"] }),
      /label key "Team" must be a DNS label/,
    );
    assert.equal(stub.requests.length, 1, "a refused pool sends no request");
  } finally {
    await stub.close();
  }
});

test("a pool class other than default-worker is refused before any request", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    await assert.rejects(
      nemau.kubernetes.createCluster(createRequest({}, { class: "gpu-worker" })),
      /class must be default-worker/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("an absent or default-worker pool class is accepted", async () => {
  const stub = await createStub();
  try {
    const nemau = clientFor(stub);
    await nemau.kubernetes.createCluster(createRequest({}, { class: undefined }));
    await nemau.kubernetes.createCluster(createRequest({}, { class: "default-worker" }));
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test("a pool may carry 16 labels and 16 taints: the limit is inclusive", async () => {
  const labels = Array.from({ length: 16 }, (_, i) => `k${i}=v`);
  const taints = Array.from({ length: 16 }, (_, i) => `k${i}:NoSchedule`);
  const stub = await createStub();
  try {
    await clientFor(stub).kubernetes.createCluster(createRequest({}, { name: "gpu", labels, taints }));
    const pool = JSON.parse(stub.requests[0]!.body).node_pools[0];
    assert.equal(pool.labels.length, 16);
    assert.equal(pool.taints.length, 16);
  } finally {
    await stub.close();
  }
});

/** Each case: a pool entry the server refuses, and a fragment of the expected message. */
const badLabels: [string, string[], RegExp][] = [
  ["a bad key", ["Team=platform"], /label key "Team" must be a DNS label/],
  ["an empty value", ["team="], /label "team" has an invalid value/],
  ["a label without =", ["team"], /label "team" must be key=value/],
  ["a value with a space", ["team=a b"], /label "team" has an invalid value/],
  ["a value that ends with a dash", ["team=a-"], /label "team" has an invalid value/],
  ["17 labels", Array.from({ length: 17 }, (_, i) => `k${i}=v`), /at most 16 labels/],
];

for (const [title, labels, message] of badLabels) {
  test(`node pool labels refused: ${title}`, async () => {
    const stub = await createStub();
    try {
      await assert.rejects(
        clientFor(stub).kubernetes.createCluster(createRequest({}, { name: "gpu", labels })),
        (err: Error) => message.test(err.message) && err.message.includes('"gpu"'),
      );
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
}

const badTaints: [string, string[], RegExp][] = [
  ["a bad key", ["Dedicated=gpu:NoSchedule"], /taint key "Dedicated" must be a DNS label/],
  ["no effect", ["dedicated=gpu"], /must end in :NoSchedule, :PreferNoSchedule or :NoExecute/],
  ["a bad effect", ["dedicated=gpu:NoRun"], /must end in :NoSchedule/],
  ["an empty value", ["dedicated=:NoSchedule"], /taint "dedicated" has an invalid value/],
  ["a bad value", ["dedicated=gpu!:NoSchedule"], /taint "dedicated" has an invalid value/],
  ["17 taints", Array.from({ length: 17 }, (_, i) => `k${i}:NoSchedule`), /at most 16 taints/],
];

for (const [title, taints, message] of badTaints) {
  test(`node pool taints refused: ${title}`, async () => {
    const stub = await createStub();
    try {
      await assert.rejects(
        clientFor(stub).kubernetes.createCluster(createRequest({}, { name: "gpu", taints })),
        (err: Error) => message.test(err.message) && err.message.includes('"gpu"'),
      );
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
}
