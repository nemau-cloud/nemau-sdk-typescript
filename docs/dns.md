# DNS

`nemau.dns` manages authoritative DNS zones and their record sets. A new zone
is not served until its owner proves control of the domain.

## Creating and verifying a zone

```ts
const zone = await nemau.dns.createZoneAndWait({
  name: "example.com.",
  email: "dns@example.com",
});

console.log(zone.status);       // "PENDING_VERIFICATION"
console.log(zone.verification); // { name, type: "TXT", value }
```

`email` is the SOA contact. A zero `ttl` becomes 300 on the server.

The zone comes back with the status `PENDING_VERIFICATION`, and
`verification` names the TXT record that proves ownership: a fully qualified
`name` such as `_nemau-challenge.example.com.`, and the exact `value` the
record must hold. Publish that record at the domain's current DNS host, then
start the check:

```ts
const active = await nemau.dns.verifyZoneAndWait(zone.id);
console.log(active.status); // "ACTIVE"
```

The platform looks up the TXT record and activates the zone when it holds the
expected value. While the record is absent or wrong, the task fails with a
`NemauTaskFailedError` and the zone stays pending. This includes the time the
record takes to reach the domain's nameservers, so a record published a moment
ago may need another try. Once the zone is active, `verification` disappears.

`verifyZone(id)` returns the `TaskRef` without waiting.
`verifyZoneAndWait(id, signal)` accepts an `AbortSignal`.

The status values are exported as `DNS_ZONE_STATUS_PENDING_VERIFICATION` and
`DNS_ZONE_STATUS_ACTIVE`.

A zone's `id` is the identifier every zone method takes. Its `name` is the
canonical zone name, such as `example.com.`, and is not an identifier.
`listZones()` and `getZone(id)` read zones, and `deleteZone(id)` deletes one.

## Record sets

```ts
await nemau.waitFor(
  await nemau.dns.createRecordSet(zone.id, {
    name: "www",
    type: "A",
    records: ["203.0.113.10"],
    ttl: 300,
  }),
);

for (const recordSet of await nemau.dns.listRecordSets(zone.id)) {
  console.log(recordSet.id, recordSet.records);
}
```

The zone must be active. A zone pending verification has no record sets, and
the API refuses to create one in it.

A record-set id has the form `canonical.name./TYPE`, for example
`www.example.com./A`. It contains a slash, so the SDK sends it as a query
parameter; pass it unchanged.

```ts
await nemau.waitFor(
  await nemau.dns.updateRecordSet(zone.id, "www.example.com./A", {
    records: ["203.0.113.20"],
  }),
);
await nemau.waitFor(await nemau.dns.deleteRecordSet(zone.id, "www.example.com./A"));
```

`UpdateRecordSetRequest` accepts `records`, `ttl` and `description`.
`getRecordSet(zoneId, id)` returns one record set.

`updateZone(id, { description, email, ttl })` changes a zone's settings; see
[Updating resources](updating-resources.md).

## Errors

DNS refusals carry a `reason`, which `hasReason` matches:

| Constant | Status | Meaning |
| --- | --- | --- |
| `REASON_DNS_ZONE_RESERVED` | `400` | The name is under a domain the platform keeps. |
| `REASON_DNS_ZONE_EXISTS` | `409` | The zone is already active on the platform, or already claimed in this project. |
| `REASON_DNS_ZONE_ALREADY_VERIFIED` | `409` | `verifyZone` on a zone that is already active. |
| `REASON_DNS_ZONE_PENDING_VERIFICATION` | `409` | A record-set write on a zone whose ownership is not proven yet. |

```ts
import { REASON_DNS_ZONE_EXISTS, hasReason } from "@nemau-cloud/sdk";

try {
  await nemau.dns.createZone({ name: "example.com.", email: "dns@example.com" });
} catch (error) {
  if (hasReason(error, REASON_DNS_ZONE_EXISTS)) {
    // the zone already exists
  } else {
    throw error;
  }
}
```
