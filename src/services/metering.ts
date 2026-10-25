import { Service } from "./base.ts";

/** Filter for a consumption read. Every field is optional. */
export interface UsageQuery {
  resourceType?: string;
  /** An RFC 3339 date, or a Date. */
  periodStart?: string | Date;
  periodEnd?: string | Date;
  page?: number;
  pageSize?: number;
}

/**
 * /metering: consumption and accrued cost.
 *
 * These responses do not follow a stable public schema, so the methods return
 * the decoded JSON unchanged. The organization always comes from the
 * credential.
 */
export class MeteringService extends Service {
  async usage(query: UsageQuery = {}): Promise<Record<string, unknown>> {
    return this.#get("/metering/usage", query);
  }

  async usageSummary(query: UsageQuery = {}): Promise<Record<string, unknown>> {
    return this.#get("/metering/usage/summary", query);
  }

  async costs(query: UsageQuery = {}): Promise<Record<string, unknown>> {
    return this.#get("/metering/costs", query);
  }

  async events(query: UsageQuery = {}): Promise<Record<string, unknown>> {
    return this.#get("/metering/events", query);
  }

  async #get(path: string, query: UsageQuery): Promise<Record<string, unknown>> {
    return this.client.request<Record<string, unknown>>({ method: "GET", path, query: toParams(query) });
  }
}

function toParams(query: UsageQuery): Record<string, string | number | undefined> {
  const params: Record<string, string | number | undefined> = {};
  if (query.resourceType) params["resource_type"] = query.resourceType;
  if (query.periodStart) params["period_start"] = isoDate(query.periodStart);
  if (query.periodEnd) params["period_end"] = isoDate(query.periodEnd);
  if (query.page && query.page > 0) params["page"] = query.page;
  if (query.pageSize && query.pageSize > 0) params["page_size"] = query.pageSize;
  return params;
}

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
