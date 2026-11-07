import { agentMessageOperations } from "../operations/agent-messages";
import { toMcpTool } from "../operations/define";

export const agentMessagesTools = agentMessageOperations.map(toMcpTool);
