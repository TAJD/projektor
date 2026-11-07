import { operationsRouter } from "../operations/define";
import { workflowOperations } from "../operations/workflow";

export const workflowRouter = operationsRouter("/api/workflow", workflowOperations);
