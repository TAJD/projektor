import { toMcpTool } from "../operations/define";
import { toolUsageOperations } from "../operations/tool-usage";

export const toolUsageTools = toolUsageOperations.map(toMcpTool);
