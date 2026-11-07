import { toMcpTool } from "../operations/define";
import { sprintOperations } from "../operations/sprints";

export const sprintsTools = sprintOperations.map(toMcpTool);
