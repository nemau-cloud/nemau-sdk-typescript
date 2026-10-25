# Errors and retries

## Error classes

`NemauApiError` is a non-2xx response from the API. Its properties:

| Property | Description |
| --- | --- |
| `statusCode` | HTTP status. |
| `message` | `<method> <path>: <status> <text>`. The text of a 4xx is the API's own message; other errors carry a generic text. |
| `code` | Stable machine-readable cause some refusals carry (`credential_limit`, `organization_read_only`, `invalid_request`...), empty otherwise. |
| `reason` | Machine-readable reason some refusals carry (`permission_denied`, `subnet_overlap`...), empty otherwise. |
| `limit`, `scope` | For a `credential_limit` refusal: the cap that was reached and what it counts (`bucket` or `project`). |
| `retryAfterMs` | The server's `Retry-After` hint in milliseconds, `0` when absent. |
| `body` | The raw response body, truncated. Useful when a proxy answered with HTML. |
| `method`, `path` | The request that failed. |
| `notFound`, `unauthorized`, `forbidden` | `true` for a `404`, `401` or `403`. |
| `retryable` | `true` when a further attempt could succeed. |

Branch on `code` or `reason`. The wording of `message` can change.

`NemauTaskFailedError` is thrown while waiting for a task that ended `failed`
or `cancelled`. Its `task` property holds the task, and its message includes
the task id. For most failures the platform replaces the underlying error with
a fixed message, so quote the task id when you contact support.

A plain `Error` is thrown when the SDK refuses an argument before sending a
request, for example a metrics period it does not know or an update with no
fields.

Network failures and aborts surface as the errors `fetch` raises. A request
that exceeds the `timeoutMs` client option rejects with an error named
`TimeoutError`, and a request whose signal is aborted rejects with the
signal's reason.

```ts
import { NemauApiError, isNotFound } from "@nemau-cloud/sdk";

try {
  await nemau.compute.getInstance(instanceId);
} catch (error) {
  if (isNotFound(error)) {
    // the instance does not exist in this project
  } else if (error instanceof NemauApiError && error.forbidden) {
    // IAM policy, token scope, or a missing organization feature
  } else {
    throw error;
  }
}
```

## Error helpers

Each helper takes any value and returns a boolean.

| Helper | Matches |
| --- | --- |
| `isNotFound` | `404` |
| `isUnauthorized` | `401` |
| `isForbidden` | `403`: an IAM policy, a token scope, or a missing organization feature |
| `isRateLimited` | `429` for the write budget. See [Rate limits](#rate-limits). |
| `isIdempotencyKeyMismatch` | `422`: an idempotency key reused with other parameters |
| `isResourceInUse` | A failed task with the error code `resource_in_use` |
| `isSubnetOverlap` | `409` refusing a subnet whose range overlaps another one; see [Networking](networking.md#networks-and-subnets) |
| `isCertificateInUse` | `409` refusing to delete a certificate a listener serves; see [Load balancers](load-balancers.md#tls-certificates) |
| `isAccessKeyLimit` | `409` refusing an IAM access key beyond the per-user cap; see [IAM](iam.md) |
| `isCredentialLimit` | `429` refusing an S3 access key beyond the cap; see [Object storage](object-storage.md#s3-access-keys) |
| `isOrganizationReadOnly` | `403` while the organization is in its read-only phase |
| `hasReason(error, reason)` | Any API refusal carrying the given `reason` |

The codes and reasons are exported as constants: `ERROR_CODE_RATE_LIMITED`,
`ERROR_CODE_UNAVAILABLE`, `ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH`,
`ERROR_CODE_CREDENTIAL_LIMIT`, `ERROR_CODE_ORGANIZATION_READ_ONLY`,
`ERROR_CODE_INVALID_REQUEST`, `ERROR_CODE_RESOURCE_IN_USE`,
`REASON_SUBNET_OVERLAP`, `REASON_CERTIFICATE_IN_USE`, `REASON_ACCESS_KEY_LIMIT`,
and the DNS reasons listed in [DNS](dns.md#errors).

### Resources still in use

A delete the platform refuses because something still depends on the resource
(a volume attached to the instance, a subnet on the network) fails its task
with the code `resource_in_use`. `isResourceInUse` recognises it, and the error
message names what to remove first. Repeating the call cannot succeed until it
is gone.

```ts
import { isResourceInUse } from "@nemau-cloud/sdk";

try {
  await nemau.waitFor(await nemau.compute.deleteInstance(instanceId));
} catch (error) {
  if (isResourceInUse(error)) {
    // detach the volume named in error.message, then delete again
  }
  throw error;
}
```

## Retries

The client retries failed requests on its own. The default policy,
`DEFAULT_RETRY`, makes 4 attempts in total. The delay between two attempts
grows exponentially from 300 ms, is capped at 5 seconds, and is randomised
(full jitter) so that many clients failing at the same moment do not retry in
step.

What is retried:

- `GET`, `HEAD`, `PUT`, `PATCH` and `DELETE` requests, and every write that
  carries an idempotency key: on `429`, `5xx` and network errors.
- A `POST` without an idempotency key is never retried, since it may have
  created the resource. Most of the
  [synchronous writes](asynchronous-writes.md#synchronous-writes) are such
  requests.
- An object upload is sent once, because its body cannot be replayed.

A `429` or `503` carries `Retry-After`, and the client waits at least that
long. A `Retry-After` longer than `maxRetryAfterMs` (60 seconds by default) is
not waited out: the error is thrown, with the hint in `error.retryAfterMs`. A
`429` that names a cap, such as `credential_limit`, is never retried.

The policy is set per client:

```ts
import { NemauClient } from "@nemau-cloud/sdk";

// No retries.
const once = new NemauClient({ retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });

// More patience with Retry-After.
const patient = new NemauClient({
  retry: { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 10_000, maxRetryAfterMs: 120_000 },
});
```

| Field | Description |
| --- | --- |
| `maxAttempts` | Total attempts, the first one included. `1` disables retries. |
| `baseDelayMs` | Delay before the second attempt, in milliseconds. |
| `maxDelayMs` | Ceiling on the exponential backoff, in milliseconds. |
| `maxRetryAfterMs` | Longest `Retry-After` the client waits out, in milliseconds. Optional, 60 000 by default. |

An `AbortSignal` passed to a method also interrupts the delay between two
attempts.

## Idempotency keys

Every asynchronous write (anything that answers `202` with a task) carries an
`Idempotency-Key` header: a fresh random key per call, reused on each retry of
that call. A retry after a lost response, a `429` or a `503` therefore cannot
start the work twice. The server answers a repeat with the original task, and
`ref.replayed` is `true`.

To make a write safe across process restarts, supply your own key, derived
from your own operation id:

```ts
const ref = await nemau
  .withIdempotencyKey(`order-${orderId}:vm`)
  .compute.createInstance(request);

if (ref.replayed) console.log("this write was already accepted");
```

- A key is 1 to 128 characters of `A-Z a-z 0-9 . _ : -`. Anything else throws
  before a request is sent.
- The server keeps a key for 24 hours.
- Reusing a key with different parameters is refused with a `422`, which
  `isIdempotencyKeyMismatch` recognises and which is never retried. Build one
  client per write.

`withIdempotencyKey` returns a new client and leaves the original unchanged.
The header names are exported as `IDEMPOTENCY_KEY_HEADER` and
`IDEMPOTENT_REPLAYED_HEADER`.

## Rate limits

The API limits each principal to 60 writes per minute. A write beyond that
budget is refused with a `429` that `isRateLimited` recognises. The client
retries it after the `Retry-After` delay, within the retry policy above, and
throws once the attempts are exhausted.

```ts
import { isRateLimited } from "@nemau-cloud/sdk";

try {
  await nemau.compute.start(instanceId);
} catch (error) {
  if (isRateLimited(error)) {
    // slow down; error.retryAfterMs says how long the server asked to wait
  }
  throw error;
}
```
