# Quotas

`nemau.quotas` reads the capacity limits that writes are checked against. A
write is admitted only when both the project and its organization have room.

```ts
const quotas = await nemau.quotas.get();

for (const scope of quotas.quotas) {
  for (const dimension of scope.dimensions) {
    console.log(scope.scope, dimension.name, dimension.used, dimension.reserved, dimension.limit, dimension.unit);
  }
}
```

`get()` returns one scope for the project the credential resolves to
(`"project"`) and one for the organization that owns it (`"tenant"`). Each
dimension has:

| Field | Description |
| --- | --- |
| `name` | `instances`, `cores`, `ram`, `volumes`, `volumeSize`, `snapshots`, `networks`, `subnets`, `floatingIps`, `securityGroups`, `loadBalancers` or `objectStorage`. |
| `unit` | `count`, `MB`, `GB` or `bytes`. RAM is counted in MB and volume size in GB. |
| `used` | Settled usage. |
| `reserved` | Capacity claimed by tasks admitted but not yet settled. |
| `limit` | The limit. |

The API compares `used + reserved + requested` to the limit, so the headroom is
`limit - used - reserved`.

## Helpers

```ts
import { bindingQuota, quotaAvailable, quotaScope } from "@nemau-cloud/sdk";

const quotas = await nemau.quotas.get();

const cores = bindingQuota(quotas, "cores");
if (cores && quotaAvailable(cores) < 4) {
  console.log("not enough cores for a 4-vCPU instance");
}

const project = quotaScope(quotas, "project");
```

- `quotaAvailable(dimension)` returns the headroom, never negative.
- `quotaScope(quotas, scope)` returns the `"project"` or `"tenant"` scope.
- `bindingQuota(quotas, name)` returns the dimension that will refuse first:
  the one with the least headroom among the scopes that report it. It does not
  always have the smallest limit. Checking the project alone can miss a refusal
  at the organization level.

A write that exceeds a quota is refused, and the error message names the
dimension, for example `project quota exceeded for instances: 10/10 in use`.
