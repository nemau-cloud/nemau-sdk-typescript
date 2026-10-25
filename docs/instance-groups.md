# Instance groups

`nemau.instanceGroups` manages instance groups: a set of identical
members, built from a launch template, kept between a minimum and a maximum,
registered in load balancer pools, and scaled by target-tracking policies or by
a schedule.

## Creating a group

```ts
const ref = await nemau.instanceGroups.create({
  name: "web-tier",
  description: "Public web tier",
  network_id: networkId,
  subnet_id: subnetId,
  min_size: 2,
  max_size: 10,
  desired_capacity: 2,
  launch_template: {
    image_id: "ubuntu-24.04",
    flavor_id: "gp.small",
    service_level: "99.9%",
    user_data: "#cloud-config\npackages:\n  - nginx\n",
  },
  load_balancer_pools: [{ pool_id: poolId, protocol_port: 443 }],
  scaling_policies: [{ metric: "cpu_percent", target: 60 }],
});
await nemau.waitFor(ref);
```

`description` is free text, at most 256 characters on one line. It is optional on
a create and on an update; an update with `description: ""` clears it.

The size is `flavor_id`, or all of `vcpus`, `ram_mb` and `disk_gb`. `min_size`,
`desired_capacity` and `max_size` satisfy `min_size <= desired_capacity <=
max_size`, each from 0 to 50. `desired_capacity` defaults to `min_size`.

`user_data` is the cloud-init document of each member: at most 16 KiB, starting
with `#cloud-config`, `#!` or a MIME multipart header. The API never returns
it: a read shows `user_data_present` only. A refusal does not echo the document.

## Reading

- `list()` returns the groups, without members or activities. Each group has
  `instance_count`, its `pools`, `scaling_policies`, `schedules`, and a
  `launch_template` with `version`, `image_id`, `vcpus`, `ram_mb`, `disk_gb`,
  `network_id`, `subnet_id`, `security_group_ids`, `key_name`,
  `user_data_present` and `user_data_sha256` (`null` when there is no document).
- `get(id)` returns one group, with `members` and its recent `activities`. A
  member has `instance_id`, `status`, `protected_from_scale_in`,
  `template_version` and `joined_at`. An activity has `id`, `type`, `reason`,
  `instance_id` (`null` when it concerns no single member) and `created_at`.
- `activities(id)` returns the 200 most recent decisions of the group, newest
  first: scale steps, refusals, skipped schedule slots.

Each instance reports the group it belongs to in `instance_group_id`, `null`
when it belongs to none.

Members are not addressed on their own. A group owns its instances: deleting or
resizing one is refused by the API with `409`.

## Changing a group

`update(id, { ... })` sends only the fields given. A `launch_template` is a new
template version: members already running keep the version they were created
from. A `schedules` list replaces the previous one, and `schedules: []` clears
it. An empty update is refused before any request.

`setCapacity(id, desiredCapacity)` sets the desired count within the bounds.

`setMemberProtection(groupId, instanceId, protected)` protects one member from
scale-in, or lifts the protection.

## Rolling refresh

`refresh(id, { max_unavailable_pct, max_surge })` replaces the members one by
one with members of the group's current template version. Both fields are
optional and each takes the group's value when absent:

- `max_unavailable_pct` is the share of members that may be out at once, from 0
  to 50. The share rounds down, so 10 % of 3 members allows none.
- `max_surge` is how many members may start above the desired capacity before
  old ones leave, from 1 to 10.

Out-of-range values are refused before any request. A protected member is not
replaced: the refresh completes without it, it stays on its older version, and
it is counted in `refresh.skipped_protected`.

`cancelRefresh(id)` stops the refresh in progress. The members already replaced
stay on the new version.

Each group carries a `refresh` view, read with `get` or `list`:

- `status` is `idle` (never refreshed), `in_progress`, `blocked` (waits for room
  in the group, or for a member allowed out; a size change lifts it, and it
  resumes by itself), `hold` (paused by a billing hold), `completed`, `cancelled`
  or `failed`. The type is `InstanceGroupRefreshStatus`.
- `target_version` is the template version the refresh rolls to, `0` before any
  refresh. `started_at` and `completed_at` are RFC 3339, `null` while not set.
- `skipped_protected` counts the protected members left on an older version.

## Scaling

Two kinds of scaling exist in this version:

- **Target tracking** on `cpu_percent` only, with `target` from 10 to 90. The
  other ranges (windows, cooldowns, steps) are the API's defaults unless given.
  `memory_percent` is not available yet and is refused.
- **Scheduled actions**: up to 10 per group, each a 5-field cron in UTC and at
  least one of `min_size`, `max_size`, `desired_capacity`.

Health checks use `instance`. `load_balancer` is not available yet and is
refused.

## Deleting

`delete(id)` is refused by the API while the group has members. Pass
`{ deleteInstances: true }` to delete the members with the group.
