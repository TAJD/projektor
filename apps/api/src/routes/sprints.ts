import { operationsRouter } from "../operations/define";
import { sprintOperations } from "../operations/sprints";

export const sprintsRouter = operationsRouter("/api/sprints", sprintOperations);
