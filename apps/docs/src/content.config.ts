import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// cofferdam-ignore: Design.OrphanExport: Astro content-collections convention, loaded by file path
export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
