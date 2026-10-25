import { Service } from "./base.ts";
import type { AccessKeyInfo, AccessKeyLimits, CreatedAccessKey, IamUser, Paginated } from "../types.ts";

/** Longest lifetime the API grants an access key, in milliseconds (365 days). */
export const MAX_ACCESS_KEY_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Default lifetime of a key created without `expiresAt` (90 days). */
export const DEFAULT_ACCESS_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The most active access keys one user may hold. */
export const MAX_ACCESS_KEYS_PER_USER = 5;

export interface CreateUserRequest {
  username: string;
  email: string;
  name?: string;
  surname?: string;
  /** Optional: without one the user signs in by another route. */
  password?: string;
}

/** The fields of a user an owner may change; an omitted key is left alone. */
export interface UpdateUserRequest {
  name?: string;
  surname?: string;
  username?: string;
  email?: string;
  password?: string;
}

export interface CreateAccessKeyRequest {
  description?: string;
  /**
   * When the key stops working. Optional: omitted means 90 days from now. It
   * must be in the future and at most 365 days away; anything else throws
   * before a request is sent, where the API would answer 400.
   */
  expiresAt?: Date | string;
}

/**
 * /iam: the organization's users and their access keys.
 *
 * Users are managed by the organization owner. A user manages their own keys; an
 * owner manages everyone's. These calls are synchronous: they answer with the
 * result, not with a task.
 */
export class IamService extends Service {
  /** One page of the organization's users. `limit` is capped at 100 by the API. */
  async listUsers(options: { page?: number; limit?: number; signal?: AbortSignal } = {}): Promise<Paginated<IamUser>> {
    return this.client.request<Paginated<IamUser>>({
      method: "GET",
      path: "/iam/users",
      query: { page: options.page, limit: options.limit },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Iterates over every user, page by page. */
  async *iterateUsers(options: { limit?: number; signal?: AbortSignal } = {}): AsyncGenerator<IamUser, void, undefined> {
    for (let page = 1; ; page++) {
      const result = await this.listUsers({ page, ...options });
      for (const user of result.data ?? []) yield user;
      if (!result.has_more) return;
    }
  }

  async getUser(userId: string): Promise<IamUser> {
    return this.client.request<IamUser>({ method: "GET", path: `/iam/users/${encodeURIComponent(userId)}` });
  }

  async createUser(request: CreateUserRequest): Promise<IamUser> {
    return this.client.request<IamUser>({ method: "POST", path: "/iam/users", json: pick(request, ["username", "email", "name", "surname", "password"]) });
  }

  async updateUser(userId: string, update: UpdateUserRequest): Promise<IamUser> {
    const body = pick(update, ["name", "surname", "username", "email", "password"]);
    if (Object.keys(body).length === 0) throw new Error("nemau: updateUser needs at least one field");
    return this.client.request<IamUser>({ method: "PUT", path: `/iam/users/${encodeURIComponent(userId)}`, json: body });
  }

  /** Blocks the user from signing in, and ends their sessions. */
  async disableUser(userId: string): Promise<void> {
    await this.client.request({ method: "PUT", path: `/iam/users/${encodeURIComponent(userId)}/disable` });
  }

  async enableUser(userId: string): Promise<void> {
    await this.client.request({ method: "PUT", path: `/iam/users/${encodeURIComponent(userId)}/enable` });
  }

  /**
   * Deletes a user. The API wants the deletion confirmed, so the user's id and
   * email are required: a stale id cannot delete someone else.
   */
  async deleteUser(userId: string, email: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/iam/users/${encodeURIComponent(userId)}`,
      json: { confirmUserId: userId, confirmEmail: email, confirmPhrase: "DELETE" },
    });
  }

  /** The user's access keys. The secret is never included. */
  async listAccessKeys(userId: string): Promise<AccessKeyInfo[]> {
    const out = await this.client.request<{ accessKeys?: AccessKeyInfo[] }>({
      method: "GET",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys`,
    });
    return out.accessKeys ?? [];
  }

  async getAccessKey(userId: string, keyId: string): Promise<AccessKeyInfo> {
    return this.client.request<AccessKeyInfo>({
      method: "GET",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys/${encodeURIComponent(keyId)}`,
    });
  }

  /**
   * Creates an access key. The secret is returned here only.
   *
   * Every key expires: without `expiresAt` it is 90 days from now, and the
   * longest lifetime is 365 days. A user holds at most 5 active keys; beyond
   * that the API answers 409, which `isAccessKeyLimit` recognises. Check
   * `accessKeyLimits()` first to show the count.
   */
  async createAccessKey(userId: string, request: CreateAccessKeyRequest = {}): Promise<CreatedAccessKey> {
    const body: Record<string, unknown> = {};
    if (request.description !== undefined) body["description"] = request.description;
    if (request.expiresAt !== undefined) body["expiresAt"] = checkedExpiry(request.expiresAt);
    return this.client.request<CreatedAccessKey>({
      method: "POST",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys`,
      json: body,
    });
  }

  /**
   * How many active keys a user holds and the cap. Without `userId`, the
   * caller's own; naming another user is for owners (403 otherwise).
   */
  async accessKeyLimits(userId?: string): Promise<AccessKeyLimits> {
    return this.client.request<AccessKeyLimits>({
      method: "GET",
      path: "/iam/access-keys/limits",
      query: { userId },
    });
  }

  /** Activates or deactivates a key. Reactivating beyond the cap answers 409. */
  async setAccessKeyStatus(userId: string, keyId: string, status: "active" | "inactive"): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys/${encodeURIComponent(keyId)}/status`,
      json: { status },
    });
  }

  /** Replaces a key's secret. The new secret is returned here only. */
  async rotateAccessKey(userId: string, keyId: string): Promise<CreatedAccessKey> {
    return this.client.request<CreatedAccessKey>({
      method: "POST",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys/${encodeURIComponent(keyId)}/rotate`,
    });
  }

  async deleteAccessKey(userId: string, keyId: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/iam/users/${encodeURIComponent(userId)}/access-keys/${encodeURIComponent(keyId)}`,
    });
  }
}

/** Copies only the declared keys that are set: the API refuses unknown fields. */
function pick<T extends object>(source: T, keys: readonly (keyof T & string)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function checkedExpiry(value: Date | string): string {
  const at = value instanceof Date ? value : new Date(value);
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new Error("nemau: expiresAt must be an RFC 3339 date");
  const now = Date.now();
  if (ms <= now || ms > now + MAX_ACCESS_KEY_TTL_MS) {
    throw new Error("nemau: expiresAt must be in the future and at most 365 days from now");
  }
  return typeof value === "string" ? value : at.toISOString();
}
