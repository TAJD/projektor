import type { MCPTool } from "@projektor/types";
import { getLinkPreview } from "../services/link-previews";
import { READ_OPEN_WORLD } from "./annotations";

export const linkPreviewsTools: MCPTool[] = [
	{
		name: "get_link_preview",
		description:
			"Preview a link: title, description, image and site name. `url` is either an absolute " +
			"http(s) URL (its OpenGraph / title-tag metadata is fetched and cached for 24h) or an app " +
			"path to an issue or wiki page in this workspace (e.g. /projects/PROJ/issues/42 or " +
			"/wiki/my-page), which also returns the issue's ref and status. `title: null` means the " +
			"page had nothing to preview. Private, loopback and non-http(s) URLs are refused.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					maxLength: 2048,
					description: "Absolute http(s) URL, or an app path starting with /",
				},
			},
			required: ["url"],
		},
		annotations: READ_OPEN_WORLD,
		async handler(input, ctx) {
			return getLinkPreview(ctx, input);
		},
	},
];
