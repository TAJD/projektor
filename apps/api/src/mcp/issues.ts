import { toMcpTool } from "../operations/define";
import { issueOperations } from "../operations/issues";

export const issuesTools = issueOperations.map(toMcpTool);
