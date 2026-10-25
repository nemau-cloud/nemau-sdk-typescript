/**
 * A credential accepted by the public API.
 *
 * The API accepts three kinds: an IAM access key, a service-account token and
 * a console session.
 */
export interface Credential {
  /** Sets the authentication headers on an outgoing request. */
  apply(headers: Headers): void;
  /** Redacted identity, for diagnostics. Never reveals the secret. */
  describe(): string;
}

/**
 * An IAM user's long-lived programmatic credential.
 *
 * Long-lived and not subject to CSRF checks, so it suits scripts and CI jobs.
 */
export class AccessKey implements Credential {
  readonly id: string;
  readonly #secret: string;

  constructor(id: string, secret: string) {
    this.id = id;
    this.#secret = secret;
  }

  apply(headers: Headers): void {
    headers.set("X-Access-Key-Id", this.id);
    headers.set("X-Access-Key-Secret", this.#secret);
  }

  describe(): string {
    return `access-key ${this.id}`;
  }
}

/**
 * A service-account token from `POST /api/v1/iam/service-accounts/token`.
 *
 * It expires after 15 minutes. This class carries a fixed string and never
 * refreshes it, so a long-running process must mint a new one itself.
 */
export class BearerToken implements Credential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  apply(headers: Headers): void {
    headers.set("Authorization", `Bearer ${this.#token}`);
  }

  describe(): string {
    return "service-account token";
  }
}

/**
 * A human console session. Writes are CSRF-protected, so this is read-only in
 * practice.
 */
export class SessionToken implements Credential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  apply(headers: Headers): void {
    headers.set("x-session-token", this.#token);
  }

  describe(): string {
    return "console session";
  }
}

export const ENV_ACCESS_KEY_ID = "NEMAU_ACCESS_KEY_ID";
export const ENV_ACCESS_KEY_SECRET = "NEMAU_ACCESS_KEY_SECRET";
export const ENV_TOKEN = "NEMAU_TOKEN";
export const ENV_API_URL = "NEMAU_API_URL";
export const ENV_PROJECT = "NEMAU_PROJECT_ID";

/**
 * Builds a credential from the environment, or returns `undefined`.
 *
 * The access-key pair takes precedence over `NEMAU_TOKEN`, so a stale token
 * left in a shell does not replace the long-lived key.
 */
export function credentialFromEnv(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): Credential | undefined {
  const id = env[ENV_ACCESS_KEY_ID]?.trim();
  const secret = env[ENV_ACCESS_KEY_SECRET]?.trim();
  if (id && secret) return new AccessKey(id, secret);

  const token = env[ENV_TOKEN]?.trim();
  if (token) return new BearerToken(token);

  return undefined;
}
