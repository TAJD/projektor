import { operationsRouter } from "../operations/define";
import { taskStatusOperations } from "../operations/task-statuses";

export const taskStatusesRouter = operationsRouter("/api/task-statuses", taskStatusOperations);
