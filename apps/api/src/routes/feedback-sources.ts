import { operationsRouter } from "../operations/define";
import { feedbackOperations } from "../operations/feedback";

const lookup = feedbackOperations.filter((op) => op.path.startsWith("/api/feedback-sources"));
const projectScoped = feedbackOperations.filter((op) => op.path.startsWith("/api/projects"));

export const feedbackSourceLookupRouter = operationsRouter("/api/feedback-sources", lookup);
export const feedbackProjectRouter = operationsRouter("/api/projects", projectScoped);
