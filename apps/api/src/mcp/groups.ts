import { toMcpTool } from "../operations/define";
import { groupOperations } from "../operations/groups";

export const groupsTools = groupOperations.map(toMcpTool);
