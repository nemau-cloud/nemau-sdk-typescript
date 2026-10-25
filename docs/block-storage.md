# Block storage

Block volumes are managed with `nemau.storage`, which also handles object
storage; see [Object storage](object-storage.md).

## Creating and attaching a volume

```ts
const volume = await nemau.storage.createVolumeAndWait("data", 100, "database files");

const task = await nemau.waitFor(await nemau.storage.attachVolume(volume.id, instanceId));
console.log(task.result?.["device_id"]); // the /dev/disk/by-id name in the guest
```

Sizes are in GiB. `createVolume(name, sizeGB, description?)` returns the
`TaskRef` without waiting.

The completed attach task carries `device_id` in its `result`: the name of the
disk under `/dev/disk/by-id` in the guest.

`detachVolume(volumeId, instanceId)` detaches it. A volume's `attachments`
list the instances it is attached to.

## Growing a volume

```ts
await nemau.waitFor(await nemau.storage.extendVolume(volumeId, 200));
```

A volume only ever grows.

## Reading and deleting

`listVolumes()` lists the project's volumes. `getVolume(id)` lists and
filters, and throws a `404` `NemauApiError` for an unknown id.
`deleteVolume(id)` deletes a volume and returns a `TaskRef`.

A volume id can contain a slash. The SDK sends it as a query parameter, so
pass it unchanged.

An instance with an attached volume cannot be deleted: the task fails with
`resource_in_use`. Detach the volume first. Instance snapshots never include
attached volumes.

`updateVolume(id, { name, description })` renames a volume. See
[Updating resources](updating-resources.md).
