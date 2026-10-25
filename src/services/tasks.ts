import { Service } from "./base.ts";
import type { Task } from "../types.ts";

/**
 * Reads background tasks.
 *
 * The API offers two reads: one task by id, and the tasks recorded against one
 * resource. It has no endpoint to list every task of an organization or to
 * cancel a task.
 */
export class TasksService extends Service {
  async get(id: string, signal?: AbortSignal): Promise<Task> {
    return this.client.request<Task>({
      method: "GET",
      path: `/tasks/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Tasks recorded against one resource. `resourceId` is required. */
  async listForResource(resourceId: string): Promise<Task[]> {
    const out = await this.client.request<{ tasks: Task[] }>({
      method: "GET",
      path: "/tasks",
      query: { resource_id: resourceId },
    });
    return out.tasks ?? [];
  }
}
