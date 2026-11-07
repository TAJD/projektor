import { toMcpTool } from "../operations/define";
import { taskTypeOperations } from "../operations/task-types";

export const taskTypesTools = taskTypeOperations.map(toMcpTool);
