# Kubernetes

`nemau.kubernetes` manages Kubernetes clusters and their node pools.

Clusters are addressed by name: every cluster method takes the cluster name.

## Creating a cluster

A cluster lives in a project network and its nodes sit in one of that network's
subnets, so `network_id` and `subnet_id` are required. A cluster also needs a
control-plane node count and at least one node pool. The API refuses a request
without them, and the fields are required in the types. The console's defaults
are 3 control-plane nodes and one `workers` pool:

```ts
const cluster = await nemau.kubernetes.createClusterAndWait({
  name: "prod",
  kubernetes_version: "v1.31.0",
  network_id: "6f1c2a9e-3b7d-4e8f-9a10-2c5d7e8f9a01",
  subnet_id: "0b2e4d6f-8a1c-4b3e-9d5f-7a9c1e3b5d70",
  control_plane_vcpus: 2,
  control_plane_ram_mb: 4096,
  control_plane_disk_gb: 20,
  control_plane_replicas: 3,
  node_pools: [
    { name: "workers", class: "default-worker", replicas: 3, vcpus: 2, ram_mb: 4096, disk_gb: 20 },
  ],
});
```

Provisioning takes several minutes. `createCluster` returns the `TaskRef`
without waiting. A missing or malformed `network_id` or `subnet_id`, or a node
pool that breaks the rules below, throws before any request is sent. `listVersions()` and `listClusterClasses()` return the
accepted versions and cluster classes.

`CreateClusterRequest`:

| Field | Description |
| --- | --- |
| `name`, `kubernetes_version` | Required. |
| `network_id` | Required. Public UUID of the project network. |
| `subnet_id` | Required. Public UUID of the subnet the nodes are attached to. |
| `pod_cidr`, `service_cidr` | Optional IPv4 CIDRs, sent only when set. The server validates them. |
| `control_plane_replicas` | Required, 1 to 9. Use an odd number: etcd needs a quorum. |
| `control_plane_vcpus`, `control_plane_ram_mb`, `control_plane_disk_gb` | Control-plane node size. Set all three, or use `control_plane_flavor_id`. |
| `control_plane_flavor_id`, `worker_flavor_id` | Organization flavors. Require the `compute-flavors` organization feature. |
| `cluster_class` | Optional. |
| `node_pools` | Required, at least one pool. |

Each entry of `node_pools`:

| Field | Description |
| --- | --- |
| `name` | A DNS label (lowercase letters, digits and hyphens, at most 63 characters), unique within the cluster. |
| `replicas` | 0 to 100. With an autoscaler, start at `autoscaler_min`. |
| `flavor_id`, or `vcpus`, `ram_mb` and `disk_gb` | Node size. Nothing when the request sets `worker_flavor_id`. |
| `class` | Optional. When set, must be `default-worker`. |
| `labels` | Optional, at most 16. Each `key=value`. |
| `taints` | Optional, at most 16. Each `key[=value]:Effect`, with Effect `NoSchedule`, `PreferNoSchedule` or `NoExecute`. |
| `autoscaler_min`, `autoscaler_max` | Optional. |

Label and taint rules, checked before any request: the key is a DNS label
(lowercase letters, digits and hyphens, alphanumeric at both ends, 63
characters at most). A value is 1 to 63 alphanumerics, `-`, `_` or `.`, with
alphanumerics at both ends. The server applies the same rules.

## Reading clusters

```ts
for (const summary of await nemau.kubernetes.listClusters()) {
  console.log(summary.name, summary.status, summary.specs.kubernetes_version);
}

const detail = await nemau.kubernetes.getCluster("prod");
console.log(detail.status.phase, detail.status.controlPlaneEndpoint);
```

`listClusters()` returns summaries. Their `status` is the lowercase lifecycle
status (`active`, `building`, `upgrading`, `deleting` or `error`), and `specs`
holds the version, phase and readiness as of the last refresh. The specs are
refreshed periodically, so a cluster created a moment ago may not have all of
them yet. `getCluster(name)` returns the topology, the conditions and the API
endpoint.

The spec carries `network_id` and `subnet_id`, the public UUIDs of the network
and the subnet, and `pod_cidr` and `service_cidr` as set at creation. Each node
pool in `spec.topology.nodePools` carries its `labels` and `taints`, as lists of
strings, empty when the pool has none.

`deleteCluster(name)` deletes a cluster.

## Kubeconfig

```ts
const kubeconfig = await nemau.kubernetes.getKubeconfig("prod"); // YAML
```

A kubeconfig carries cluster-admin rights, and reading one is audited. Treat it
as a secret. `rotateKubeconfig(name)` rotates it and requires the
`kubernetes-kubeconfig-rotation` organization feature.

## Scaling and node pools

```ts
await nemau.waitFor(await nemau.kubernetes.scaleControlPlane("prod", 5));

await nemau.waitFor(
  await nemau.kubernetes.addNodePool("prod", {
    pool_name: "batch",
    class: "default-worker",
    vcpus: 4,
    ram_mb: 8192,
    disk_gb: 40,
    replicas: 2,
  }),
);

await nemau.waitFor(await nemau.kubernetes.scaleNodePool("prod", "batch", 4));
await nemau.waitFor(await nemau.kubernetes.setAutoscaler("prod", "batch", 2, 6));
```

- `scaleControlPlane(name, replicas)`: use an odd number.
- `addNodePool(cluster, request)`: `pool_name` and `class` are required. The
  size is `flavor_id` or all three of `vcpus`, `ram_mb` and `disk_gb`. `labels`
  and `taints` take the same syntax and limits as on creation (at most 16 of
  each); a malformed one is refused before any request.
- `scaleNodePool(cluster, pool, replicas)` and `removeNodePool(cluster, pool)`.
- `setAutoscaler(cluster, pool, min, max)`: both bounds are required. Use
  `0 < min <= max`, or `min = max = 0` to turn the autoscaler off.

## Upgrades

```ts
const ref = await nemau.kubernetes.upgradeCluster("prod", "v1.32.0");
const task = await nemau.waitFor(ref);
console.log(task.result?.["from_version"], task.result?.["to_version"]);
```

`upgradeCluster(name, version)` takes `1.32.0` or `v1.32.0`; a malformed
version throws before a request is sent. One request starts a task that runs
the preflight checks, opens a maintenance window and starts the upgrade, so no
window has to exist beforehand. It requires the `kubernetes-guided-upgrades`
organization feature; without it the API answers `404`.

A blocking preflight fails the task with a `NemauTaskFailedError` whose message
lists the blocking checks. When the task completes, the rolling upgrade has
started but is not finished yet; follow it with `getCluster()`. The completed
task's `result` carries `from_version`, `to_version`, `preflight_id` and
`maintenance_window_id`.

To look before upgrading, run the checks yourself. `preflight` requires the
`kubernetes-health-preflight` organization feature. Without a target version
it checks the cluster's health only.

```ts
const { report } = await nemau.kubernetes.preflight("prod", "v1.32.0");
if (!report.ready) console.log(report.blockingIssues);
```

`createMaintenanceWindow(name, { name, starts_at, ends_at, reason })` opens a
maintenance window on a cluster. The window name must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, and the window must end after it starts
and last at most 30 days.
