import { toMcpTool } from "../operations/define";
import { projectActivityOperations } from "../operations/project-activity";

export const projectActivityTools = projectActivityOperations.map(toMcpTool);
