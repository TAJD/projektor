import { operationsRouter } from "../operations/define";
import { issueLeaseOperations } from "../operations/issue-leases";

const [claim, release, list] = issueLeaseOperations;

export const issueLeasesRouter = operationsRouter("/api/issue-leases", [list]);
export const issueClaimsRouter = operationsRouter("/api/issues", [claim, release]);
