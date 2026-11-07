import { operationsRouter } from "../operations/define";
import { projectActivityOperations } from "../operations/project-activity";

export const projectActivityRouter = operationsRouter("/api/projects", projectActivityOperations);
