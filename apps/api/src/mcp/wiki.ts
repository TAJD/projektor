import { toMcpTool } from "../operations/define";
import { wikiOperations } from "../operations/wiki";

export const wikiTools = wikiOperations.map(toMcpTool);
