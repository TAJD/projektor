import { toMcpTool } from "../operations/define";
import { issueLinkOperations } from "../operations/issue-links";

export const issueLinksTools = issueLinkOperations.map(toMcpTool);
