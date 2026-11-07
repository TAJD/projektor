import { toMcpTool } from "../operations/define";
import { issueLeaseOperations } from "../operations/issue-leases";

export const issueLeasesTools = issueLeaseOperations.map(toMcpTool);
