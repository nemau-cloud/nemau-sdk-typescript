# @nemau-cloud/sdk

TypeScript client for the [Nemau Cloud](https://nemau-cloud.com) public API.

The package requires Node.js 18 or later. It uses the runtime's built-in
`fetch`, has no runtime dependencies, and is published as an ES module with
type declarations.

## Getting started

### Install

```sh
npm install @nemau-cloud/sdk
```

### Configure credentials

The client reads its settings from the environment unless they are passed to
the constructor.

| Environment variable | Constructor option | Purpose |
| --- | --- | --- |
| `NEMAU_ACCESS_KEY_ID`, `NEMAU_ACCESS_KEY_SECRET` | `credential: new AccessKey(id, secret)` | IAM access key |
| `NEMAU_TOKEN` | `credential: new BearerToken(token)` | Service-account token, used when no access key is set |
| `NEMAU_PROJECT_ID` | `project` | Project to act on. Without it, the credential's own project applies. |
| `NEMAU_API_URL` | `baseUrl` | API URL, `https://api.nemau-cloud.com` by default |

To pass a credential in code:

```ts
import { AccessKey, NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient({
  credential: new AccessKey(process.env.KEY_ID!, process.env.KEY_SECRET!),
});
```

See [Authentication](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/authentication.md) for the other client options.

### Example

```ts
import { NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient();

const instance = await nemau.compute.createInstanceAndWait({
  name: "web-1",
  image_id: "ubuntu-24.04",
  vcpus: 2,
  ram_mb: 4096,
  disk_gb: 40,
});

console.log(instance.id, instance.status, instance.addresses);
```

This creates a client from the environment variables above, then creates an
instance with 2 vCPUs, 4096 MB of RAM and a 40 GB disk.

Most writes are asynchronous. The API accepts the request with a `202` and a
task, and the platform does the work in the background.
`createInstanceAndWait` sends the request, waits for the task to complete,
then reads the new instance back. The plain method, `createInstance`, returns
the task reference as soon as the request is accepted; pass it to
`nemau.waitFor(ref)` to wait. See
[Asynchronous writes](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/asynchronous-writes.md).

## Documentation

- [Authentication](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/authentication.md): credentials, environment variables
  and client options
- [Organizations and projects](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/projects.md): which project a call acts on,
  and `forProject`
- [Asynchronous writes](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/asynchronous-writes.md): tasks, waiting,
  cancellation and timeouts
- [Updating resources](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/updating-resources.md): partial updates
- [Errors and retries](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/errors-and-retries.md): error classes, retry
  policy, idempotency keys and rate limits
- Services: [compute](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/compute.md), [snapshots](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/snapshots.md),
  [networking](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/networking.md), [load balancers](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/load-balancers.md),
  [block storage](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/block-storage.md),
  [object storage](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/object-storage.md), [DNS](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/dns.md),
  [Kubernetes](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/kubernetes.md), [IAM](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/iam.md),
  [quotas](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/quotas.md), [metering](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/metering.md),
  [regions](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/regions.md)
- [Index of the guide](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/docs/README.md)
- Nemau Cloud SDK documentation:
  <https://docs.nemau-cloud.com/en/tools/sdks>

Each exported class, method and type also carries TSDoc comments, which
editors show from the bundled type declarations.

## Getting help

- Bugs and feature requests: open an issue at
  <https://github.com/nemau-cloud/nemau-sdk-typescript/issues>.
- Other questions: write to <contact@nemau-cloud.com>.
- Security vulnerabilities: do not open an issue. See [SECURITY.md](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/SECURITY.md).

## Contributing

See [CONTRIBUTING.md](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/CONTRIBUTING.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/LICENSE) and
[NOTICE](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/NOTICE).

Changes are listed in [CHANGELOG.md](https://github.com/nemau-cloud/nemau-sdk-typescript/blob/main/CHANGELOG.md). Versions follow
[Semantic Versioning](https://semver.org/); while the major version is 0, a
minor release may change the API.
