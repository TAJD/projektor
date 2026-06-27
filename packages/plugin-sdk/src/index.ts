import type { MCPTool, Migration, Plugin, PluginContext } from "@projektor/types";

export function definePlugin(plugin: Plugin): Plugin {
	return plugin;
}

export function defineMCPTool(tool: MCPTool): MCPTool {
	return tool;
}

export type { MCPTool, Migration, Plugin, PluginContext };
