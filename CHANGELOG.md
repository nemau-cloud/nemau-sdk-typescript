# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/) (0.x: a minor
release may change the API).

## [Unreleased]

### Breaking

- `kubernetes.createCluster` and `createClusterAndWait` require `network_id` and
  `subnet_id` (public UUIDs). A call without them, or with a malformed one,
  now throws before any request is sent. Add the project network and the
  subnet to every cluster creation.

### Added

- Scheduled instance backups. `compute.updateInstance` accepts
  `backup_schedule` (`none`, `daily` or `weekly`), `backup_hour` (UTC, 0 to 23),
  `backup_weekday` (0 to 6, weekly only) and `backup_retention_days` (1 to 35).
  Values outside their range are refused before a request is sent. The
  `BackupSchedule` constant and `BackupScheduleValue` type name the schedules.
- `Instance` reports `backup_schedule` (always present) and the other backup
  fields when set.
- `Snapshot` reports `origin` (`manual` or `scheduled`, via the
  `SnapshotOrigin` constant) and `expires_at` for scheduled snapshots.
- `InstanceUpdate` type, the input of `compute.updateInstance`.
- `user_data` on `createInstance` (and `createInstanceAndWait`): a cloud-init
  document run on the instance's first boot. It is checked client-side as
  UTF-8, at most 16 KiB and without NUL; the API stays the authority. Instances
  report `user_data_sha256` when one was set. The content is never returned.
  `USER_DATA_MAX_BYTES` exports the limit.
- `nemau.databases`: managed PostgreSQL. Create, read, update, resize, restore
  from a point in time, rotate the password, get the database CA and delete. A
  create, a rotation and a restore return the password once, in a
  `DatabaseCredentials`; these writes carry no `Idempotency-Key`, as the API
  requires.
- `nemau.instanceGroups`: instance groups. Create, read, list, activities,
  update, desired capacity, member protection and delete. Launch templates carry
  `user_data`; target tracking on CPU and scheduled actions are supported.
- Instance groups take a `description` on create and update, and their views
  follow the server contract: `pools`, `launch_template.version`,
  `members[].status`, `activities[].type` and `created_at`.
- Instances carry `instance_group_id`, `null` when they belong to no group.
- Databases: `status` is `building`, `active`, `error` or `deleted`
  (`DatabaseStatus`). The view adds `pending_resize`, the restore window
  (`earliest_restorable_time`, `latest_restorable_time`, `restorable_until`)
  and `description`. A resize applies now unless `apply_at` says otherwise.
- `databases.restart(id)`, and the catalogs `databases.flavors()` (each
  `{ name, vcpus, memory_mb }`) and `databases.versions()`.
- `databases.update(id, { maintenance_window: null })` clears the maintenance
  window. The explicit `null` is sent; an absent field is still left unchanged.
- `instanceGroups.refresh(id, { max_unavailable_pct, max_surge })` starts a
  rolling refresh onto the current template, and `instanceGroups.cancelRefresh(id)`
  stops it. Each group carries its `refresh` view (`InstanceGroupRefresh`).
- `CreateClusterRequest` accepts optional `pod_cidr` and `service_cidr` (IPv4
  CIDRs). They are sent only when set; the server validates them.
- Node pool `labels` and `taints` are checked before a cluster creation is sent:
  key and value syntax, the taint effect, at most 16 of each per pool. A pool
  `class` other than `default-worker` is refused.
- `kubernetes.addNodePool` accepts `labels` and `taints`, checked the same way.
- The cluster view decodes `spec.network_id`, `spec.subnet_id`, `spec.pod_cidr`
  and `spec.service_cidr` (`KubernetesClusterSpec`), and the node pool `labels`
  and `taints`.

### Changed

- `compute.updateInstance` takes an `InstanceUpdate` instead of a
  `ResourceUpdate`. Fields that only other resources have (load balancer,
  volume, DNS) no longer compile on an instance update.
- `DEFAULT_BASE_URL` is now `https://api.nemau-cloud.com`, the production
  API. Set `NEMAU_API_URL` or `baseUrl` to target another environment.
- The README is a short introduction, and the detailed guide is in `docs/` in
  the repository. `CONTRIBUTING.md` and `SECURITY.md` were added.
- Projects and quotas are read from `/projects` and `/quotas`. The former
  `/orchestration/projects` and `/orchestration/quotas` paths are gone.

## [0.2.0]

### Added

- Idempotency keys. Every asynchronous write sends an `Idempotency-Key`
  (generated, or set with `client.withIdempotencyKey(key)`) and exposes the
  replay flag. `isIdempotencyKeyMismatch`, `isRateLimited` and
  `isAccessKeyLimit` classify errors.
- `nemau.iam`: users, access keys (with expiry and limits), rotation, and the
  `409 access_key_limit` refusal.
- `storage.iterateObjects` walks a container listing over the opaque
  `next_marker` cursor (limit 1 to 1000).
- `kubernetes.upgradeCluster(name, version)` runs the guided upgrade as one task.
- `METRIC_PERIODS` and the `MetricPeriod` type: `instanceMetrics` validates
  the period (`1h`, `6h`, `24h`, `7d`) before sending.

### Changed

- 429 and 503 are retried with `Retry-After`, within a bound. Only reads and
  writes that carry an `Idempotency-Key` are retried.
- `StoredObject.size` replaces `bytes`.

### Removed

- `PreflightBlockedError`, `kubernetes.upgrade` and `kubernetes.startUpgrade`,
  replaced by `kubernetes.upgradeCluster`. A blocked preflight fails the
  upgrade task.

### Notes

- Access keys expire: 90 days by default, 365 at most, five active keys per
  user. After the expiry the API answers `401`.
