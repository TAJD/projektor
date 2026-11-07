import { agentMessageOperations } from "../operations/agent-messages";
import { operationsRouter } from "../operations/define";

export const agentMessagesRouter = operationsRouter("/api/agent-messages", agentMessageOperations);
