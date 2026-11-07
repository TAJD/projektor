import { toMcpTool } from "../operations/define";
import { fileClaimOperations } from "../operations/file-claims";

export const fileClaimsTools = fileClaimOperations.map(toMcpTool);
