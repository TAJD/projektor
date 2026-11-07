import { operationsRouter } from "../operations/define";
import { flowMetricsOperations } from "../operations/flow-metrics";

export const flowMetricsRouter = operationsRouter("/api/projects", flowMetricsOperations);
