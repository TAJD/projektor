import { toMcpTool } from "../operations/define";
import { taskStatusOperations } from "../operations/task-statuses";

export const taskStatusesTools = taskStatusOperations.map(toMcpTool);
