import { commentOperations } from "../operations/comments";
import { toMcpTool } from "../operations/define";

export const commentsTools = commentOperations.map(toMcpTool);
