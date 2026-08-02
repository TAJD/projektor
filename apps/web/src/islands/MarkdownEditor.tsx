import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "preact/hooks";
import { renderMarkdown } from "../utils/markdown";

export interface Props {
	value: string;
	onChange: (value: string) => void;
	minHeight?: string;
	// PROJ-494: paste/drag-drop an image into the editor. Returning the URL to embed
	// inserts `![filename](url)` at the cursor/drop position; returning null (upload
	// failed, or the caller has no entity to attach to yet, e.g. the create-page form)
	// leaves the editor untouched. Undefined disables image interception entirely —
	// paste/drop of non-image content is never affected either way.
	onImageFile?: (file: File) => Promise<string | null>;
}

// Mirrors services/files.ts's INLINE_TYPES on the API side — the set of image types the
// API will actually serve inline (SVG is excluded there for script-execution risk, so
// pasting one falls through to a manual "Attach file" upload instead of auto-embedding).
export const PASTE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function imageFilesFromClipboard(data: DataTransfer | null): File[] {
	if (!data) return [];
	const files: File[] = [];
	for (const item of Array.from(data.items)) {
		if (item.kind === "file" && PASTE_IMAGE_TYPES.has(item.type)) {
			const file = item.getAsFile();
			if (file) files.push(file);
		}
	}
	return files;
}

function imageFilesFromDrop(data: DataTransfer | null): File[] {
	if (!data) return [];
	return Array.from(data.files).filter((f) => PASTE_IMAGE_TYPES.has(f.type));
}

// Uploads sequentially and inserts each `![name](url)` right after the previous one, so a
// multi-file paste/drop lands as consecutive image refs instead of racing to overlapping
// positions. A file whose upload fails (onImageFile resolves null) is silently skipped.
async function insertUploadedImages(
	view: EditorView,
	files: readonly File[],
	pos: number,
	onImageFile: (file: File) => Promise<string | null>
): Promise<void> {
	let insertAt = pos;
	for (const file of files) {
		const url = await onImageFile(file);
		if (!url) continue;
		const insert = `![${file.name}](${url})\n`;
		view.dispatch({
			changes: { from: insertAt, insert },
			selection: EditorSelection.cursor(insertAt + insert.length),
		});
		insertAt += insert.length;
	}
	view.focus();
}

// Sub-640px gets a 44px-square touch target (the toolbar was ~24px tall, well under
// the accessible minimum on a phone). Desktop keeps the original compact sizing.
const TOOLBAR_BUTTON_CLASS =
	"min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center " +
	"px-[7px] py-[2px] border border-transparent rounded-[3px] bg-transparent text-text-base " +
	"cursor-pointer text-[0.8rem] font-[inherit] leading-[1.5] hover:bg-border";

function mobileToggleClass(active: boolean): string {
	const base =
		"min-h-[44px] px-[14px] py-[2px] border rounded-[3px] text-[0.8rem] font-[inherit] cursor-pointer";
	const state = active
		? " bg-accent text-white border-accent"
		: " border-border bg-transparent text-text-base";
	return base + state;
}

function wrapSelection(view: EditorView, before: string, after: string): boolean {
	const tr = view.state.changeByRange((range) => {
		const selected = view.state.sliceDoc(range.from, range.to);
		return {
			changes: { from: range.from, to: range.to, insert: before + selected + after },
			range: EditorSelection.range(
				range.from + before.length,
				range.from + before.length + selected.length
			),
		};
	});
	view.dispatch(tr);
	view.focus();
	return true;
}

function prefixLines(view: EditorView, prefix: string): boolean {
	const { state } = view;
	const tr = state.changeByRange((range) => {
		const fromLine = state.doc.lineAt(range.from);
		const toLine = state.doc.lineAt(range.to);
		const lineCount = toLine.number - fromLine.number + 1;
		const changes = Array.from({ length: lineCount }, (_, i) => ({
			from: state.doc.line(fromLine.number + i).from,
			insert: prefix,
		}));
		return {
			changes,
			range: EditorSelection.range(
				range.from + prefix.length,
				range.to + lineCount * prefix.length
			),
		};
	});
	view.dispatch(tr);
	view.focus();
	return true;
}

interface EditorToolbarProps {
	onBold: () => void;
	onItalic: () => void;
	onHeading: (n: 1 | 2 | 3) => void;
	onLink: () => void;
	onCodeBlock: () => void;
	onBulletList: () => void;
	onNumberedList: () => void;
}

function EditorToolbar({
	onBold,
	onItalic,
	onHeading,
	onLink,
	onCodeBlock,
	onBulletList,
	onNumberedList,
}: EditorToolbarProps) {
	return (
		<div class="flex gap-[2px] px-[6px] py-1 bg-surface border-b border-border flex-wrap items-center">
			<button type="button" class={TOOLBAR_BUTTON_CLASS} onClick={onBold} title="Bold (Ctrl+B)">
				<strong>B</strong>
			</button>
			<button
				type="button"
				class={`${TOOLBAR_BUTTON_CLASS} italic`}
				onClick={onItalic}
				title="Italic (Ctrl+I)"
			>
				I
			</button>
			<div class="w-px bg-border mx-[3px] my-[2px] self-stretch min-h-[16px]" />
			<button
				type="button"
				class={TOOLBAR_BUTTON_CLASS}
				onClick={() => onHeading(1)}
				title="Heading 1"
			>
				H1
			</button>
			<button
				type="button"
				class={TOOLBAR_BUTTON_CLASS}
				onClick={() => onHeading(2)}
				title="Heading 2"
			>
				H2
			</button>
			<button
				type="button"
				class={TOOLBAR_BUTTON_CLASS}
				onClick={() => onHeading(3)}
				title="Heading 3"
			>
				H3
			</button>
			<div class="w-px bg-border mx-[3px] my-[2px] self-stretch min-h-[16px]" />
			<button type="button" class={TOOLBAR_BUTTON_CLASS} onClick={onLink} title="Link">
				Link
			</button>
			<button type="button" class={TOOLBAR_BUTTON_CLASS} onClick={onCodeBlock} title="Code block">
				Code
			</button>
			<button type="button" class={TOOLBAR_BUTTON_CLASS} onClick={onBulletList} title="Bullet list">
				• List
			</button>
			<button
				type="button"
				class={TOOLBAR_BUTTON_CLASS}
				onClick={onNumberedList}
				title="Numbered list"
			>
				1. List
			</button>
		</div>
	);
}

function PreviewPane({ preview, mobilePreview }: { preview: string; mobilePreview: boolean }) {
	return (
		<div
			class={
				mobilePreview
					? "flex-1 flex flex-col min-w-0"
					: "flex-1 flex flex-col border-l border-border min-w-0 max-sm:hidden"
			}
		>
			<div
				class={
					"px-2 py-[2px] text-[0.7rem] text-text-muted bg-surface border-b border-border " +
					"shrink-0 uppercase tracking-[0.06em]"
				}
			>
				Preview
			</div>
			{preview ? (
				<div
					class="flex-1 overflow-auto px-4 py-3 text-sm leading-[1.7] text-text-base prose prose-sm max-w-none"
					dangerouslySetInnerHTML={{ __html: preview }}
				/>
			) : (
				<div class="flex-1 overflow-auto px-4 py-3 text-sm leading-[1.7] text-text-muted italic">
					Nothing to preview.
				</div>
			)}
		</div>
	);
}

function useMarkdownEditorView(
	value: string,
	onChange: (value: string) => void,
	minHeight: string,
	onImageFile: ((file: File) => Promise<string | null>) | undefined
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	// The domEventHandlers extension below is installed once, in the mount effect — read
	// through a ref (updated every render, not just on mount) so it always calls whichever
	// onImageFile the latest render passed, rather than closing over the first one forever.
	const onImageFileRef = useRef(onImageFile);
	onImageFileRef.current = onImageFile;
	// The last doc content WE emitted via onChange. The "sync externally-driven value"
	// effect below compares the incoming `value` prop against this — not against the
	// live doc — so a same-tick echo of our own change (however delayed by Preact's
	// scheduling) is recognized as our own and skipped, instead of being re-dispatched
	// as if it were an external change and potentially clobbering keystrokes typed since
	// (PROJ-305: this race was making the editor appear to freeze mid-typing).
	const lastEmitted = useRef(value);
	// True while the sync effect below is applying an external `value` change via
	// view.dispatch(). CM's own dispatch->updateListener call is synchronous, so
	// without this flag that dispatch re-enters onChange, which re-renders, whose
	// effect dispatches again — a synchronous ping-pong that locks the tab on every
	// keystroke (PROJ-312; the lastEmitted equality check alone doesn't catch this
	// because the echoed update can race ahead of it).
	const applyingExternal = useRef(false);

	useEffect(() => {
		if (!containerRef.current) return;

		const customKeymap = [
			{ key: "Mod-b", run: (v: EditorView) => wrapSelection(v, "**", "**") },
			{ key: "Mod-i", run: (v: EditorView) => wrapSelection(v, "_", "_") },
		];

		const state = EditorState.create({
			doc: value,
			extensions: [
				history(),
				markdown(),
				keymap.of([...customKeymap, ...historyKeymap, ...defaultKeymap]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !applyingExternal.current) {
						const next = update.state.doc.toString();
						lastEmitted.current = next;
						onChange(next);
					}
				}),
				EditorView.theme({
					"&": { background: "var(--bg)", color: "var(--text)" },
					".cm-content": {
						fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
						// 16px on phones. Below 16px, iOS Safari zooms the viewport when a
						// field takes focus, and the viewport meta sets no maximum-scale —
						// so tapping into the editor used to jump the whole page.
						fontSize: "1rem",
						padding: "0.5rem 0.75rem",
						minHeight,
						caretColor: "var(--text)",
					},
					"@media (min-width: 640px)": {
						".cm-content": { fontSize: "0.875rem" },
					},
					".cm-line": { lineHeight: "1.6" },
					".cm-focused": { outline: "none" },
					".cm-cursor": { borderLeftColor: "var(--text)" },
				}),
				EditorView.lineWrapping,
				EditorView.domEventHandlers({
					paste(event, view) {
						const handler = onImageFileRef.current;
						const files = imageFilesFromClipboard(event.clipboardData);
						if (!handler || files.length === 0) return false;
						event.preventDefault();
						insertUploadedImages(view, files, view.state.selection.main.from, handler);
						return true;
					},
					drop(event, view) {
						const handler = onImageFileRef.current;
						const files = imageFilesFromDrop(event.dataTransfer);
						if (!handler || files.length === 0) return false;
						event.preventDefault();
						const pos =
							view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
							view.state.selection.main.from;
						insertUploadedImages(view, files, pos, handler);
						return true;
					},
				}),
			],
		});

		const view = new EditorView({ state, parent: containerRef.current });
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Sync externally-driven value changes (e.g. switching issues). If `value` matches
	// what we last emitted, this render is just our own change echoing back through
	// props — nothing to do, regardless of whether the doc has since moved on further.
	useEffect(() => {
		if (value === lastEmitted.current) return;
		lastEmitted.current = value;
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		applyingExternal.current = true;
		try {
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
			});
		} finally {
			applyingExternal.current = false;
		}
	}, [value]);

	return { containerRef, viewRef };
}

function useMarkdownCommands(viewRef: Readonly<{ current: EditorView | null }>) {
	function bold() {
		if (viewRef.current) wrapSelection(viewRef.current, "**", "**");
	}
	function italic() {
		if (viewRef.current) wrapSelection(viewRef.current, "_", "_");
	}
	function heading(n: 1 | 2 | 3) {
		if (viewRef.current) prefixLines(viewRef.current, `${"#".repeat(n)} `);
	}
	function link() {
		const view = viewRef.current;
		if (!view) return;
		const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
		if (sel) {
			wrapSelection(view, "[", "](url)");
		} else {
			// No selection — insert template and select the placeholder so user can type immediately
			const pos = view.state.selection.main.from;
			const insert = "[link text](url)";
			view.dispatch({
				changes: { from: pos, insert },
				selection: EditorSelection.range(pos + 1, pos + 10),
			});
			view.focus();
		}
	}
	function codeBlock() {
		if (viewRef.current) wrapSelection(viewRef.current, "```\n", "\n```");
	}
	function bulletList() {
		if (viewRef.current) prefixLines(viewRef.current, "- ");
	}
	function numberedList() {
		if (viewRef.current) prefixLines(viewRef.current, "1. ");
	}

	return { bold, italic, heading, link, codeBlock, bulletList, numberedList };
}

export default function MarkdownEditor({
	value,
	onChange,
	minHeight = "240px",
	onImageFile,
}: Props) {
	const [mobilePreview, setMobilePreview] = useState(false);
	const [preview, setPreview] = useState("");

	useEffect(() => {
		const timer = setTimeout(() => {
			setPreview(renderMarkdown(value));
		}, 200);
		return () => clearTimeout(timer);
	}, [value]);

	const { containerRef, viewRef } = useMarkdownEditorView(value, onChange, minHeight, onImageFile);
	const { bold, italic, heading, link, codeBlock, bulletList, numberedList } =
		useMarkdownCommands(viewRef);

	return (
		<div class="flex flex-col border border-border rounded overflow-hidden bg-bg normal-case">
			<EditorToolbar
				onBold={bold}
				onItalic={italic}
				onHeading={heading}
				onLink={link}
				onCodeBlock={codeBlock}
				onBulletList={bulletList}
				onNumberedList={numberedList}
			/>

			{/* Mobile pane toggle — hidden on ≥640px */}
			<div class="hidden max-sm:flex gap-1 px-[6px] py-1 border-b border-border bg-surface">
				<button
					type="button"
					class={mobileToggleClass(!mobilePreview)}
					onClick={() => setMobilePreview(false)}
				>
					Edit
				</button>
				<button
					type="button"
					class={mobileToggleClass(mobilePreview)}
					onClick={() => setMobilePreview(true)}
				>
					Preview
				</button>
			</div>

			<div class="flex flex-1" style={{ minHeight }}>
				<div
					class={`flex-1 min-w-0 flex flex-col${mobilePreview ? " max-sm:hidden" : ""}`}
					ref={containerRef}
				/>
				<PreviewPane preview={preview} mobilePreview={mobilePreview} />
			</div>
		</div>
	);
}
