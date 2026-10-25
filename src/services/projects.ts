import { Service } from "./base.ts";
import { notFound } from "../errors.ts";
import type { Project, ProjectList } from "../types.ts";

/**
 * Lists the projects a credential can act on.
 *
 * Projects are created and deleted in the console, which requires a user
 * session, so this service only reads them.
 */
export class ProjectsService extends Service {
  async list(): Promise<ProjectList> {
    return this.client.request<ProjectList>({
      method: "GET",
      path: "/projects",
    });
  }

  /**
   * Returns a project by id, by name or by slug.
   *
   * An id match takes precedence over a name or slug match, so an id is never
   * ambiguous.
   */
  async get(idOrName: string): Promise<Project> {
    const { projects } = await this.list();
    const byId = projects.find((p) => p.id === idOrName);
    if (byId) return byId;
    const byName = projects.find((p) => p.name === idOrName || p.slug === idOrName);
    if (byName) return byName;
    throw notFound("project", idOrName, "/projects");
  }

  /**
   * Returns the project the credential resolves to, or `undefined` when it
   * resolves to none.
   */
  async current(): Promise<Project | undefined> {
    const { projects } = await this.list();
    return projects.find((p) => p.current);
  }
}

/** Is a project ready to receive resources? */
export function isProjectReady(project: Project): boolean {
  return project.is_active && project.provisioning_status === "active";
}
