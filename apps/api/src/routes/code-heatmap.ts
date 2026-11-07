import { codeHeatmapOperations } from "../operations/code-heatmap";
import { operationsRouter } from "../operations/define";

export const codeHeatmapRouter = operationsRouter("/api/projects", codeHeatmapOperations);
