# Metering

`nemau.metering` reads consumption and accrued cost. The organization always
comes from the credential.

```ts
const costs = await nemau.metering.costs({
  periodStart: new Date("2026-09-01T00:00:00Z"),
  periodEnd: new Date("2026-10-01T00:00:00Z"),
});

const usage = await nemau.metering.usage({ page: 1, pageSize: 50 });
```

| Method | Reads |
| --- | --- |
| `usage(query?)` | Consumption records. |
| `usageSummary(query?)` | A summary of consumption. |
| `costs(query?)` | Accrued cost. |
| `events(query?)` | Metering events. |

Every method takes an optional `UsageQuery`:

| Field | Description |
| --- | --- |
| `resourceType` | Filters by resource type. |
| `periodStart`, `periodEnd` | A `Date` or an RFC 3339 string. |
| `page`, `pageSize` | Pagination. Ignored when zero or negative. |

These responses do not follow a stable public schema, so the methods return
the decoded JSON unchanged, as a `Record<string, unknown>`.
