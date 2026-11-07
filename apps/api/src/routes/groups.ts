import { operationsRouter } from "../operations/define";
import { groupOperations } from "../operations/groups";

export const groupsRouter = operationsRouter("/api/workspaces", groupOperations);
