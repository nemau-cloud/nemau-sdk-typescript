# Managed PostgreSQL

`nemau.databases` manages PostgreSQL databases: create, read, change,
resize, restore from a point in time, rotate the administrator password, and
delete. A database is reached at its `address` and `port` over TLS only.

## Creating a database

```ts
const created = await nemau.databases.create({
  name: "orders-db",
  version: "17",
  flavor: "db-medium",
  storage_gb: 50,
  subnet_id: subnetId,
  admin_username: "app_admin",
});

// The password is returned once, here. Store it now: it cannot be read again.
await vault.put("orders-db/admin", created.password);
```

The create answers with `task_id`, `username` and `password`. The database
itself is created by the task, so wait for it with `nemau.tasks` or
`nemau.waitForTask(created.task_id)`, then read it with `nemau.databases.get`.

`version` and `flavor` must be part of the region's offer; the API refuses any
other value. The SDK checks the shapes it can know: the name, the administrator
username (not `postgres`, not `pg_*`, not `nemau*`), `storage_gb` from 10 to
2000, `backup_retention_days` from 1 to 35, up to 5 security groups, and a
maintenance window of `weekday` 0 to 6 and `hour` 0 to 23, in UTC.

## The password

`create`, `rotatePassword` and `restore` return a `DatabaseCredentials`:
`task_id`, `username`, `password` and, for a rotation, `database_id`.

- The password is shown once. It is not in the database record, in any task,
  or in a later read.
- The SDK never puts it in an error message or a log line. A refusal names the
  rule it broke, never the request's values. The password is a plain field of
  the object, so do not log the whole result: log `task_id` and `username`.
- These three writes are sent **without** an `Idempotency-Key`, which the API
  refuses on them. `withIdempotencyKey` does not apply to them. A retry after a
  lost response issues a new password, so read the database back or rotate
  instead of retrying blindly.
- A rotation is safe to repeat in one sense: until its task applies the new
  verifier, the old password stays valid.

## Connecting

`caCertificate()` returns the PEM of the region's database CA. Connect with
`sslmode=verify-full` and that CA as `sslrootcert`:

```ts
const ca = await nemau.databases.caCertificate();
await fs.promises.writeFile("db-ca.pem", ca);
// sslmode=verify-full sslrootcert=db-ca.pem
```

The server accepts only TLS 1.2 and later, and refuses a plain connection.

## Reading and changing

- `list()` returns the databases of the project. `get(id)` returns one, with
  `description`, `version`, `flavor`, `storage_gb`, `address`, `port`, the backup
  retention and the maintenance window. No internal identifier is returned.
- `status` is one of `building` (being provisioned), `active` (serving), `error`
  (failed, and needs an operator) or `deleted` (retired, its backups may still be
  inside their restore window). The type is `DatabaseStatus`.
- `earliest_restorable_time` and `latest_restorable_time` bound the point-in-time
  restores of the database, in RFC 3339. The latest is the last archived WAL; it
  is absent until the agent has reported it. `restorable_until` is set only on a
  `deleted` database: it closes the window its backups stay restorable for.
- `pending_resize` is the resize the database holds for its maintenance window,
  `{ flavor, storage_gb, apply_at }`, or `null` when it holds none.
- `update(id, { ... })` changes `name`, `description`, `backup_retention_days`
  and `maintenance_window`. Only the fields given are sent; an empty update is
  refused before any request. A raised retention is billed. Pass
  `maintenance_window: null` to clear the window: the SDK sends an explicit
  `null`, which the API reads as a removal, not as an absent field.
- `restart(id)` reboots the appliance. The database stays `active`, and the
  restart is not billed.
- `flavors()` returns the sizes the region offers, each `{ name, vcpus,
  memory_mb }`. Pass a `name` as `flavor`. `versions()` returns the PostgreSQL
  majors the region admits, such as `"17"`. Both are read from the region's
  catalog, so check them before a create or a resize.
- `resize(id, { flavor, storage_gb, apply_at })` moves to a larger flavor, or
  grows the storage. Storage only grows, and a database never shrinks. When
  `apply_at` is absent the SDK sends nothing and the server applies the resize
  **now**. Pass `apply_at: "maintenance_window"` to hold it for the next window;
  it then shows in `pending_resize` until it applies.

## Restore

```ts
const restored = await nemau.databases.restore(sourceId, {
  name: "orders-db-restored",
  target_time: new Date("2026-10-20T10:30:00Z"),
  flavor: "db-medium",
  storage_gb: 50,
  subnet_id: subnetId,
  admin_username: "app_admin",
});
```

A restore writes a **new** database. The source is never changed. `target_time`
is a `Date` or an RFC 3339 string, and must not be in the future. It must also
fall in the source's backup window: a time outside it is refused by the API.

## Rotating the password

`rotatePassword(id)` returns new `DatabaseCredentials`. The password shown by
the previous call stops working once the task applies the new verifier.

## Deleting

`delete(id)` keeps the backups for their retention, as the database's record
says: the database then reads `status: "deleted"`, with `restorable_until` set to
the end of that window. `delete(id, { purgeBackups: true })` erases them now.
Both answer with a `TaskRef`.
