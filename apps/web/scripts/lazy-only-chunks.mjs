// Which built chunks are reachable *only* through a dynamic import.
//
// PROJ-431 keeps the heavy on-demand code (mermaid and its diagram/layout deps, CodeMirror)
// out of the service worker's install-time precache. That used to be a list of a dozen
// filename globs — '**/mermaid*.js', '**/dagre-*.js' and so on — which worked only because
// the bundler named each lazy chunk after the module it came from. Astro 7 builds with
// rolldown, which names shared chunks 'chunk-<id>' instead, so every pattern silently
// stopped matching and 1.2 MiB of mermaid came back into the precache (PROJ-302).
//
// Deriving it from the module graph instead has nothing to maintain and cannot rot the next
// time chunk naming changes. It is also more accurate than the old list could be: `marked`
// sits inside mermaid's dependency tree but is imported eagerly by the issue and wiki views,
// and a name-based rule cannot tell those two cases apart.

/**
 * @param {Record<string, {type: string, fileName: string, isEntry?: boolean,
 *   isDynamicEntry?: boolean, imports?: string[]}>} bundle
 * @returns {Set<string>} fileNames of chunks not statically reachable from any entry
 */
export function lazyOnlyChunkNames(bundle) {
	const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
	const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));

	const eager = new Set();
	const queue = chunks
		.filter((chunk) => chunk.isEntry && !chunk.isDynamicEntry)
		.map((chunk) => chunk.fileName);

	while (queue.length > 0) {
		const fileName = queue.pop();
		if (eager.has(fileName)) continue;
		eager.add(fileName);
		// Static imports only — `dynamicImports` is precisely the boundary being looked for,
		// so it is deliberately not followed.
		for (const imported of byFileName.get(fileName)?.imports ?? []) queue.push(imported);
	}

	return new Set(chunks.filter((chunk) => !eager.has(chunk.fileName)).map((c) => c.fileName));
}
