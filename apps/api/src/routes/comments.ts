import { commentOperations } from "../operations/comments";
import { operationsRouter } from "../operations/define";

export const commentsRouter = operationsRouter("/api/issues", commentOperations);
