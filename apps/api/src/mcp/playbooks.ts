import { toMcpTool } from "../operations/define";
import { playbookOperations } from "../operations/playbooks";

export const playbooksTools = playbookOperations.map(toMcpTool);
