# Organizations and projects

A call acts on one organization and one project.

The organization is the one the access key or service account belongs to, and
a call cannot leave it. The project comes from the `project` option when it is
set, and from the credential otherwise.

## Selecting a project

```ts
import { NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient({ project: projectId });
```

`NEMAU_PROJECT_ID` sets the default. `nemau.project` holds the selected
project, and is empty when the credential's own project applies.

The selected project is sent with each request in the `X-Project-Id` header
(exported as `PROJECT_SCOPE_HEADER`). It is not stored on the platform, so two
clients built from the same credential can target two projects at the same
time.

A service account pinned to a project cannot target another one: the API
answers `403`.

## Clients for other projects

`forProject` returns a new client aimed at another project. It keeps the
credential, the API URL, the `fetch` implementation, the retry policy, the
request timeout, the polling interval and the `User-Agent` prefix of the
original client.

```ts
const staging = nemau.forProject(stagingId);
const prod = nemau.forProject(prodId);

const [stagingInstances, prodInstances] = await Promise.all([
  staging.compute.listInstances(),
  prod.compute.listInstances(),
]);
```

The original client is not modified. A client can be shared between
concurrent callers, and changing its project in place would affect calls
already in flight.

`forProject` does not keep an idempotency key set with `withIdempotencyKey`.
Call `withIdempotencyKey` on the project client instead; see
[Errors and retries](errors-and-retries.md#idempotency-keys).

## Listing projects

`nemau.projects` lists the projects the credential can act on. Projects are
created and deleted in the console, so this service only reads them.

```ts
import { isProjectReady } from "@nemau-cloud/sdk";

const { projects, current_project_id } = await nemau.projects.list();
for (const project of projects) {
  console.log(project.slug, project.region, isProjectReady(project));
}

const staging = await nemau.projects.get("staging"); // id, name or slug
const current = await nemau.projects.current();      // undefined when none
```

- `get()` accepts an id, a name or a slug. An id match takes precedence over a
  name or slug match. An unknown project throws a `404` `NemauApiError`, which
  `isNotFound` recognises.
- `current()` returns the project the credential resolves to, or `undefined`
  when it resolves to none. In the listing, that project has `current: true`.
- `current_project_id` is the project the request resolved to. It can name a
  project absent from `projects`, for example when the credential points at a
  deleted project.
- `isProjectReady(project)` is true when the project is active and its
  provisioning has finished: `is_active` is true and `provisioning_status` is
  `"active"`.
