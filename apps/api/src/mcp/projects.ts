import { toMcpTool } from "../operations/define";
import { projectOperations } from "../operations/projects";

export const projectsTools = projectOperations.map(toMcpTool);
