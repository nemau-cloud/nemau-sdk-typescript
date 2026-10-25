import type { NemauClient } from "../client.ts";
import type { TaskRef } from "../types.ts";

/**
 * The fields a PATCH changes.
 *
 * Every field is optional, and an absent field is left unchanged, so a client
 * holding a stale copy cannot overwrite a value another client has just
 * written.
 *
 * To clear a field, send it empty: `{ description: "" }` clears the
 * description, while leaving the key out changes nothing.
 */
export interface ResourceUpdate {
  name?: string;
  description?: string;

  /** Load balancer family. */
  lb_algorithm?: string;
  connection_limit?: number;
  weight?: number;
  delay?: number;
  timeout?: number;
  max_retries?: number;
  expected_codes?: string;
  /** Points a TERMINATED_HTTPS listener at another imported certificate. */
  tls_certificate_ref?: string;

  /** Object containers. */
  versioning?: boolean;
  retention_days?: number;

  /** DNS zones. */
  email?: string;
  ttl?: number;
}

/**
 * Refuses an update that would change nothing before it costs a round trip.
 * The API answers 400 for the same case; failing here names the caller's own
 * method instead of a path.
 */
export function requireFields(update: object, method: string): void {
  if (Object.keys(update).length === 0) {
    throw new Error(`nemau: ${method} was given no field to change`);
  }
}

/** Issues the PATCH behind every update method. */
export function patch<T extends object>(
  client: NemauClient,
  method: string,
  path: string,
  update: T,
  query?: Record<string, string | number | undefined>,
): Promise<TaskRef> {
  requireFields(update, method);
  // exactOptionalPropertyTypes: an absent query and a query set to undefined
  // are different types, so the key is omitted rather than passed empty.
  return client.submit(query ? { method: "PATCH", path, query, json: update }
                             : { method: "PATCH", path, json: update });
}
