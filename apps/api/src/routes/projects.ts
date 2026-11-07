import { operationsRouter } from "../operations/define";
import { projectOperations } from "../operations/projects";

const [list, ...rest] = projectOperations;

export const projectsRouter = operationsRouter("/api/projects", rest);
export const workspaceProjectsRouter = operationsRouter("/api/workspaces", [list]);
