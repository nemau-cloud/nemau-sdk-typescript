# Compute

`nemau.compute` manages instances and their lifecycle, images, flavors,
keypairs, pricing and metrics. Instance snapshots have their own page:
[Snapshots](snapshots.md).

## Creating an instance

```ts
const instance = await nemau.compute.createInstanceAndWait({
  name: "web-1",
  image_id: "ubuntu-24.04",
  vcpus: 2,
  ram_mb: 4096,
  disk_gb: 40,
  network_id: networkId,
  security_groups: [securityGroupId],
  key_name: "deploy",
});

console.log(instance.id, instance.status, instance.addresses);
```

`CreateInstanceRequest` fields:

| Field | Description |
| --- | --- |
| `name` | Required. |
| `image_id` | Required. See `listImages()`. |
| `vcpus`, `ram_mb`, `disk_gb` | Custom size. Set all three, or use `flavor_id`. The API rejects a partial size. |
| `flavor_id` | An organization flavor. Requires the `compute-flavors` organization feature. |
| `network_id` | Network to attach the instance to. |
| `security_groups` | Security group ids. |
| `key_name` | Name of a registered keypair. See [Keypairs](#keypairs). |
| `description`, `service_level` | Optional. |
| `user_data` | Optional cloud-init document, run on the first boot. UTF-8, at most 16 KiB (16384 bytes) after encoding, no NUL. Checked before the request is sent. See [User data](#user-data). |

`createInstance` returns the `TaskRef` without waiting. See
[Asynchronous writes](asynchronous-writes.md).

An instance's `status` is `running`, `stopped`, `paused` or `pending`. A field
the platform cannot report is left out instead of set to zero. An empty
`addresses` means the addresses are unknown; the instance may still have some.

### User data

`user_data` passes a cloud-init document (`#cloud-config`, a `#!` script or a
multipart MIME message) to the instance, which runs it on its first boot. The
platform does not interpret it. It is encrypted at rest and is never returned:
an instance reports `user_data_sha256`, the SHA-256 of the document as
lowercase hex, when one was set. Compare that digest to detect a change; a
change to `user_data` needs a new instance, because cloud-init does not read it
again.

The SDK rejects an oversized, NUL-containing or non-string `user_data` with an
`Error` before sending the request. The error text never includes the document.

```ts
import { createHash } from "node:crypto";

const userData = "#cloud-config\npackages: [nginx]\n";
const instance = await nemau.compute.createInstanceAndWait({
  name: "web-1",
  image_id: "ubuntu-24.04",
  vcpus: 2,
  ram_mb: 4096,
  disk_gb: 40,
  user_data: userData,
});
console.log(instance.user_data_sha256 === createHash("sha256").update(userData).digest("hex"));
```

```ts
const instances = await nemau.compute.listInstances();
const one = await nemau.compute.getInstance(instanceId);
```

## Lifecycle actions

Each action returns a `TaskRef`.

```ts
await nemau.waitFor(await nemau.compute.stop(instanceId));
await nemau.waitFor(await nemau.compute.start(instanceId));
await nemau.waitFor(await nemau.compute.reboot(instanceId, "HARD"));
```

| Method | Action |
| --- | --- |
| `start(id)`, `stop(id)` | Start or stop the instance. |
| `reboot(id, type?)` | `type` is `SOFT` (default) or `HARD`. |
| `pause(id)`, `unpause(id)` | Pause or unpause. |
| `suspend(id)`, `resume(id)` | Suspend or resume. |
| `deleteInstance(id)` | Delete the instance and its snapshots. |

A delete refused because a volume is still attached fails its task with the
code `resource_in_use`. See
[Errors and retries](errors-and-retries.md#resources-still-in-use).

## Resizing

```ts
await nemau.waitFor(
  await nemau.compute.resize(instanceId, { vcpus: 4, ram_mb: 8192, disk_gb: 80 }),
);
```

All three values are required. The API accepts 1 to 64 vCPUs, 1024 to
262144 MB of RAM and 10 to 5000 GB of disk.

## Security groups

`setSecurityGroups` replaces the instance's security groups with the given
list:

```ts
await nemau.waitFor(await nemau.compute.setSecurityGroups(instanceId, [webGroupId, sshGroupId]));
```

An empty list is accepted. It removes every group, and the instance's traffic
is then no longer filtered. Security groups themselves are managed in
[Networking](networking.md#security-groups).

## Renaming

`updateInstance(id, { name, description })` changes the instance's label. The
instance keeps running. See [Updating resources](updating-resources.md).

## Scheduled backups

An instance can take a backup of its system disk every day or every week,
without a call each time. A backup is a [snapshot](snapshots.md) with
`origin: "scheduled"`, kept for the number of days you choose.

```ts
await nemau.waitFor(
  await nemau.compute.updateInstance(instanceId, {
    backup_schedule: "weekly",
    backup_weekday: 0, // 0 = Sunday, 6 = Saturday
    backup_hour: 2, // UTC, 0 to 23
    backup_retention_days: 14, // 1 to 35
  }),
);
```

| Field | Values | Default |
| --- | --- | --- |
| `backup_schedule` | `"none"`, `"daily"`, `"weekly"` | `"none"` |
| `backup_hour` | 0 to 23, UTC | 2 |
| `backup_weekday` | 0 (Sunday) to 6 (Saturday), read for `"weekly"` only | 0 |
| `backup_retention_days` | 1 to 35 | none |

A `daily` or `weekly` schedule needs `backup_retention_days`. The API checks
this on the instance's state after the update, so an update that only moves
`backup_hour` is accepted when a retention is already set. Values outside
their range are refused before the request is sent.

Set `backup_schedule` to `"none"` to stop scheduled backups. Backups already
taken keep their expiry date: stopping the schedule does not shorten or extend
them, and they are deleted on time.

An instance reads back its policy with `backup_schedule` (always present) and
the other three fields when they are set.

A backup is a crash-consistent copy of the system disk, like a copy taken
after a power cut. Attached block volumes are not part of it, and a database
should dump its own data. Scheduled backups count against the project's
snapshot quota and are billed like manual snapshots; see
[Snapshots](snapshots.md).

## Images and flavors

```ts
for (const image of await nemau.compute.listImages()) {
  console.log(image.id, image.name, image.os_name);
}
```

Flavors are sizes defined by the organization. They require the
`compute-flavors` organization feature; without it the API answers `403`.
Flavor calls are synchronous.

```ts
const flavor = await nemau.compute.createFlavor({
  name: "standard-2",
  vcpus: 2,
  ram_mb: 4096,
  disk_gb: 40,
});

const flavors = await nemau.compute.listFlavors();
await nemau.compute.updateFlavor(flavor.id, { name: "standard-2", vcpus: 2, ram_mb: 8192, disk_gb: 40 });
await nemau.compute.deleteFlavor(flavor.id);
```

## Keypairs

`createKeypair` registers a public key, or generates a keypair when no public
key is given. It is synchronous.

```ts
const generated = await nemau.compute.createKeypair("deploy");
// generated.privateKey exists only in this response.

const imported = await nemau.compute.createKeypair("laptop", publicKey);
```

`privateKey` is set only when the platform generated the key. The platform
does not store it, and it cannot be fetched again.

`listKeypairs()` lists the keypairs. `deleteKeypair(name)` deletes one by
name and returns a `TaskRef`. A name that contains a slash cannot be deleted
with this method.

## Pricing and metrics

```ts
const pricing = await nemau.compute.getPricing();
const metrics = await nemau.compute.instanceMetrics(instanceId, "24h");
```

Both return the decoded JSON as an object. The metrics `period` is one of
`METRIC_PERIODS` (`1h`, `6h`, `24h`, `7d`) and defaults to `1h`. Any other
value throws before a request is sent.
