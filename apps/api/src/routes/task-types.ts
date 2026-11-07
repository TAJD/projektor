import { operationsRouter } from "../operations/define";
import { taskTypeOperations } from "../operations/task-types";

export const taskTypesRouter = operationsRouter("/api/task-types", taskTypeOperations);
