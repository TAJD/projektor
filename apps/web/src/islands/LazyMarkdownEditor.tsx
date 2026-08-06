import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Props } from "./MarkdownEditor";

// PROJ-431: MarkdownEditor pulls in CodeMirror — 486 KiB raw / 168 KiB gzip, 76% of
// the JS on /issues/view and /wiki. As a static import every *reader* of an issue paid
// for it, though it only renders after tapping Edit. Loading it on demand takes those
// pages from 221 KiB to ~53 KiB gzip.
//
// Deliberately a plain dynamic import rather than preact/compat's lazy + Suspense.
// Importing preact/compat anywhere in an island's graph switches Preact to React's
// event semantics for that whole island — which silently broke native <select>
// onChange handling in IssueList (CreateIssueModal is one of the three call sites).
// Not worth a global behaviour change to save a few lines here.

// Shown while the chunk is in flight. Deliberately a working textarea rather than a
// spinner: on a slow mobile connection the chunk can take seconds, and the whole point
// of tapping Edit is to type. Same controlled contract as the real editor, so whatever
// is typed here is already in `value` when CodeMirror mounts and adopts it.
function EditorFallback({ value, onChange, minHeight }: Props) {
	return (
		<div class="flex flex-col border border-border rounded overflow-hidden bg-bg normal-case font-normal">
			<div
				class={
					"px-2 py-[2px] text-[0.7rem] text-text-muted bg-surface border-b border-border " +
					"shrink-0 uppercase tracking-[0.06em]"
				}
			>
				Loading editor…
			</div>
			<textarea
				value={value}
				onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
				aria-label="Markdown editor"
				style={{ minHeight }}
				class="w-full px-3 py-2 border-0 resize-y box-border bg-bg text-text-base font-mono
					text-base sm:text-sm leading-[1.6] focus:outline-none"
			/>
		</div>
	);
}

export default function LazyMarkdownEditor(props: Props) {
	const [Editor, setEditor] = useState<ComponentType<Props> | null>(null);

	useEffect(() => {
		let cancelled = false;
		import("./MarkdownEditor").then((m) => {
			// Wrapped in a thunk: a bare component would be read as a state updater.
			if (!cancelled) setEditor(() => m.default);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return Editor ? <Editor {...props} /> : <EditorFallback {...props} />;
}
