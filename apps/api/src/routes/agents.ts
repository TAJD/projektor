import { agentOperations } from "../operations/agents";
import { operationsRouter } from "../operations/define";

export const agentsRouter = operationsRouter("/api/agents", agentOperations);
