import { operationsRouter } from "../operations/define";
import { issueLinkOperations } from "../operations/issue-links";

export const issueLinksRouter = operationsRouter("/api/issues", issueLinkOperations);
