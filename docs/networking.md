# Networking

`nemau.network` manages networks, subnets, network interfaces, floating IPs and
security groups. Load balancers are on `nemau.loadBalancer`; see
[Load balancers](load-balancers.md).

## Networks and subnets

```ts
const network = await nemau.network.createNetworkAndWait("app", "application tier");

await nemau.waitFor(
  await nemau.network.createSubnet(network.id, { name: "app-v4", cidr: "10.0.1.0/24" }),
);
```

`CreateSubnetRequest` fields: `name`, `cidr`, `ip_version` (4 by default),
`gateway_ip`, `dns_servers` and `allocation_pools`. An IPv4 subnet requires
`cidr`.

The CIDR must not overlap any other subnet of the project. The subnets of a
project are routed together, whichever network they belong to, so the
conflict may be on another network. The API refuses an overlap with a `409`
that `isSubnetOverlap` recognises, and the message names the subnet, its range
and its network.

```ts
import { isSubnetOverlap } from "@nemau-cloud/sdk";

try {
  await nemau.network.createSubnet(networkId, { name: "db", cidr: "10.0.1.0/24" });
} catch (error) {
  if (!isSubnetOverlap(error)) throw error;
  // the message names the conflicting subnet, its range and its network
}
```

If another subnet with a conflicting range is created between the request and
the task, the task fails instead: a `NemauTaskFailedError` carrying the same
message, without the reason.

Reading:

- `listNetworks()`, `listSubnets()` and `listNetworkInterfaces()` list the
  project's resources.
- `getNetwork(id)` and `getSubnet(id)` list and filter, since the API has no
  read for a single network or subnet. An unknown id throws a `404`
  `NemauApiError`, which `isNotFound` recognises.

`deleteNetwork(id)` and `deleteSubnet(id)` return a `TaskRef`. A network that
still has a subnet cannot be deleted: the task fails with `resource_in_use`.

## IPv6

IPv6 floating IPs and IPv6 subnets are separate features. Both are off in a
region whose operator has not configured an IPv6 prefix. `getCapabilities()`
says which ones the region offers:

```ts
const { ipv6_floating_ips, ipv6_subnets } = await nemau.network.getCapabilities();
```

### IPv6 floating IPs

```ts
await nemau.waitFor(await nemau.network.allocateFloatingIP({ ip_version: 6 }));
```

The address is translated to the target's private IPv4 address on the
region's exit node. The guest needs no IPv6 configuration, and sees IPv6
clients as addresses of the translation range. A target holds at most one IPv6
floating IP. In a region without IPv6, the API refuses the allocation with a
`400`.

### Dual-stack networks

```ts
await nemau.waitFor(await nemau.network.createSubnet(networkId, { name: "app-v6", ip_version: 6 }));
```

Leave out `cidr`, `gateway_ip` and `allocation_pools`. The platform assigns a
/64 from the region's routed prefix and uses its first address as the gateway.
The network must already have an IPv4 subnet, and carries at most one IPv6
subnet.

Instances created on the network afterwards get a public IPv6 address, listed
after the IPv4 one in `addresses`. They must carry at least one security
group.

## Floating IPs

```ts
import { FloatingIPTarget } from "@nemau-cloud/sdk";

await nemau.waitFor(await nemau.network.allocateFloatingIP({ description: "web" }));

await nemau.waitFor(
  await nemau.network.associateFloatingIP(floatingIpId, FloatingIPTarget.Instance, instanceId),
);
```

`allocateFloatingIP` takes an optional `AllocateFloatingIPRequest`:

| Field | Description |
| --- | --- |
| `floating_network_id` | External network to allocate from. The region's external network when absent. |
| `ip_version` | `4` (default) or `6`. |
| `description` | Optional. |

The older form `allocateFloatingIP(externalNetworkId, description)` allocates
an IPv4 address.

A floating IP targets an instance (`FloatingIPTarget.Instance`) or a load
balancer (`FloatingIPTarget.LoadBalancer`). `disassociateFloatingIP(id)`
detaches it from its target and keeps the allocation, and
`releaseFloatingIP(id)` releases it. `listFloatingIPs()` and
`getFloatingIP(id)` read them.

## Security groups

```ts
await nemau.waitFor(await nemau.network.createSecurityGroup("web", "HTTPS from anywhere"));

await nemau.waitFor(
  await nemau.network.createSecurityGroupRule(securityGroupId, {
    direction: "ingress",
    protocol: "tcp",
    port_range_min: 443,
    port_range_max: 443,
    remote_ip_prefix: "0.0.0.0/0",
  }),
);
```

`direction` is `ingress` or `egress`. Leave `port_range_min` and
`port_range_max` out for a protocol with no ports.

A rule cannot be edited. To change one, create the new rule, then remove the
old one with `deleteSecurityGroupRule(groupId, ruleId)`.
`listSecurityGroups()` and `getSecurityGroup(id)` return the groups with their
`rules`, and `deleteSecurityGroup(id)` deletes a group.

A group is attached to an instance at creation (`security_groups`) or with
`compute.setSecurityGroups`; see [Compute](compute.md#security-groups).

### Egress filtering

A new security group filters egress. It starts with two egress rules that
allow all outbound traffic, one per address family (`0.0.0.0/0` and `::/0`).
Remove or narrow them to restrict what instances can reach.

An instance's egress is filtered only when all of its groups filter egress. One
group without egress filtering lets all of the instance's outbound traffic
through.

Groups created before egress filtering existed report
`egress_filtering: false`, and their egress rules have no effect.
`enableSecurityGroupEgressFiltering` converts such a group. It adds the two
default rules, then recomputes the outbound policy of the instances that carry
the group.

```ts
const ref = await nemau.network.enableSecurityGroupEgressFiltering(securityGroupId);
await nemau.waitFor(ref);
```

Traffic is unchanged when the task completes, since the new rules allow
everything. Removing or narrowing them afterwards takes effect. The conversion
cannot be undone, and running it on a group that already filters egress
changes nothing.

## Renaming

`updateNetwork`, `updateSubnet`, `updateSecurityGroup` and `updateFloatingIP`
change names and descriptions. See
[Updating resources](updating-resources.md).
