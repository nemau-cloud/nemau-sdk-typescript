# Authentication

Every call except the [regions](regions.md) endpoints needs a credential. The
client takes it from the `credential` option, or builds one from the
environment.

## Credential types

| Class | Headers sent | Use |
| --- | --- | --- |
| `AccessKey` | `X-Access-Key-Id`, `X-Access-Key-Secret` | An IAM user's long-lived programmatic key, for scripts and CI jobs |
| `BearerToken` | `Authorization: Bearer` | A service-account token, valid for 15 minutes |
| `SessionToken` | `x-session-token` | A console session. Writes are CSRF-protected, so it is read-only in practice. |

Access keys expire: 90 days after creation by default, 365 days at most. After
that the API answers `401`. See [IAM](iam.md) to create and rotate them.

A service-account token is issued by `POST /api/v1/iam/service-accounts/token`,
which the SDK does not call. `BearerToken` holds the string it was given and
never refreshes it, so a process that runs longer than 15 minutes must obtain a
new token and build a new client.

Any object that implements the `Credential` interface can be passed as
`credential`. It has two methods: `apply(headers)` sets the authentication
headers on an outgoing request, and `describe()` returns a description that
does not contain the secret.

## From the environment

```ts
import { NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient();
```

Without a `credential` option, the client calls `credentialFromEnv()`:

1. `NEMAU_ACCESS_KEY_ID` and `NEMAU_ACCESS_KEY_SECRET`, when both are set, give
   an `AccessKey`.
2. Otherwise `NEMAU_TOKEN` gives a `BearerToken`.
3. Otherwise the client sends no credential. The regions endpoints work
   without one; other calls are refused with `401`.

The access-key pair takes precedence over `NEMAU_TOKEN`, so a stale token left
in a shell does not replace the long-lived key. Surrounding whitespace is
trimmed from each value.

The constructor also reads `NEMAU_API_URL` and `NEMAU_PROJECT_ID` (see
[Organizations and projects](projects.md)). The variable names are exported as
`ENV_ACCESS_KEY_ID`, `ENV_ACCESS_KEY_SECRET`, `ENV_TOKEN`, `ENV_API_URL` and
`ENV_PROJECT`.

`credentialFromEnv` also accepts an environment object of your own:

```ts
import { credentialFromEnv, NemauClient } from "@nemau-cloud/sdk";

const credential = credentialFromEnv({ NEMAU_TOKEN: token });
const nemau = new NemauClient(credential ? { credential } : {});
```

## Explicit credentials

```ts
import { AccessKey, NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient({
  baseUrl: "https://api.nemau-cloud.com",
  credential: new AccessKey(process.env.KEY_ID!, process.env.KEY_SECRET!),
});

console.log(nemau.describeCredential()); // "access-key <key id>"
```

`describeCredential()` returns `access-key <key id>`, `service-account token`,
`console session`, or `none` when the client has no credential. It never
includes a secret.

## Client options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `NEMAU_API_URL`, then `DEFAULT_BASE_URL` (`https://api.nemau-cloud.com`) | Absolute URL of the API. The SDK adds the `/api/v1` prefix. |
| `credential` | `credentialFromEnv()` | See above. |
| `project` | `NEMAU_PROJECT_ID` | Project every request acts on. See [Organizations and projects](projects.md). |
| `timeoutMs` | `60000` | Deadline for a single HTTP request, in milliseconds. |
| `pollIntervalMs` | `2000` | Interval between two reads of a task while waiting, in milliseconds. |
| `retry` | `DEFAULT_RETRY` | Retry policy. See [Errors and retries](errors-and-retries.md). |
| `userAgent` | none | Prefix for the `User-Agent` header. The SDK appends `nemau-sdk-js/<version>`. |
| `fetch` | `globalThis.fetch` | Replacement `fetch` implementation: a test double, an HTTP agent or instrumentation. |
| `idempotencyKey` | none | Fixes the `Idempotency-Key` of every asynchronous write. Prefer `withIdempotencyKey`; see [Errors and retries](errors-and-retries.md#idempotency-keys). |

A `baseUrl` that is not an absolute URL makes the constructor throw. Trailing
slashes are removed.

`VERSION` holds the version string the SDK sends in its `User-Agent`.
