import { READ_OPEN_WORLD } from "../mcp/annotations";
import { GetLinkPreviewSchema } from "../schemas/link-previews";
import { getLinkPreview } from "../services/link-previews";
import { defineOperation } from "./define";

export const linkPreviewOperations = [
	defineOperation({
		id: "get_link_preview",
		method: "GET",
		path: "/api/link-preview",
		domain: "link-previews",
		tier: "read",
		annotations: READ_OPEN_WORLD,
		keywords: ["url", "opengraph", "unfurl", "link card", "metadata", "title"],
		summary:
			"Preview a link: title, description, image and site name. `url` is either an absolute " +
			"http(s) URL (its OpenGraph / title-tag metadata is fetched and cached for 24h) or an app " +
			"path to an issue or wiki page in this workspace (e.g. /projects/PROJ/issues/42 or " +
			"/wiki/my-page), which also returns the issue's ref, status, type, priority and assignee (or, for a wiki link with a #fragment, the heading it points at). `title: null` means the " +
			"page had nothing to preview. Private, loopback and non-http(s) URLs are refused.",
		input: GetLinkPreviewSchema,
		run: (ctx, input) => getLinkPreview(ctx, input),
	}),
];
