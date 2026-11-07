import { agentOperations } from "../operations/agents";
import { toMcpTool } from "../operations/define";

export const agentsTools = agentOperations.map(toMcpTool);
