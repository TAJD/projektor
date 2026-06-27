import type { MCPTool, Plugin } from "@projektor/types";

class PluginRegistry {
	private plugins = new Map<string, Plugin>();
	// workspaceId -> Set of pluginIds
	private workspacePlugins = new Map<string, Set<string>>();

	register(plugin: Plugin) {
		this.plugins.set(plugin.id, plugin);
	}

	enableForWorkspace(workspaceId: string, pluginId: string) {
		const set = this.workspacePlugins.get(workspaceId) ?? new Set();
		set.add(pluginId);
		this.workspacePlugins.set(workspaceId, set);
	}

	getToolsForWorkspace(workspaceId: string): MCPTool[] {
		const ids = this.workspacePlugins.get(workspaceId) ?? new Set();
		return [...ids].flatMap((id) => this.plugins.get(id)?.mcpTools ?? []);
	}

	getAll(): Plugin[] {
		return [...this.plugins.values()];
	}
}

export const pluginRegistry = new PluginRegistry();
