import { toMcpTool } from "../operations/define";
import { workflowOperations } from "../operations/workflow";

export const workflowTools = workflowOperations.map(toMcpTool);
