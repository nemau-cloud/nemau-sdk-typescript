import { Service } from "./base.ts";
import type { Region, RegionStatus } from "../types.ts";

/**
 * /regions.
 *
 * The only endpoints that need no authentication. A client without a
 * credential can list regions, for example to check that the API is reachable
 * before asking for credentials.
 */
export class RegionsService extends Service {
  async list(): Promise<Region[]> {
    return this.client.request<Region[]>({ method: "GET", path: "/regions" });
  }

  /**
   * An unhealthy region answers 503, which throws a `NemauApiError` instead of
   * returning a `RegionStatus`.
   */
  async status(slug: string): Promise<RegionStatus> {
    return this.client.request<RegionStatus>({
      method: "GET",
      path: `/regions/${encodeURIComponent(slug)}/status`,
    });
  }
}
