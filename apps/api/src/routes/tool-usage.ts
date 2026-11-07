import { operationsRouter } from "../operations/define";
import { toolUsageOperations } from "../operations/tool-usage";

export const toolUsageRouter = operationsRouter("/api/tool-usage", toolUsageOperations);
