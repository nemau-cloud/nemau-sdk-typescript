import { credentialFromEnv, ENV_API_URL, ENV_PROJECT, type Credential } from "./auth.ts";
import {
  errorFromResponse,
  ERROR_CODE_UNAVAILABLE,
  ERROR_CODE_RATE_LIMITED,
  NemauApiError,
  NemauTaskFailedError,
} from "./errors.ts";
import type { Task, TaskRef } from "./types.ts";
import { ComputeService } from "./services/compute.ts";
import { NetworkService } from "./services/network.ts";
import { LoadBalancerService } from "./services/loadbalancer.ts";
import { DatabaseService } from "./services/databases.ts";
import { InstanceGroupService } from "./services/instance-groups.ts";
import { StorageService } from "./services/storage.ts";
import { KubernetesService } from "./services/kubernetes.ts";
import { DNSService } from "./services/dns.ts";
import { MeteringService } from "./services/metering.ts";
import { RegionsService } from "./services/regions.ts";
import { TasksService } from "./services/tasks.ts";
import { ProjectsService } from "./services/projects.ts";
import { QuotasService } from "./services/quotas.ts";
import { IamService } from "./services/iam.ts";

/**
 * The public gateway. Override with `NEMAU_API_URL` or the `baseUrl` option for
 * a staging environment or a local stack (http://localhost:8000).
 */
export const DEFAULT_BASE_URL = "https://api.nemau-cloud.com";

/**
 * The API prefix. It is not configurable: every path in this SDK targets v1,
 * and another prefix would only produce 404s.
 */
const API_PREFIX = "/api/v1";

export const VERSION = "0.2.0";

/**
 * Names the project a request acts on. Sent only when one is selected;
 * otherwise the credential's own scope applies.
 */
export const PROJECT_SCOPE_HEADER = "X-Project-Id";

/** Makes a write safe to repeat: the same key and parameters yield the same task. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Set by the API on the 202 of a write it recognised by its Idempotency-Key. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The longest `Retry-After` honoured when the policy sets none. */
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export interface RetryPolicy {
  /** Total attempts, first one included. 1 disables retries. */
  maxAttempts: number;
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs: number;
  /** Ceiling on the exponential backoff, in milliseconds. */
  maxDelayMs: number;
  /**
   * The longest `Retry-After` the client will wait out, in milliseconds
   * (default 60 000). A server asking for more is not retried: the error is
   * thrown and the caller decides.
   */
  maxRetryAfterMs?: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 300, maxDelayMs: 5000 };

export interface ClientOptions {
  baseUrl?: string;
  credential?: Credential;
  /** Replaces the fetch implementation: a test double, an HTTP agent or instrumentation. */
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  retry?: RetryPolicy;
  /** Task polling interval, in milliseconds. */
  pollIntervalMs?: number;
  /** Deadline for a single HTTP request, in milliseconds. */
  timeoutMs?: number;
  /**
   * The project every request acts on, overriding the credential's own.
   * Defaults to `NEMAU_PROJECT_ID`.
   */
  project?: string;
  /**
   * Pins the Idempotency-Key of every asynchronous write this client sends.
   * Prefer {@link NemauClient.withIdempotencyKey}, which scopes it to one
   * logical write.
   */
  idempotencyKey?: string;
}

export interface RequestOptions {
  method: string;
  /** Path relative to /api/v1, for example `/compute/instances`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  /** Already-encoded body, for object uploads. */
  body?: BodyInit;
  contentType?: string;
  contentLength?: number;
  signal?: AbortSignal;
  /**
   * Idempotency-Key for this write. `submit()` generates one when absent; a
   * request that carries one may be retried after a 429, 503 or lost response.
   */
  idempotencyKey?: string;
  /** Return the raw Response instead of decoding JSON. */
  raw?: boolean;
}

/**
 * Client for the Nemau Cloud public API.
 *
 * Writes are asynchronous: a create, delete or action answers 202 with a
 * `TaskRef`, and the platform does the work in the background. `waitForTask`
 * waits until that task reaches a terminal state.
 *
 * The organization comes from the credential. The project comes from the
 * `project` option when set, and from the credential otherwise.
 */
export class NemauClient {
  readonly baseUrl: string;
  readonly pollIntervalMs: number;
  /** Selected project, empty when the credential's own scope applies. */
  readonly project: string;

  readonly compute: ComputeService;
  readonly network: NetworkService;
  readonly loadBalancer: LoadBalancerService;
  readonly databases: DatabaseService;
  readonly instanceGroups: InstanceGroupService;
  readonly storage: StorageService;
  readonly kubernetes: KubernetesService;
  readonly dns: DNSService;
  readonly metering: MeteringService;
  readonly regions: RegionsService;
  readonly tasks: TasksService;
  readonly projects: ProjectsService;
  readonly quotas: QuotasService;
  readonly iam: IamService;

  readonly #credential: Credential | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #idempotencyKey: string | undefined;

  constructor(options: ClientOptions = {}) {
    const env = globalThis.process?.env ?? {};
    const raw = options.baseUrl ?? env[ENV_API_URL]?.trim() ?? DEFAULT_BASE_URL;
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.host) {
      throw new Error(`nemau: baseUrl "${raw}" must be absolute`);
    }
    this.baseUrl = raw.replace(/\/+$/, "");

    this.#credential = options.credential ?? credentialFromEnv(env);
    // Bound to globalThis: a detached fetch throws "Illegal invocation" in a
    // browser, and the SDK must not depend on the caller's context.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#userAgent = options.userAgent
      ? `${options.userAgent} nemau-sdk-js/${VERSION}`
      : `nemau-sdk-js/${VERSION}`;
    this.#retry = options.retry ?? DEFAULT_RETRY;
    this.project = (options.project ?? env[ENV_PROJECT] ?? "").trim();
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    if (options.idempotencyKey !== undefined) {
      this.#idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
    }

    this.compute = new ComputeService(this);
    this.network = new NetworkService(this);
    this.loadBalancer = new LoadBalancerService(this);
    this.databases = new DatabaseService(this);
    this.instanceGroups = new InstanceGroupService(this);
    this.storage = new StorageService(this);
    this.kubernetes = new KubernetesService(this);
    this.dns = new DNSService(this);
    this.metering = new MeteringService(this);
    this.regions = new RegionsService(this);
    this.tasks = new TasksService(this);
    this.projects = new ProjectsService(this);
    this.quotas = new QuotasService(this);
    this.iam = new IamService(this);
  }

  /**
   * Returns a client aimed at another project.
   *
   * The original client is not modified. A client can be shared between
   * concurrent callers, and changing its project in place would affect calls
   * already in flight.
   *
   * A service account pinned to a project cannot leave it; the API answers 403.
   */
  forProject(project: string): NemauClient {
    return new NemauClient({
      baseUrl: this.baseUrl,
      project,
      pollIntervalMs: this.pollIntervalMs,
      ...(this.#credential ? { credential: this.#credential } : {}),
      fetch: this.#fetch,
      retry: this.#retry,
      timeoutMs: this.#timeoutMs,
      userAgent: this.#userAgent.replace(new RegExp(`\\s*nemau-sdk-js/${VERSION}$`), ""),
    });
  }

  /**
   * Returns a client whose asynchronous writes carry `key` as their
   * Idempotency-Key, instead of a generated one.
   *
   * Use it to make a logical write safe across process restarts: derive the key
   * from your own operation id, and a repeat answers with the original task
   * (`TaskRef.replayed` is true) instead of doing the work twice. Reusing a key
   * for a write with different parameters is refused with a 422
   * (`isIdempotencyKeyMismatch`), so build one client per write.
   *
   * A key is 1 to 128 characters of `A-Z a-z 0-9 . _ : -`; anything else throws
   * before a request is sent. The server keeps a key for 24 hours.
   */
  withIdempotencyKey(key: string): NemauClient {
    return new NemauClient({
      baseUrl: this.baseUrl,
      project: this.project,
      pollIntervalMs: this.pollIntervalMs,
      ...(this.#credential ? { credential: this.#credential } : {}),
      fetch: this.#fetch,
      retry: this.#retry,
      timeoutMs: this.#timeoutMs,
      userAgent: this.#userAgent.replace(new RegExp(`\\s*nemau-sdk-js/${VERSION}$`), ""),
      idempotencyKey: key,
    });
  }

  /** Redacted description of the credential, for a `whoami`. */
  describeCredential(): string {
    return this.#credential?.describe() ?? "none";
  }

  /** Performs a request and decodes the JSON response. */
  async request<T>(options: RequestOptions): Promise<T> {
    const response = await this.#send(options);
    if (options.raw) return response as unknown as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Performs a request and returns the raw Response (downloads). */
  async requestRaw(options: RequestOptions): Promise<Response> {
    return this.#send(options);
  }

  /**
   * Performs a write and decodes the 202 envelope.
   *
   * Every call carries an Idempotency-Key: the caller's (see
   * {@link withIdempotencyKey}) or a fresh random one. The same key is sent on
   * each retry of the call, so a 202 whose response was lost, or a retry after
   * a 429 or 503, cannot start the work twice. A replay answers with the
   * original task and `replayed: true`.
   *
   * A response without a task id throws, since there would be no task to wait
   * for.
   */
  async submit(options: RequestOptions): Promise<TaskRef> {
    const key = options.idempotencyKey ?? this.#idempotencyKey ?? (await newIdempotencyKey());
    const response = await this.#send({ ...options, idempotencyKey: validateIdempotencyKey(key) });
    const ref = (response.status === 204 ? undefined : await response.json()) as TaskRef | undefined;
    if (!ref?.task_id) {
      throw new Error(`nemau: ${options.method} ${options.path} returned no task id`);
    }
    if (response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === "true") ref.replayed = true;
    return ref;
  }

  async #send(options: RequestOptions): Promise<Response> {
    // An already-encoded body cannot be replayed: one attempt only.
    const attempts = options.body !== undefined ? 1 : Math.max(1, this.#retry.maxAttempts);
    const url = this.#url(options);
    // HTTP does not make PATCH idempotent in general, since a PATCH can express
    // a delta. On this API a PATCH body sets fields to new values, so applying
    // it twice gives the same result as applying it once.
    // A write carrying an Idempotency-Key is safe to retry as well: the server
    // answers a repeat with the original task.
    const idempotent =
      ["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(options.method) || options.idempotencyKey !== undefined;
    const maxRetryAfter = this.#retry.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    let retryAfterMs = 0;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        await sleep(Math.max(backoff(this.#retry, attempt - 1), retryAfterMs), options.signal);
      }
      retryAfterMs = 0;

      const headers = new Headers({ Accept: "application/json", "User-Agent": this.#userAgent });
      let body: BodyInit | undefined;
      if (options.body !== undefined) {
        body = options.body;
        headers.set("Content-Type", options.contentType ?? "application/octet-stream");
        if (options.contentLength !== undefined) {
          headers.set("Content-Length", String(options.contentLength));
        }
      } else if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers.set("Content-Type", "application/json");
      }
      if (options.idempotencyKey !== undefined) headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey);
      if (this.project) headers.set(PROJECT_SCOPE_HEADER, this.project);
      this.#credential?.apply(headers);

      const signal = this.#signal(options.signal);
      let response: Response;
      try {
        const init: RequestInit = { method: options.method, headers, signal };
        if (body !== undefined) {
          init.body = body;
          // Node requires duplex for a streamed body; harmless otherwise.
          (init as RequestInit & { duplex?: string }).duplex = "half";
        }
        response = await this.#fetch(url, init);
      } catch (error) {
        lastError = error;
        // A POST whose response was lost may have created the resource, so it
        // is never replayed.
        if (idempotent && attempt < attempts && !isAbort(error)) continue;
        throw error;
      }

      if (response.ok) return response;

      const apiError = await errorFromResponse(response, options.method, new URL(url).pathname);
      if (!idempotent || !shouldRetry(apiError) || attempt === attempts) throw apiError;
      // Honour Retry-After up to maxRetryAfter. A longer delay is thrown to the
      // caller instead of waited out.
      if (apiError.retryAfterMs > maxRetryAfter) throw apiError;
      retryAfterMs = apiError.retryAfterMs;
      lastError = apiError;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #url(options: RequestOptions): string {
    const url = new URL(this.baseUrl + API_PREFIX + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Combines the caller's signal with the client deadline. */
  #signal(caller?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }

  /**
   * Polls a task until it reaches a terminal state.
   *
   * Returns the successful task, and throws a `NemauTaskFailedError` carrying
   * the task on failure or cancellation.
   */
  async waitForTask(taskId: string, signal?: AbortSignal): Promise<Task> {
    if (!taskId) throw new Error("nemau: waitForTask called without a task id");
    for (;;) {
      let task: Task;
      try {
        task = await this.tasks.get(taskId, signal);
      } catch (error) {
        // Right after the 202 the task may not be readable yet: treat a 404
        // as "not yet" and keep polling.
        if (error instanceof NemauApiError && error.notFound) {
          await sleep(this.pollIntervalMs, signal);
          continue;
        }
        throw error;
      }
      if (isTerminal(task.status)) {
        if (task.status !== "completed") throw new NemauTaskFailedError(task);
        return task;
      }
      await sleep(this.pollIntervalMs, signal);
    }
  }

  /** `waitForTask` for the reference a write returns. */
  async waitFor(ref: TaskRef, signal?: AbortSignal): Promise<Task> {
    return this.waitForTask(ref.task_id, signal);
  }

  /**
   * Runs a write to completion and returns the id of the resource it created.
   *
   * The id comes from the task's `resourceId` when it is set, otherwise from
   * the first of the given `result` keys that holds a non-empty string.
   */
  async waitForResourceId(ref: TaskRef, ...keys: string[]): Promise<{ id: string; task: Task }> {
    const task = await this.waitFor(ref);
    if (task.resourceId) return { id: task.resourceId, task };
    for (const key of keys) {
      const value = task.result?.[key];
      if (typeof value === "string" && value) return { id: value, task };
    }
    throw new Error(
      `nemau: task ${task.id} completed without a resource id (looked for ${keys.join(", ")})`,
    );
  }
}

/**
 * Whether a refusal is worth another attempt. 429 and 503 mean the platform is
 * shedding load, and they carry `Retry-After`; other 5xx errors are treated as
 * transient. A 429 with another code, such as a credential cap, will not
 * succeed on retry.
 */
function shouldRetry(error: NemauApiError): boolean {
  if (error.statusCode === 429) return error.code === "" || error.code === ERROR_CODE_RATE_LIMITED;
  if (error.statusCode === 503) return error.code === "" || error.code === ERROR_CODE_UNAVAILABLE;
  return error.retryable;
}

function validateIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new Error("nemau: an Idempotency-Key is 1 to 128 characters of A-Z a-z 0-9 . _ : -");
  }
  return key;
}

/** A random UUID (122 bits) from the runtime's CSPRNG. */
async function newIdempotencyKey(): Promise<string> {
  let webcrypto: Crypto | undefined = globalThis.crypto;
  if (!webcrypto?.randomUUID) {
    // Node 18 has no global `crypto`. The specifier is computed so that a
    // browser bundler does not try to resolve it.
    const specifier = "node:crypto";
    webcrypto = ((await import(specifier)) as { webcrypto: Crypto }).webcrypto;
  }
  return webcrypto.randomUUID();
}

export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Exponential backoff with full jitter, so that many clients failing at the
 * same moment do not retry in step. The jitter is not security-sensitive, so
 * Math.random is enough.
 */
function backoff(policy: RetryPolicy, n: number): number {
  const base = policy.baseDelayMs > 0 ? policy.baseDelayMs : 300;
  const max = policy.maxDelayMs > 0 ? policy.maxDelayMs : 5000;
  return Math.random() * Math.min(base * 2 ** (n - 1), max);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
