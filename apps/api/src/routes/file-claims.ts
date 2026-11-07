import { operationsRouter } from "../operations/define";
import { fileClaimOperations } from "../operations/file-claims";

export const fileClaimsRouter = operationsRouter("/api/file-claims", fileClaimOperations);
