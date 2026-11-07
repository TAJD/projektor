import { toMcpTool } from "../operations/define";
import { flowMetricsOperations } from "../operations/flow-metrics";

export const flowMetricsTools = flowMetricsOperations.map(toMcpTool);
