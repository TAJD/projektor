import { toMcpTool } from "../operations/define";
import { workspaceOperations } from "../operations/workspaces";

export const workspacesTools = workspaceOperations.map(toMcpTool);
