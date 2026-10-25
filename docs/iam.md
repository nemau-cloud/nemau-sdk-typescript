# IAM

`nemau.iam` manages the organization's users and their access keys.

Users are managed by the organization owner. A user manages their own access
keys, and an owner manages everyone's. These calls are synchronous: they
answer with the result, without a task.

## Users

```ts
for await (const user of nemau.iam.iterateUsers()) {
  console.log(user.email, user.type, user.status);
}

const user = await nemau.iam.createUser({
  username: "ada",
  email: "ada@example.com",
  name: "Ada",
  surname: "Lovelace",
});
```

- `listUsers({ page, limit })` returns one page (a `Paginated<IamUser>`). The
  API caps `limit` at 100. `iterateUsers()` walks every page.
- `getUser(userId)` returns one user. `type` is `owner` or `member`.
- `createUser(request)` takes `username` and `email`, and optionally `name`,
  `surname` and `password`. Without a password, the user signs in by another
  route.
- `updateUser(userId, update)` changes `name`, `surname`, `username`, `email`
  or `password`. An omitted key is left unchanged, and an update with no field
  throws before any request is sent.
- `disableUser(userId)` blocks the user from signing in and ends their
  sessions. `enableUser(userId)` lifts the block.
- `deleteUser(userId, email)` deletes a user. The API wants the deletion
  confirmed, so the email is required as well: a stale id cannot delete
  someone else.

## Access keys

An access key is the credential behind `AccessKey`; see
[Authentication](authentication.md).

```ts
import { AccessKey, NemauClient } from "@nemau-cloud/sdk";

const { current, maxAccessKeys } = await nemau.iam.accessKeyLimits();

const { accessKey, secretAccessKey } = await nemau.iam.createAccessKey(userId, {
  description: "ci",
  expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
});
// secretAccessKey is only returned in this response.

const ci = new NemauClient({ credential: new AccessKey(accessKey.accessKeyId, secretAccessKey) });
```

Every key expires. `expiresAt` is optional and defaults to 90 days from now
(`DEFAULT_ACCESS_KEY_TTL_MS`). It accepts a `Date` or an RFC 3339 string, must
be in the future, and at most 365 days away (`MAX_ACCESS_KEY_TTL_MS`). The SDK
checks it before sending the request. After a key expires, the API answers
`401`.

A user holds at most 5 active keys (`MAX_ACCESS_KEYS_PER_USER`). Creating a
sixth is refused with a `409` that `isAccessKeyLimit` recognises.
`accessKeyLimits()` returns the caller's count and the cap. Passing a user id
reads another user's count, which only owners may do (`403` otherwise).

The secret is returned only when a key is created or rotated. The platform
keeps a hash of it.

| Method | Description |
| --- | --- |
| `listAccessKeys(userId)` | The user's keys, without secrets. |
| `getAccessKey(userId, keyId)` | One key. `keyId` is the key's `id`. |
| `setAccessKeyStatus(userId, keyId, status)` | `"active"` or `"inactive"`. Reactivating beyond the cap is a `409`. |
| `rotateAccessKey(userId, keyId)` | Replaces the secret and returns the new one. |
| `deleteAccessKey(userId, keyId)` | Deletes the key. |

`accessKey.accessKeyId` is the public half, sent as `X-Access-Key-Id`.
`accessKey.id` identifies the key in the methods above.

```ts
const rotated = await nemau.iam.rotateAccessKey(userId, keyId);
console.log(rotated.accessKey.accessKeyId, rotated.secretAccessKey);
```
