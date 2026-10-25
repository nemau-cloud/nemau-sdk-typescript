# Updating resources

Names, descriptions and other reconfigurable settings are changed in place. An
update sends only the keys you pass, and every other field keeps its value. A
client holding a stale copy of a resource therefore cannot overwrite a value
another client has written.

```ts
const ref = await nemau.network.updateNetwork(networkId, { description: "front segment" });
await nemau.waitFor(ref);
```

- Passing `""` clears a field. Omitting the key leaves it unchanged.
- An update with no keys throws before any request is sent.
- An update is an asynchronous write: it returns a `TaskRef`. See
  [Asynchronous writes](asynchronous-writes.md).

## Update methods

Every update method takes a `ResourceUpdate`. The table lists the fields each
one changes.

| Method | Fields |
| --- | --- |
| `compute.updateInstance(id, update)` | `name`, `description`, `backup_schedule`, `backup_hour`, `backup_weekday`, `backup_retention_days` |
| `network.updateNetwork(id, update)` | `name`, `description` |
| `network.updateSubnet(id, update)` | `name` |
| `network.updateSecurityGroup(id, update)` | `name`, `description` |
| `network.updateFloatingIP(id, update)` | `description` |
| `loadBalancer.updateLoadBalancer(id, update)` | `name`, `description` |
| `loadBalancer.updateListener(id, update)` | `name`, `description`, `connection_limit`, `tls_certificate_ref` |
| `loadBalancer.updatePool(id, update)` | `name`, `description`, `lb_algorithm` |
| `loadBalancer.updatePoolMember(poolId, memberId, update)` | `name`, `weight` |
| `loadBalancer.updateHealthMonitor(poolId, monitorId, update)` | `delay`, `timeout`, `max_retries`, `expected_codes` |
| `storage.updateVolume(id, update)` | `name`, `description` |
| `storage.updateContainer(name, update)` | `versioning`, `retention_days` |
| `dns.updateZone(id, update)` | `description`, `email`, `ttl` |

What stays fixed:

- An instance keeps running while it is renamed.
- A network is not rebuilt: its identifier and its segment stay the same, and
  attached instances are untouched.
- A security group's rules cannot be edited: they are created and deleted.
- A floating IP's address cannot change.
- A pool update rewrites the load balancer's configuration in place, without
  dropping established connections.
- A volume's size changes with `storage.extendVolume`, which only grows it.
- A container's name cannot change, and its retention can be extended but not
  shortened.
- A DNS zone's name is its identity and cannot change.

## Other changes

A few changes use their own methods:

- `dns.updateRecordSet(zoneId, recordSetId, { records, ttl, description })`;
  see [DNS](dns.md).
- `iam.updateUser(userId, update)` and `iam.setAccessKeyStatus(...)`, which
  are synchronous; see [IAM](iam.md).
- `compute.updateFlavor(id, request)`, which is synchronous and takes the
  whole flavor; see [Compute](compute.md#images-and-flavors).
- `compute.setSecurityGroups(id, groupIds)` and `compute.resize(id, sizing)`;
  see [Compute](compute.md).
