# Regions

`nemau.regions` lists the platform's regions and reports their health. These
are the only endpoints that need no authentication, so a client without a
credential can call them, for example to check that the API is reachable
before asking for credentials.

```ts
import { NemauClient } from "@nemau-cloud/sdk";

const nemau = new NemauClient();

for (const region of await nemau.regions.list()) {
  console.log(region.slug, region.displayName, region.country, region.enabled);
}

const status = await nemau.regions.status(regionSlug);
console.log(status.healthy, status.checkedAt);
```

`status(slug)` returns a `RegionStatus` with `healthy`, `checkedAt` and, when
the check failed, `error`. An unhealthy region answers `503`, which throws a
`NemauApiError` instead of returning a status. Like any read, the request is
retried first under the client's [retry policy](errors-and-retries.md#retries).
