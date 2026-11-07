import { codeHeatmapOperations } from "../operations/code-heatmap";
import { toMcpTool } from "../operations/define";

export const codeHeatmapTools = codeHeatmapOperations.map(toMcpTool);
