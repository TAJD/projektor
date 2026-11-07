import { toMcpTool } from "../operations/define";
import { feedbackOperations } from "../operations/feedback";

export const feedbackTools = feedbackOperations.map(toMcpTool);
