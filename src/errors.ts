/** Nemau Cloud SDK errors. */

import { ERROR_CODE_RESOURCE_IN_USE, type Task } from "./types.ts";

/**
 * A non-2xx response from the API.
 *
 * `message` is the text the API returned. Its 4xx messages are passed through
 * as written ("project quota exceeded for instances: 10/10 in use"); other
 * errors carry a generic text. It is safe to display but not always specific.
 */
export class NemauApiError extends Error {
  readonly statusCode: number;
  /**
   * Machine-readable code some refusals carry: `permission_denied` on
   * authorisation failures, {@link REASON_SUBNET_OVERLAP} on a subnet whose
   * range is taken. Empty otherwise.
   */
  readonly reason: string;
  /**
   * Stable, machine-readable cause some refusals carry (`credential_limit`,
   * `organization_read_only`, `invalid_request`), empty otherwise. Branch on it,
   * never on `message`.
   */
  readonly code: string;
  /**
   * Qualifies a `credential_limit` refusal: the cap that was reached (`limit`, 0
   * when the server did not say) and what it counts (`scope`: `bucket` or
   * `project`, empty when absent).
   */
  readonly limit: number;
  readonly scope: string;
  /** Truncated raw body, useful when a proxy answered with HTML. */
  readonly body: string;
  readonly method: string;
  readonly path: string;
  /**
   * The server's `Retry-After` hint in milliseconds, 0 when absent or not
   * understood. Sent with 429 and 503 refusals.
   */
  readonly retryAfterMs: number;

  constructor(init: {
    statusCode: number;
    message: string;
    reason?: string;
    code?: string;
    limit?: number;
    scope?: string;
    body?: string;
    method: string;
    path: string;
    retryAfterMs?: number;
  }) {
    super(`${init.method} ${init.path}: ${init.statusCode} ${init.message}`);
    this.name = "NemauApiError";
    this.statusCode = init.statusCode;
    this.reason = init.reason ?? "";
    this.code = init.code ?? "";
    this.limit = init.limit ?? 0;
    this.scope = init.scope ?? "";
    this.body = init.body ?? "";
    this.method = init.method;
    this.path = init.path;
    this.retryAfterMs = init.retryAfterMs ?? 0;
  }

  /** A further attempt could reasonably succeed. */
  get retryable(): boolean {
    if (this.statusCode === 429) return this.code !== ERROR_CODE_CREDENTIAL_LIMIT;
    return this.statusCode >= 500;
  }

  get notFound(): boolean {
    return this.statusCode === 404;
  }

  get unauthorized(): boolean {
    return this.statusCode === 401;
  }

  /**
   * Valid credential, not authorized. On this API that is an IAM policy, a
   * token scope, or a missing organization feature.
   */
  get forbidden(): boolean {
    return this.statusCode === 403;
  }
}

/**
 * A task reached a terminal, unsuccessful state: the submitted work did not
 * happen.
 *
 * For most failures the API replaces the underlying error with a fixed string.
 * The message includes the task id, which support needs to investigate.
 */
export class NemauTaskFailedError extends Error {
  readonly task: Task;

  constructor(task: Task) {
    const detail = task.error ? `: ${task.error}` : "";
    super(`task ${task.id} (${task.taskType}) ${task.status}${detail}`);
    this.name = "NemauTaskFailedError";
    this.task = task;
  }
}

/**
 * Whether the platform refused the operation because a dependant still uses the
 * resource. The error message names what to remove first.
 */
export function isResourceInUse(error: unknown): boolean {
  return error instanceof NemauTaskFailedError && error.task.errorCode === ERROR_CODE_RESOURCE_IN_USE;
}

/** Stable error codes carried by {@link NemauApiError.code}. */
export const ERROR_CODE_CREDENTIAL_LIMIT = "credential_limit";
export const ERROR_CODE_ORGANIZATION_READ_ONLY = "organization_read_only";
export const ERROR_CODE_INVALID_REQUEST = "invalid_request";
/** Carried by a 429: the caller exceeded its write budget. */
export const ERROR_CODE_RATE_LIMITED = "rate_limited";
/** Carried by a 503: a platform dependency is unreachable. */
export const ERROR_CODE_UNAVAILABLE = "unavailable";
/** Carried by a 422: an Idempotency-Key was reused with different parameters. */
export const ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH = "idempotency_key_mismatch";
/** The `reason` of the 409 refusing an access key beyond the per-user cap. */
export const REASON_ACCESS_KEY_LIMIT = "access_key_limit";

/**
 * Whether the same Idempotency-Key was already used for a write with other
 * parameters (HTTP 422). Not retryable: send the new parameters under a new key.
 */
export function isIdempotencyKeyMismatch(error: unknown): boolean {
  return error instanceof NemauApiError && error.code === ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH;
}

/** Whether the platform refused the write because the caller is rate limited (HTTP 429). */
export function isRateLimited(error: unknown): boolean {
  return error instanceof NemauApiError && error.statusCode === 429 && error.code !== ERROR_CODE_CREDENTIAL_LIMIT;
}

/**
 * Whether the user already holds the maximum number of active IAM access keys
 * (HTTP 409). Deactivate or delete a key first; repeating the call cannot succeed.
 */
export function isAccessKeyLimit(error: unknown): boolean {
  return error instanceof NemauApiError && error.reason === REASON_ACCESS_KEY_LIMIT;
}

/** Parses a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? 0 : Math.max(0, date - now);
}

/**
 * Whether the container already holds the maximum number of access keys (HTTP
 * 429). Revoke an unused key, then retry; repeating the same call cannot succeed.
 */
export function isCredentialLimit(error: unknown): boolean {
  return error instanceof NemauApiError && error.code === ERROR_CODE_CREDENTIAL_LIMIT;
}

/** Whether the organization is in its read-only phase (HTTP 403). */
export function isOrganizationReadOnly(error: unknown): boolean {
  return error instanceof NemauApiError && error.code === ERROR_CODE_ORGANIZATION_READ_ONLY;
}

/**
 * The `reason` of the 409 refusing a subnet whose CIDR overlaps another subnet
 * of the same project. All the subnets of a project are routed together,
 * whichever network they belong to, so the conflict may sit on another
 * network; the message names the subnet, its range and its network.
 */
export const REASON_SUBNET_OVERLAP = "subnet_overlap";

/**
 * The API refused a subnet because its range overlaps another subnet of the
 * project.
 *
 * It matches the refusal of the creation request itself, which is where an
 * overlap is caught. A conflicting subnet created by someone else between that
 * request and the task running fails the task instead: that surfaces as a
 * `NemauTaskFailedError` carrying the same message, without the reason.
 */
export function isSubnetOverlap(error: unknown): boolean {
  return error instanceof NemauApiError && error.reason === REASON_SUBNET_OVERLAP;
}

/** The `reason` of the 409 refusing to delete a certificate a listener serves. */
export const REASON_CERTIFICATE_IN_USE = "certificate_in_use";

/**
 * The API refused to delete a certificate because a listener still serves it.
 * Other certificate refusals carry a `certificate_*` reason as well.
 */
export function isCertificateInUse(error: unknown): boolean {
  return error instanceof NemauApiError && error.reason === REASON_CERTIFICATE_IN_USE;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof NemauApiError && error.notFound;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof NemauApiError && error.unauthorized;
}

export function isForbidden(error: unknown): boolean {
  return error instanceof NemauApiError && error.forbidden;
}

/**
 * Whether `error` is an API refusal carrying the given machine-readable
 * reason code, such as `REASON_DNS_ZONE_RESERVED`. Matching on the code rather
 * than on the message keeps a caller working when the wording changes.
 */
export function hasReason(error: unknown, reason: string): boolean {
  return reason !== "" && error instanceof NemauApiError && error.reason === reason;
}

/** How much of an error body is kept. */
const MAX_ERROR_BODY = 4096;

/** Builds the error for a non-2xx response, consuming its body. */
export async function errorFromResponse(
  response: Response,
  method: string,
  path: string,
): Promise<NemauApiError> {
  let raw = "";
  try {
    raw = (await response.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    // An unreadable body still produces an error with the status code.
  }

  let message = "";
  let reason = "";
  let code = "";
  let limit = 0;
  let scope = "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      message?: string;
      reason?: string;
      code?: string;
      limit?: number;
      scope?: string;
    };
    message = parsed.error ?? parsed.message ?? "";
    reason = parsed.reason ?? "";
    code = typeof parsed.code === "string" ? parsed.code : "";
    // The 422 body has a single key: {"error": "<code>"}.
    if (!code && response.status === 422 && parsed.error === ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH) {
      code = ERROR_CODE_IDEMPOTENCY_KEY_MISMATCH;
    }
    limit = typeof parsed.limit === "number" && parsed.limit > 0 ? parsed.limit : 0;
    scope = typeof parsed.scope === "string" ? parsed.scope : "";
  } catch {
    message = raw.trim();
  }
  if (!message) message = response.statusText || String(response.status);
  if (reason) message += ` (${reason})`;

  return new NemauApiError({
    statusCode: response.status,
    message,
    reason,
    code,
    limit,
    scope,
    body: raw,
    method,
    path,
    retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
  });
}

/**
 * The 404 built locally when a list-and-filter read finds nothing. It is a
 * NemauApiError, so `isNotFound` treats it like a 404 from the server.
 */
export function notFound(kind: string, id: string, path: string): NemauApiError {
  return new NemauApiError({
    statusCode: 404,
    message: `${kind} "${id}" not found in this project`,
    method: "GET",
    path,
  });
}
