# Snapshots

A snapshot is a crash-consistent copy of an instance's system disk, stored in
the platform's object store. It is taken without stopping the instance.
Attached block volumes are never included.

The snapshot methods are on `nemau.compute`.

## Creating a snapshot

```ts
const ref = await nemau.compute.createSnapshot(instanceId, "before-upgrade");
await nemau.waitFor(ref); // runs until the upload ends
```

The task stays running until the upload to the object store ends, which takes
minutes, or hours for a large disk. Meanwhile the snapshot is listed with the
status `creating`.

## Listing snapshots

```ts
const all = await nemau.compute.listSnapshots();
const forOne = await nemau.compute.listSnapshots(instanceId);

for (const snapshot of forOne) {
  console.log(snapshot.name, snapshot.status, snapshot.size_bytes, snapshot.monthly_cost);
}
```

A snapshot's `status` is `creating`, `active` or `restoring`.

`origin` tells how the snapshot was made: `"manual"` for one taken with
`createSnapshot`, `"scheduled"` for a backup taken by an instance's
[backup schedule](compute.md#scheduled-backups). A scheduled snapshot also
carries `expires_at`, an RFC 3339 time when the platform deletes it. Manual
snapshots never expire, and `expires_at` is absent on them.

```ts
for (const snapshot of await nemau.compute.listSnapshots(instanceId)) {
  if (snapshot.origin === "scheduled") {
    console.log(snapshot.name, "expires", snapshot.expires_at);
  }
}
```

A snapshot is billed per GB and month on the bytes stored, which is the
compressed archive. Once it is active:

- `size_bytes` is the number of bytes the object store holds;
- `monthly_cost` is the price, excluding VAT, of keeping them for a 730-hour
  month, in `currency`;
- `source_disk_gb` is the capacity of the system disk that was captured.

## Restoring a snapshot

```ts
await nemau.waitFor(await nemau.compute.restoreSnapshot(snapshotId));
```

`restoreSnapshot` puts a snapshot back on the instance it came from. Only
snapshots with `restorable` set can be restored.

The data is restored beside the running instance first, then the system disk
is swapped. The instance stops only for the swap, and restarts if it was
running. Everything written since the snapshot is lost. Addresses, security
groups and attached volumes are kept, and the disk keeps its current size.

## Deleting a snapshot

```ts
await nemau.waitFor(await nemau.compute.deleteSnapshot(snapshotId));
```

A snapshot that is being created or restored cannot be deleted: the API
answers `409`. Deleting an instance deletes its snapshots.

## Older snapshots

Snapshots with `storage: "hypervisor"` are older snapshots kept outside the
object store. They can be listed and deleted, are not billed, and cannot be
restored. Current snapshots report `storage: "object_store"`.
