import { z } from "zod";

// PROJ-1036: `url` is either an absolute http(s) URL (fetched for its OpenGraph/<title>
// metadata) or an app-relative path starting with "/" (an issue or wiki page URL in this
// workspace, resolved from our own data). The browser turns same-origin URLs into paths
// before asking, so an internal link never makes the Worker fetch itself.
export const GetLinkPreviewSchema = z
	.object({
		url: z.string().trim().min(1).max(2048),
	})
	.strict();
