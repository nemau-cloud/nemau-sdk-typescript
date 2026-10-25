# Object storage

`nemau.storage` manages object containers and their objects, presigned URLs
and S3 access keys. It also manages block volumes; see
[Block storage](block-storage.md).

## Containers

```ts
await nemau.waitFor(await nemau.storage.createContainer("photos"));

for (const container of await nemau.storage.listContainers()) {
  console.log(container.name, container.count, container.bytes);
}
```

`getContainer(name)` and `deleteContainer(name)` take the container name.
`updateContainer(name, { versioning, retention_days })` changes versioning and
retention; see [Updating resources](updating-resources.md).

### Versioning and object lock

Object lock is set at creation with `createContainerWithOptions`. S3 does not
allow object lock to be added to an existing bucket, so a container for
immutable backups must be created with it.

```ts
import { RETENTION_COMPLIANCE, isContainerImmutable } from "@nemau-cloud/sdk";

await nemau.waitFor(
  await nemau.storage.createContainerWithOptions({
    name: "backups",
    object_lock: true,
    retention_mode: RETENTION_COMPLIANCE,
    retention_days: 365,
  }),
);

const protection = await nemau.storage.containerProtection("backups");
console.log(isContainerImmutable(protection));
```

| Field | Description |
| --- | --- |
| `versioning` | Keeps previous versions. Implied by `object_lock`. |
| `object_lock` | Makes versions immutable for `retention_days`. |
| `retention_mode` | `RETENTION_GOVERNANCE` or `RETENTION_COMPLIANCE`. Requires `object_lock`. |
| `retention_days` | Default retention, at most 2555 days (seven years). Requires `object_lock`. |

The SDK checks these rules before sending the request.

`GOVERNANCE` retention can be lifted by the platform. `COMPLIANCE` retention
cannot be lifted by anyone until it expires. A customer credential cannot lift
either one. Retention can be extended later with `updateContainer`; it
cannot be shortened.

A container is immutable when it has both versioning and object lock. With
versioning alone, a delete still removes a version. `Container.protection`
reports what was requested at creation, and `containerProtection(name)`
reports what the object store enforces. Compare the two to verify that a
container is immutable.

## Objects

```ts
await nemau.storage.uploadObject("reports", "2026/q1.csv", csvText, "text/csv");

const response = await nemau.storage.downloadObject("reports", "2026/q1.csv");
const text = await response.text();

await nemau.storage.deleteObject("reports", "2026/q1.csv");
```

Uploads, downloads and deletes are synchronous. `uploadObject` accepts a
`Uint8Array`, an `ArrayBuffer` or a string, with `application/octet-stream` as
the default content type. `downloadObject` returns the `Response`, whose body
is a stream for you to consume.

These methods pass the bytes through the API, which caps them at
`MAX_OBJECT_SIZE` (100 MiB) per object. A larger upload throws before any
request is sent. For larger objects, use [presigned URLs](#presigned-urls) or
[S3 access keys](#s3-access-keys).

Object keys can contain slashes. The SDK sends them as a query parameter, so
pass them unchanged.

### Listing objects

`listObjects` returns one page and an opaque `next_marker`, empty on the last
page. `limit` is 1 to `MAX_OBJECT_PAGE_SIZE` (1000) and defaults to
`DEFAULT_OBJECT_PAGE_SIZE` (100). `prefix` filters on the server and is at most
1024 bytes.

```ts
const page = await nemau.storage.listObjects("photos", { prefix: "2026/", limit: 500 });
const next = await nemau.storage.listObjects("photos", { prefix: "2026/", marker: page.next_marker });
```

Pass `next_marker` back unchanged. Do not build a marker from a key.

To read a whole container, use the iterator, which follows the cursor:

```ts
for await (const object of nemau.storage.iterateObjects("photos", { prefix: "2026/" })) {
  console.log(object.name, object.size);
}
```

`pageSize` sets how many objects each request fetches. Stop early with
`break`, and no further page is requested. Both methods accept an
`AbortSignal` as `signal`.

### Copying objects

A copy happens inside the object store. The bytes pass through neither the API
nor the client, so the 100 MiB cap does not apply. The limit is
`MAX_COPY_SIZE` (5 GiB), that of a single S3 copy. Beyond it the API answers
`413`; use [S3 access keys](#s3-access-keys) scoped to the containers involved
with rclone or the AWS CLI.

```ts
const copied = await nemau.storage.copyObject("reports", "2026.csv", {
  destinationContainer: "archive",
});
console.log(copied.container, copied.key, copied.size);
```

| Option | Description |
| --- | --- |
| `destinationContainer` | Defaults to the source container. |
| `destinationKey` | Defaults to the source key. |
| `replaceMetadata` | Replaces the source's content type and metadata instead of keeping them. |
| `contentType`, `metadata` | New values. Require `replaceMetadata`. |

Both containers must belong to the current project. The copy is synchronous:
it exists when the method returns. Copying an object onto itself is refused
unless it replaces the metadata, which is how an object's metadata is changed.

A copy into a container with object lock receives that container's default
retention, returned in `copied.retention`. The source's retention is not
copied.

## Presigned URLs

A presigned URL transfers one object directly between the client and the
object store, so `MAX_OBJECT_SIZE` does not apply. Use it for bulk export and
for large uploads.

```ts
const presigned = await nemau.storage.presignGet("photos", "holiday.jpg");
const response = await nemau.storage.fetchPresigned(presigned);
```

`presignGet(container, key, ttlSeconds?)` and `presignPut(container, key,
ttlSeconds?)` return a `PresignedObject` with `url`, `method` and
`expires_at`. Without `ttlSeconds` the URL expires after the platform default
of 15 minutes. The longest expiry is `PRESIGN_TTL_CAP_SECONDS` (3600 seconds),
checked before the request.

`fetchPresigned` performs a `GET` on the URL and throws when the store refuses
it. It does not send the client's credential: a presigned URL is already
authorized, and an access key sent with it would go to a host other than the
API. To upload to a `presignPut` URL, send a `PUT` request with your own HTTP
client.

Treat a presigned URL as a secret. Until it expires, it grants access to the
object to anyone who holds it.

## S3 access keys

For a full migration or a backup, create an S3 access key scoped to one
container. It works with `aws s3`, `rclone`, `s3cmd` and other S3 tools.

```ts
const credential = await nemau.storage.createCredential("photos", {
  access: "read_only", // or "read_write"
  expiresAt: new Date(Date.now() + 24 * 3600 * 1000), // optional
});

console.log(credential.access_key_id, credential.s3_bucket, credential.endpoint);
```

`credential.secret_access_key` is returned only in this response. The platform
does not store it, so a lost secret means creating a new key. `String()`,
`JSON.stringify` and `console.log` print `[redacted]` in its place; read the
property directly to get the value.

In the object store, each container has an opaque bucket name of its own, and
a key's policy only covers that bucket. Give `credential.s3_bucket` to the S3
tool; the store refuses the container name. The same bucket name is in the
`s3_bucket` field of each container returned by `listContainers()`.

```sh
aws --endpoint-url "$ENDPOINT" s3 sync "s3://$S3_BUCKET" ./backup
```

`expiresAt` must be in the future and within the platform's maximum lifetime.
Without it, the key never expires. An empty `credential.endpoint` means the
platform has no reachable S3 endpoint to show, as in a demonstration
environment.

`listCredentials(container)` lists a container's keys without their secrets,
and `revokeCredential(container, accessKeyId)` revokes one. These calls are
synchronous.

Creating, listing and revoking keys requires the `storage:ManageCredentials`
permission. Two helpers recognise the usual refusals:

- `isCredentialLimit(error)` is true when the container already holds the
  maximum number of keys. `error.limit` and `error.scope` carry the cap and
  what it counts.
- `isOrganizationReadOnly(error)` is true when the organization is in its
  read-only phase.
