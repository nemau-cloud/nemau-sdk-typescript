import { Service } from "./base.ts";
import type { QuotaDimension, QuotaList, QuotaScope } from "../types.ts";

/** Reads the capacity limits a write is checked against. */
export class QuotasService extends Service {
  /**
   * Returns limits, settled usage and pending reservations for the project the
   * credential resolves to, and for the organization that owns it.
   */
  async get(): Promise<QuotaList> {
    return this.client.request<QuotaList>({
      method: "GET",
      path: "/quotas",
    });
  }
}

/** Headroom left in a dimension, never negative. */
export function quotaAvailable(dimension: QuotaDimension): number {
  return Math.max(0, dimension.limit - dimension.used - dimension.reserved);
}

/** One scope by name, `"project"` or `"tenant"`. */
export function quotaScope(quotas: QuotaList, scope: string): QuotaScope | undefined {
  return quotas.quotas.find((s) => s.scope === scope);
}

/**
 * The dimension that will refuse first: the one with the least headroom among
 * the scopes that report it. It does not always have the smallest limit.
 *
 * A write is admitted only when both the project and its organization have
 * room, so checking the project alone can miss an organization-level refusal.
 */
export function bindingQuota(quotas: QuotaList, name: string): QuotaDimension | undefined {
  let binding: QuotaDimension | undefined;
  for (const scope of quotas.quotas) {
    const dimension = scope.dimensions?.find((d) => d.name === name);
    if (!dimension) continue;
    if (!binding || quotaAvailable(dimension) < quotaAvailable(binding)) binding = dimension;
  }
  return binding;
}
