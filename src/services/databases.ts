import { Service } from "./base.ts";
import type { Database, DatabaseCredentials, DatabaseFlavor, TaskRef } from "../types.ts";

/**
 * Comfort checks that mirror the API's ranges. The API judges every
 * value again and its answer wins: the client refuses early, it never decides.
 * Flavors and versions are not checked here, since the region's offer is the
 * API's to know.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const ADMIN_USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /\p{Cc}/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const APPLY_AT_VALUES = ["now", "maintenance_window"] as const;

export const DATABASE_STORAGE_MIN_GB = 10;
export const DATABASE_STORAGE_MAX_GB = 2000;
export const DATABASE_RETENTION_MIN_DAYS = 1;
export const DATABASE_RETENTION_MAX_DAYS = 35;
export const DATABASE_MAX_SECURITY_GROUPS = 5;
const DATABASE_MAX_DESCRIPTION_BYTES = 256;

/** One UTC hour a week. Weekday 0 is Sunday. */
export interface DatabaseMaintenanceWindowRequest {
  weekday: number;
  hour: number;
}

export interface CreateDatabaseRequest {
  name: string;
  description?: string;
  /** A major version the region offers, such as "17". Fixed for the database's life. */
  version: string;
  /** A catalogue flavor, such as "db-small". */
  flavor: string;
  storage_gb: number;
  /** The subnet the database is placed in. Its network follows from it. */
  subnet_id: string;
  security_group_ids?: string[];
  /** The administrator role. Not "postgres", not "pg_*", not "nemau*". */
  admin_username: string;
  backup_retention_days?: number;
  maintenance_window?: DatabaseMaintenanceWindowRequest;
}

/**
 * Every field is optional; an absent one is left unchanged. `maintenance_window`
 * set to `null` clears the window; the API then keeps no preferred window.
 */
export interface UpdateDatabaseRequest {
  name?: string;
  description?: string;
  backup_retention_days?: number;
  maintenance_window?: DatabaseMaintenanceWindowRequest | null;
}

export interface ResizeDatabaseRequest {
  /** A larger flavor. Set flavor, storage_gb, or both. */
  flavor?: string;
  /** Storage only grows. */
  storage_gb?: number;
  /** "now" by default; "maintenance_window" waits for the next window. */
  apply_at?: (typeof APPLY_AT_VALUES)[number];
}

/**
 * A point-in-time restore. It writes a NEW database; the source is never
 * changed. `target_time` is RFC 3339 and must not be in the future.
 */
export interface RestoreDatabaseRequest {
  name: string;
  description?: string;
  target_time: Date | string;
  flavor: string;
  storage_gb: number;
  subnet_id: string;
  security_group_ids?: string[];
  admin_username: string;
}

export interface DeleteDatabaseOptions {
  /** Erase the backups now instead of keeping them for their retention. */
  purgeBackups?: boolean;
}

function refuse(message: string): never {
  throw new Error(`nemau: ${message}`);
}

function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) refuse("database name must match ^[a-z][a-z0-9-]{0,62}$");
}

function checkDescription(description: string | undefined): void {
  if (description === undefined) return;
  if (new TextEncoder().encode(description).length > DATABASE_MAX_DESCRIPTION_BYTES) {
    refuse("database description is too long");
  }
  if (CONTROL_PATTERN.test(description)) refuse("database description holds no control characters");
}

function checkStorage(gb: number): void {
  if (!Number.isInteger(gb) || gb < DATABASE_STORAGE_MIN_GB || gb > DATABASE_STORAGE_MAX_GB) {
    refuse(`storage_gb must be between ${DATABASE_STORAGE_MIN_GB} and ${DATABASE_STORAGE_MAX_GB}`);
  }
}

function checkRetention(days: number): void {
  if (!Number.isInteger(days) || days < DATABASE_RETENTION_MIN_DAYS || days > DATABASE_RETENTION_MAX_DAYS) {
    refuse(`backup_retention_days must be between ${DATABASE_RETENTION_MIN_DAYS} and ${DATABASE_RETENTION_MAX_DAYS}`);
  }
}

function checkWindow(window: DatabaseMaintenanceWindowRequest): void {
  if (
    !Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6 ||
    !Number.isInteger(window.hour) || window.hour < 0 || window.hour > 23
  ) {
    refuse("maintenance_window needs weekday 0-6 and hour 0-23 (UTC)");
  }
}

function checkSubnet(subnetId: string): void {
  if (!UUID_PATTERN.test(subnetId)) refuse("subnet_id must be a UUID");
}

function checkSecurityGroups(ids: string[] | undefined): void {
  if (ids === undefined) return;
  if (ids.length > DATABASE_MAX_SECURITY_GROUPS) {
    refuse(`security_group_ids accepts at most ${DATABASE_MAX_SECURITY_GROUPS} groups`);
  }
  for (const id of ids) {
    if (!UUID_PATTERN.test(id)) refuse("security_group_ids must hold UUIDs");
  }
}

function checkAdminUsername(name: string): void {
  if (!ADMIN_USERNAME_PATTERN.test(name)) refuse("admin_username must match ^[a-z][a-z0-9_]{2,31}$");
  if (name === "postgres" || name.startsWith("pg_") || name.startsWith("nemau")) {
    refuse("admin_username is reserved");
  }
}

function checkRestoreTime(target: Date | string): string {
  if (target instanceof Date) {
    if (Number.isNaN(target.getTime())) refuse("target_time is not a valid date");
    if (target.getTime() > Date.now()) refuse("target_time must not be in the future");
    return target.toISOString();
  }
  if (!RFC3339_PATTERN.test(target) || Number.isNaN(Date.parse(target))) {
    refuse("target_time must be an RFC 3339 timestamp");
  }
  if (Date.parse(target) > Date.now()) refuse("target_time must not be in the future");
  return target;
}

/**
 * The create body, with exactly the fields the API knows. An absent optional
 * field is left out, never sent as null, so the server's default applies.
 */
function createBody(request: CreateDatabaseRequest): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: request.name,
    version: request.version,
    flavor: request.flavor,
    storage_gb: request.storage_gb,
    subnet_id: request.subnet_id,
    admin_username: request.admin_username,
  };
  if (request.description !== undefined) json.description = request.description;
  if (request.security_group_ids !== undefined) json.security_group_ids = request.security_group_ids;
  if (request.backup_retention_days !== undefined) json.backup_retention_days = request.backup_retention_days;
  if (request.maintenance_window !== undefined) {
    json.maintenance_window = {
      weekday: request.maintenance_window.weekday,
      hour: request.maintenance_window.hour,
    };
  }
  return json;
}

function restoreBody(request: RestoreDatabaseRequest, targetTime: string): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: request.name,
    target_time: targetTime,
    flavor: request.flavor,
    storage_gb: request.storage_gb,
    subnet_id: request.subnet_id,
    admin_username: request.admin_username,
  };
  if (request.description !== undefined) json.description = request.description;
  if (request.security_group_ids !== undefined) json.security_group_ids = request.security_group_ids;
  return json;
}

/** Shape of the 202 that issues a password. */
function issued(body: DatabaseCredentials): DatabaseCredentials {
  if (typeof body?.password !== "string" || !body.password) {
    // The message names no part of the answer: a password must never reach a log.
    throw new Error("nemau: the API answered without a database password");
  }
  return body;
}

/**
 * Managed PostgreSQL: create, read, change, resize, restore, rotate
 * and delete. The database is reached at `address`:`port` over TLS, verified
 * with the CA from {@link DatabaseService.caCertificate}.
 *
 * A create, a rotation and a restore answer with the password once. These
 * three writes are sent without an Idempotency-Key, which the API refuses on
 * them: a retry is not replayed, so a repeat call makes a new password. Read the
 * database back, or rotate, instead of retrying.
 */
export class DatabaseService extends Service {
  async list(): Promise<Database[]> {
    const out = await this.client.request<{ databases: Database[] }>({
      method: "GET",
      path: "/databases",
    });
    return out.databases ?? [];
  }

  async get(id: string): Promise<Database> {
    return this.client.request<Database>({
      method: "GET",
      path: `/databases/${encodeURIComponent(id)}`,
    });
  }

  /** The PEM of the region's database CA: the `sslrootcert` of `sslmode=verify-full`. */
  async caCertificate(): Promise<string> {
    const out = await this.client.request<{ ca_certificate_pem: string }>({
      method: "GET",
      path: "/databases/ca-certificate",
    });
    return out.ca_certificate_pem;
  }

  /**
   * Queues the creation. The returned password is the administrator's and is
   * shown once: store it at once, it cannot be read again.
   */
  async create(request: CreateDatabaseRequest): Promise<DatabaseCredentials> {
    checkName(request.name);
    checkDescription(request.description);
    checkStorage(request.storage_gb);
    checkSubnet(request.subnet_id);
    checkSecurityGroups(request.security_group_ids);
    checkAdminUsername(request.admin_username);
    if (request.backup_retention_days !== undefined) checkRetention(request.backup_retention_days);
    if (request.maintenance_window !== undefined) checkWindow(request.maintenance_window);
    return issued(
      await this.client.request<DatabaseCredentials>({ method: "POST", path: "/databases", json: createBody(request) }),
    );
  }

  async update(id: string, request: UpdateDatabaseRequest): Promise<TaskRef> {
    const json: Record<string, unknown> = {};
    if (request.name !== undefined) {
      checkName(request.name);
      json.name = request.name;
    }
    if (request.description !== undefined) {
      checkDescription(request.description);
      json.description = request.description;
    }
    if (request.backup_retention_days !== undefined) {
      checkRetention(request.backup_retention_days);
      json.backup_retention_days = request.backup_retention_days;
    }
    if (request.maintenance_window === null) {
      json.maintenance_window = null;
    } else if (request.maintenance_window !== undefined) {
      checkWindow(request.maintenance_window);
      json.maintenance_window = { weekday: request.maintenance_window.weekday, hour: request.maintenance_window.hour };
    }
    if (Object.keys(json).length === 0) refuse("database.update was given no field to change");
    return this.client.submit({ method: "PATCH", path: `/databases/${encodeURIComponent(id)}`, json });
  }

  /** The sizes the region offers. Pass one of their names as `flavor`. */
  async flavors(): Promise<DatabaseFlavor[]> {
    const out = await this.client.request<{ flavors: DatabaseFlavor[] }>({
      method: "GET",
      path: "/database-flavors",
    });
    return out.flavors ?? [];
  }

  /** The PostgreSQL majors the region admits, such as "17". */
  async versions(): Promise<string[]> {
    const out = await this.client.request<{ versions: string[] }>({
      method: "GET",
      path: "/database-versions",
    });
    return out.versions ?? [];
  }

  /** Queues a reboot of the appliance. The database stays active and is not billed for the restart. */
  async restart(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "POST", path: `/databases/${encodeURIComponent(id)}/restart` });
  }

  async resize(id: string, request: ResizeDatabaseRequest): Promise<TaskRef> {
    if (request.flavor === undefined && request.storage_gb === undefined) {
      refuse("database.resize needs a flavor, a storage_gb, or both");
    }
    if (request.storage_gb !== undefined) checkStorage(request.storage_gb);
    if (request.apply_at !== undefined && !(APPLY_AT_VALUES as readonly string[]).includes(request.apply_at)) {
      refuse("apply_at must be now or maintenance_window");
    }
    const json: Record<string, unknown> = {};
    if (request.flavor !== undefined) json.flavor = request.flavor;
    if (request.storage_gb !== undefined) json.storage_gb = request.storage_gb;
    if (request.apply_at !== undefined) json.apply_at = request.apply_at;
    return this.client.submit({ method: "POST", path: `/databases/${encodeURIComponent(id)}/resize`, json });
  }

  /** Issues a new administrator password. The old one stays valid until the task applies the new one. */
  async rotatePassword(id: string): Promise<DatabaseCredentials> {
    return issued(
      await this.client.request<DatabaseCredentials>({
        method: "POST",
        path: `/databases/${encodeURIComponent(id)}/rotate-password`,
      }),
    );
  }

  /** Restores the source at `target_time` into a new database, and returns its password once. */
  async restore(sourceId: string, request: RestoreDatabaseRequest): Promise<DatabaseCredentials> {
    const targetTime = checkRestoreTime(request.target_time);
    checkName(request.name);
    checkDescription(request.description);
    checkStorage(request.storage_gb);
    checkSubnet(request.subnet_id);
    checkSecurityGroups(request.security_group_ids);
    checkAdminUsername(request.admin_username);
    const json = restoreBody(request, targetTime);
    return issued(
      await this.client.request<DatabaseCredentials>({
        method: "POST",
        path: `/databases/${encodeURIComponent(sourceId)}/restore`,
        json,
      }),
    );
  }

  /** Deletes the database. Its backups survive for their retention unless `purgeBackups` is set. */
  async delete(id: string, options: DeleteDatabaseOptions = {}): Promise<TaskRef> {
    const path = `/databases/${encodeURIComponent(id)}`;
    return options.purgeBackups
      ? this.client.submit({ method: "DELETE", path, query: { purge_backups: "true" } })
      : this.client.submit({ method: "DELETE", path });
  }
}
