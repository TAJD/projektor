import { toMcpTool } from "../operations/define";
import { linkPreviewOperations } from "../operations/link-previews";

export const linkPreviewsTools = linkPreviewOperations.map(toMcpTool);
