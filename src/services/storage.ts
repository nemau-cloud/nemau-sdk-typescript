import { Service } from "./base.ts";
import { notFound } from "../errors.ts";
import { patch, type ResourceUpdate } from "./update.ts";
import type {
  Container,
  ContainerProtection,
  StoredObject,
  TaskRef,
  Volume,
} from "../types.ts";

/** Objects per `listObjects` page when no limit is given. */
export const DEFAULT_OBJECT_PAGE_SIZE = 100;

/** The most objects one `listObjects` request may ask for. */
export const MAX_OBJECT_PAGE_SIZE = 1000;

/**
 * The per-object cap on uploads and downloads that go through the API. A
 * presigned URL is not subject to it.
 */
export const MAX_OBJECT_SIZE = 100 * 1024 * 1024;

/**
 * The largest object a server-side copy accepts: the ceiling of a single S3
 * CopyObject. Beyond it, copy with S3 access keys scoped to the containers
 * involved and rclone or the aws cli.
 */
export const MAX_COPY_SIZE = 5 * 1024 * 1024 * 1024;

/**
 * Retention modes for an immutable container.
 *
 * GOVERNANCE retention can be lifted by the platform; COMPLIANCE retention
 * cannot be lifted by anyone until it expires. A customer credential cannot
 * lift either one.
 */
export const RETENTION_GOVERNANCE = "GOVERNANCE";
export const RETENTION_COMPLIANCE = "COMPLIANCE";
/** Longest default retention the API accepts: seven years. */
export const MAX_RETENTION_DAYS = 2555;

/** Container to create, and the protection it is born with. */
export interface CreateContainerRequest {
  name: string;
  /** Keeps previous versions. Implied by `object_lock`. */
  versioning?: boolean;
  /** Makes versions immutable for `retention_days`. */
  object_lock?: boolean;
  retention_mode?: string;
  retention_days?: number;
}

/**
 * Whether a container is immutable: it needs both versioning and object lock.
 * With versioning alone, a delete still removes a version.
 */
export function isContainerImmutable(protection?: ContainerProtection): boolean {
  return protection !== undefined && protection.object_lock && protection.versioning === "Enabled";
}

/** Longest expiry the API accepts for a presigned URL. */
export const PRESIGN_TTL_CAP_SECONDS = 3600;

/** What an S3 access key may do inside its container. */
export type CredentialAccess = "read_only" | "read_write";

const CREDENTIAL_ACCESS: readonly CredentialAccess[] = ["read_only", "read_write"];

/**
 * An S3 access key scoped to one object container. It never carries the
 * secret, which is only on the {@link IssuedCredential} returned when the key
 * is created.
 */
export interface StorageCredential {
  access_key_id: string;
  access: CredentialAccess;
  container: string;
  created_at: string;
  /** `null` for a key that never expires. */
  expires_at: string | null;
}

const REDACTED = "[redacted]";

/**
 * The result of creating a key.
 *
 * `secret_access_key` is only returned here. The platform does not store it, so
 * a caller that loses it must create a new key. `String()`, `JSON.stringify`
 * and `console.log`/`util.inspect` print `[redacted]` in its place; read the
 * property directly to get the value.
 */
export class IssuedCredential implements StorageCredential {
  readonly access_key_id: string;
  readonly access: CredentialAccess;
  readonly container: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly secret_access_key: string;
  /**
   * The bucket name to address with this key from an S3 tool
   * (`aws s3 sync s3://<s3_bucket>`, `rclone sync remote:<s3_bucket>`). It
   * differs from the container name: in the object store each container has an
   * opaque name of its own, and the key's policy only covers that name.
   */
  readonly s3_bucket: string;
  readonly region: string;
  /** Empty when the platform has no reachable S3 endpoint to show (a demonstration environment). */
  readonly endpoint: string;

  constructor(raw: {
    access_key_id: string;
    secret_access_key: string;
    access: CredentialAccess;
    container: string;
    s3_bucket?: string | null;
    region: string;
    endpoint?: string | null;
    created_at: string;
    expires_at?: string | null;
  }) {
    this.access_key_id = raw.access_key_id;
    this.secret_access_key = raw.secret_access_key;
    this.access = raw.access;
    this.container = raw.container;
    this.s3_bucket = raw.s3_bucket ?? "";
    this.region = raw.region;
    this.endpoint = raw.endpoint ?? "";
    this.created_at = raw.created_at;
    this.expires_at = raw.expires_at ?? null;
  }

  private redactedView(): Record<string, unknown> {
    return { ...(this as unknown as Record<string, unknown>), secret_access_key: REDACTED };
  }

  toString(): string {
    return `IssuedCredential(${this.access_key_id} on ${this.container} (S3 bucket ${this.s3_bucket}), ${this.access}, secret ${REDACTED})`;
  }

  toJSON(): Record<string, unknown> {
    return this.redactedView();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.redactedView();
  }
}

/** A key to create. */
export interface CreateCredentialRequest {
  access: CredentialAccess;
  /**
   * Revokes the key at that instant. Must be in the future and within the
   * platform's maximum lifetime (the server decides). Omit for a key that never
   * expires.
   */
  expiresAt?: Date;
}

function credentialsPath(container: string): string {
  return `/storage/containers/${encodeURIComponent(container)}/credentials`;
}

/** A temporary URL to an object, usable directly against the store. */
export interface PresignedObject {
  url: string;
  method: string;
  expires_at: string;
  max_bytes?: number;
}

export interface ObjectPage {
  objects: StoredObject[];
  /** Empty on the last page; pass it back as `marker` for the next one. */
  next_marker: string;
  count: number;
}

export interface UploadedObject {
  object_name: string;
  size: number;
}

/** Where a copy lands, and the metadata it carries. */
export interface CopyObjectOptions {
  /** Defaults to the source container. */
  destinationContainer?: string;
  /** Defaults to the source key. */
  destinationKey?: string;
  /**
   * Replaces the source's content type and metadata instead of keeping them.
   * Required by `contentType` and `metadata`.
   */
  replaceMetadata?: boolean;
  /** Defaults to the source's content type. */
  contentType?: string;
  metadata?: Record<string, string>;
}

/** The retention an object version is locked under. */
export interface ObjectRetention {
  mode: string;
  retain_until: string;
}

/** The object a server-side copy created. */
export interface CopiedObject {
  container: string;
  key: string;
  size: number;
  etag: string;
  /** Absent when the destination container is not versioned. */
  version_id?: string;
  last_modified: string;
  /** The destination container's default retention; absent when it has none. */
  retention?: ObjectRetention;
}

/**
 * /storage: block volumes and object containers.
 *
 * Volume ids travel as `?id=` and object keys as `?key=`, never as path
 * segments. A volume id can contain a slash, as in
 * "nemau-storage:104/vm-104-disk-0.qcow2", and so can an object key; in the
 * path either one would add a segment and the route would no longer match.
 */
export class StorageService extends Service {
  async listVolumes(): Promise<Volume[]> {
    const out = await this.client.request<{ volumes: Volume[] }>({
      method: "GET",
      path: "/storage/volumes",
    });
    return out.volumes ?? [];
  }

  async getVolume(id: string): Promise<Volume> {
    const found = (await this.listVolumes()).find((v) => v.id === id);
    if (!found) throw notFound("volume", id, "/storage/volumes");
    return found;
  }

  /** `sizeGB` is in GiB. */
  async createVolume(name: string, sizeGB: number, description = ""): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: "/storage/volumes",
      json: { name, description, size: sizeGB },
    });
  }

  async createVolumeAndWait(name: string, sizeGB: number, description = ""): Promise<Volume> {
    const ref = await this.createVolume(name, sizeGB, description);
    const { id } = await this.client.waitForResourceId(ref, "volume_id");
    return this.getVolume(id);
  }

  async deleteVolume(id: string): Promise<TaskRef> {
    return this.client.submit({ method: "DELETE", path: "/storage/volumes", query: { id } });
  }

  /** The finished task carries `device_id`, the /dev/disk/by-id name in the guest. */
  async attachVolume(volumeId: string, instanceId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: "/storage/volumes/attach",
      query: { id: volumeId },
      json: { instance_id: instanceId },
    });
  }

  async detachVolume(volumeId: string, instanceId: string): Promise<TaskRef> {
    return this.client.submit({
      method: "POST",
      path: "/storage/volumes/detach",
      query: { id: volumeId },
      json: { instance_id: instanceId },
    });
  }

  /** A volume only ever grows. */
  async extendVolume(volumeId: string, newSizeGB: number): Promise<TaskRef> {
    return this.client.submit({
      method: "PUT",
      path: "/storage/volumes/extend",
      query: { id: volumeId },
      json: { new_size: newSizeGB },
    });
  }

  async listContainers(): Promise<Container[]> {
    const out = await this.client.request<{ containers: Container[] }>({
      method: "GET",
      path: "/storage/containers",
    });
    return out.containers ?? [];
  }

  async getContainer(name: string): Promise<Container> {
    const found = (await this.listContainers()).find((c) => c.name === name);
    if (!found) throw notFound("container", name, "/storage/containers");
    return found;
  }

  async createContainer(name: string): Promise<TaskRef> {
    return this.createContainerWithOptions({ name });
  }

  /**
   * Creates a container, optionally versioned and immutable.
   *
   * Protection can only be set at creation: S3 does not allow object lock to
   * be added to an existing bucket, so a container for immutable backups must
   * be created with it.
   */
  async createContainerWithOptions(request: CreateContainerRequest): Promise<TaskRef> {
    if (!request.object_lock && (request.retention_days || request.retention_mode)) {
      throw new Error("nemau: a retention policy requires object_lock");
    }
    if (request.retention_days !== undefined && request.retention_days > MAX_RETENTION_DAYS) {
      throw new Error(`nemau: retention_days must not exceed ${MAX_RETENTION_DAYS}`);
    }
    if (
      request.retention_mode &&
      request.retention_mode !== RETENTION_GOVERNANCE &&
      request.retention_mode !== RETENTION_COMPLIANCE
    ) {
      throw new Error(
        `nemau: retention_mode must be "${RETENTION_GOVERNANCE}" or "${RETENTION_COMPLIANCE}"`,
      );
    }
    return this.client.submit({ method: "POST", path: "/storage/containers", json: request });
  }

  /**
   * Reads the protection the object store enforces for a container.
   *
   * `Container.protection` reports what was requested at creation; this method
   * reports what is in force, so the two can be compared to verify that a
   * container is immutable.
   */
  async containerProtection(container: string): Promise<ContainerProtection> {
    const out = await this.client.request<{
      container: string;
      protection: ContainerProtection;
      immutable: boolean;
    }>({
      method: "GET",
      path: `/storage/containers/${encodeURIComponent(container)}/protection`,
    });
    return out.protection;
  }

  async deleteContainer(name: string): Promise<TaskRef> {
    return this.client.submit({
      method: "DELETE",
      path: `/storage/containers/${encodeURIComponent(name)}`,
    });
  }

  /**
   * One page of objects. `limit` is 1 to `MAX_OBJECT_PAGE_SIZE` (default
   * `DEFAULT_OBJECT_PAGE_SIZE`); anything else throws before a request is sent.
   *
   * `marker` is an opaque cursor: pass back the previous page's `next_marker`
   * verbatim, never a key. `prefix` filters server-side (at most 1024 bytes).
   * To walk every object, use {@link iterateObjects}.
   */
  async listObjects(
    container: string,
    options: { prefix?: string; marker?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ObjectPage> {
    const query: Record<string, string | number | undefined> = {};
    if (options.prefix) query["prefix"] = options.prefix;
    if (options.marker) query["marker"] = options.marker;
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_OBJECT_PAGE_SIZE) {
        throw new Error(`nemau: limit must be an integer between 1 and ${MAX_OBJECT_PAGE_SIZE}`);
      }
      query["limit"] = options.limit;
    }
    return this.client.request<ObjectPage>({
      method: "GET",
      path: `/storage/containers/${encodeURIComponent(container)}/objects`,
      query,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * Iterates over every object of a container, page by page, following
   * `next_marker` until the server says it is the last page.
   *
   * ```ts
   * for await (const object of nemau.storage.iterateObjects("photos", { prefix: "2026/" })) {
   *   console.log(object.name, object.size);
   * }
   * ```
   *
   * `pageSize` (1 to `MAX_OBJECT_PAGE_SIZE`) sets how many objects each request
   * fetches, not how many are returned. Stop early with `break`: no further
   * page is requested. A cursor the server repeats ends the walk with an error
   * rather than looping.
   */
  async *iterateObjects(
    container: string,
    options: { prefix?: string; pageSize?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<StoredObject, void, undefined> {
    let marker = "";
    for (;;) {
      const page = await this.listObjects(container, {
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(marker ? { marker } : {}),
        ...(options.pageSize !== undefined ? { limit: options.pageSize } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for (const object of page.objects ?? []) yield object;
      const next = page.next_marker ?? "";
      if (!next) return;
      if (next === marker) {
        throw new Error("nemau: the object listing returned the same cursor twice");
      }
      marker = next;
    }
  }

  /**
   * Uploads an object into a container.
   *
   * Synchronous, unlike most storage writes: the request body is the object
   * itself, so there is no background task. The API requires an exact
   * Content-Length and refuses anything over {@link MAX_OBJECT_SIZE}.
   */
  async uploadObject(
    container: string,
    key: string,
    body: Uint8Array | ArrayBuffer | string,
    contentType = "application/octet-stream",
  ): Promise<UploadedObject> {
    const payload = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body as ArrayBuffer);
    if (payload.byteLength > MAX_OBJECT_SIZE) {
      throw new Error(`nemau: object exceeds the ${MAX_OBJECT_SIZE} byte limit`);
    }
    return this.client.request<UploadedObject>({
      method: "POST",
      path: `/storage/containers/${encodeURIComponent(container)}/objects`,
      query: { key },
      body: payload,
      contentType,
      contentLength: payload.byteLength,
    });
  }

  /** Synchronous delete: answers 204. */
  async deleteObject(container: string, key: string): Promise<void> {
    await this.client.request<void>({
      method: "DELETE",
      path: `/storage/containers/${encodeURIComponent(container)}/objects`,
      query: { key },
    });
  }

  /**
   * Copies an object server-side, within its container or into another one.
   *
   * The bytes pass through neither the API nor the client, so
   * {@link MAX_OBJECT_SIZE} does not apply; the limit is {@link MAX_COPY_SIZE},
   * that of a single S3 CopyObject. A larger source answers 413: copy it with
   * S3 access keys scoped to the containers involved
   * ({@link StorageService.createCredential}) and rclone or the aws cli.
   *
   * Both containers must belong to the current project. Synchronous, like
   * uploads: the copy exists when this returns, and there is no task to wait
   * for.
   *
   * The source's content type and metadata are kept unless `replaceMetadata` is
   * set. Copying an object onto itself is refused unless it replaces them,
   * which is how an object's metadata is changed.
   *
   * A copy into a container with object lock receives that container's default
   * retention. The source's retention is not copied, and a shorter one cannot
   * be chosen.
   */
  async copyObject(
    container: string,
    key: string,
    options: CopyObjectOptions = {},
  ): Promise<CopiedObject> {
    const metadata =
      options.metadata && Object.keys(options.metadata).length > 0 ? options.metadata : undefined;
    if (!options.replaceMetadata && (options.contentType || metadata)) {
      throw new Error("nemau: contentType and metadata require replaceMetadata");
    }
    const json: Record<string, unknown> = { key };
    if (options.destinationContainer) json["destination_container"] = options.destinationContainer;
    if (options.destinationKey) json["destination_key"] = options.destinationKey;
    if (options.replaceMetadata) json["replace_metadata"] = true;
    if (options.contentType) json["content_type"] = options.contentType;
    if (metadata) json["metadata"] = metadata;
    return this.client.request<CopiedObject>({
      method: "POST",
      path: `/storage/containers/${encodeURIComponent(container)}/copy`,
      json,
    });
  }

  /** Downloads an object. The body is a stream for the caller to consume. */
  async downloadObject(container: string, key: string): Promise<Response> {
    return this.client.requestRaw({
      method: "GET",
      path: `/storage/containers/${encodeURIComponent(container)}/download`,
      query: { key },
      raw: true,
    });
  }

  /**
   * Returns a URL that downloads one object without going through the API.
   *
   * Use it for bulk export: the other object methods stream bytes through the
   * API, which caps a transfer at {@link MAX_OBJECT_SIZE} per object. A
   * presigned URL is fetched directly from the object store, whatever the
   * object's size.
   *
   * Treat the result as a secret: it is a bearer token for that object until it
   * expires. A zero `ttlSeconds` uses the platform default of 15 minutes.
   */
  async presignGet(container: string, key: string, ttlSeconds = 0): Promise<PresignedObject> {
    return this.#presign(container, key, "GET", ttlSeconds);
  }

  /**
   * Returns a URL that uploads one object without going through the API, so
   * {@link MAX_OBJECT_SIZE} does not apply. Use it to import large objects.
   */
  async presignPut(container: string, key: string, ttlSeconds = 0): Promise<PresignedObject> {
    return this.#presign(container, key, "PUT", ttlSeconds);
  }

  async #presign(
    container: string,
    key: string,
    method: "GET" | "PUT",
    ttlSeconds: number,
  ): Promise<PresignedObject> {
    if (ttlSeconds > PRESIGN_TTL_CAP_SECONDS) {
      throw new Error(
        `nemau: requested expiry (${ttlSeconds}s) exceeds the ${PRESIGN_TTL_CAP_SECONDS}s cap`,
      );
    }
    const json: Record<string, unknown> = { key, method };
    if (ttlSeconds > 0) json["expires_in"] = ttlSeconds;
    return this.client.request<PresignedObject>({
      method: "POST",
      path: `/storage/containers/${encodeURIComponent(container)}/presign`,
      json,
    });
  }

  /**
   * Creates an S3 access key scoped to one container.
   *
   * Presigned URLs cover one object at a time; a key works with `aws s3 sync`,
   * `rclone sync` and anything else that speaks S3. Each container holds a
   * limited number of keys (see `isCredentialLimit`) and each key can be revoked
   * on its own.
   *
   * The caller needs permission to manage storage credentials
   * (`storage:ManageCredentials`). When the cap is reached `isCredentialLimit` is
   * true, and the error's `limit` and `scope` say how many keys are allowed and
   * what that counts.
   *
   * Synchronous. The response carries the key's secret, which cannot be read
   * again later.
   */
  async createCredential(container: string, req: CreateCredentialRequest): Promise<IssuedCredential> {
    if (!container) throw new Error("container is required");
    if (!CREDENTIAL_ACCESS.includes(req.access)) {
      throw new Error(`access must be ${CREDENTIAL_ACCESS.map((a) => `"${a}"`).join(" or ")}`);
    }
    const json: { access: CredentialAccess; expires_at?: string } = { access: req.access };
    if (req.expiresAt) {
      if (Number.isNaN(req.expiresAt.getTime())) throw new Error("expiresAt is not a valid date");
      json.expires_at = req.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    const raw = await this.client.request<ConstructorParameters<typeof IssuedCredential>[0]>({
      method: "POST",
      path: credentialsPath(container),
      json,
    });
    return new IssuedCredential(raw);
  }

  /** Lists a container's access keys. Secrets never come back. */
  async listCredentials(container: string): Promise<StorageCredential[]> {
    if (!container) throw new Error("container is required");
    const out = await this.client.request<{ credentials: StorageCredential[] }>({
      method: "GET",
      path: credentialsPath(container),
    });
    return (out.credentials ?? []).map((c) => ({ ...c, expires_at: c.expires_at ?? null }));
  }

  /** Revokes one access key of a container. */
  async revokeCredential(container: string, accessKeyId: string): Promise<void> {
    if (!container || !accessKeyId) throw new Error("container and access key id are required");
    await this.client.request<void>({
      method: "DELETE",
      path: `${credentialsPath(container)}/${encodeURIComponent(accessKeyId)}`,
    });
  }

  /**
   * Fetches a presigned URL.
   *
   * Sends no client credential: a presigned URL is already authorized, and an
   * access key attached to a request for the object store would go to a host
   * other than the API.
   */
  async fetchPresigned(presigned: PresignedObject): Promise<Response> {
    const response = await fetch(presigned.url);
    if (!response.ok) {
      // The URL is left out of the message: its signature is a live
      // credential, and error messages end up in logs.
      throw new Error(`nemau: presigned download refused (${response.status})`);
    }
    return response;
  }

  /**
   * Changes a volume's name or description. Its size changes with
   * {@link StorageService.extendVolume}, which only ever grows.
   */
  async updateVolume(volumeId: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateVolume", "/storage/volumes", update, { id: volumeId });
  }

  /**
   * Changes a container's versioning or retention.
   *
   * The name cannot be changed. Retention can be extended but not shortened,
   * so an existing WORM guarantee is never weakened.
   */
  async updateContainer(name: string, update: ResourceUpdate): Promise<TaskRef> {
    return patch(this.client, "updateContainer", `/storage/containers/${encodeURIComponent(name)}`, update);
  }
}
