import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "preact/hooks";
import { renderMarkdown } from "../utils/markdown";

interface Props {
	value: string;
	onChange: (value: string) => void;
	minHeight?: string;
}

const TOOLBAR_BUTTON_CLASS =
	"px-[7px] py-[2px] border border-transparent rounded-[3px] bg-transparent text-text-base " +
	"cursor-pointer text-[0.8rem] font-[inherit] leading-[1.5] hover:bg-border";

function mobileToggleClass(active: boolean): string {
	const base =
		"px-[10px] py-[2px] border rounded-[3px] text-[0.8rem] font-[inherit] cursor-pointer";
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
		const changes = [];
		for (let ln = fromLine.number; ln <= toLine.number; ln++) {
			changes.push({ from: state.doc.line(ln).from, insert: prefix });
		}
		const lineCount = toLine.number - fromLine.number + 1;
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
	minHeight: string
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	// The last doc content WE emitted via onChange. The "sync externally-driven value"
	// effect below compares the incoming `value` prop against this — not against the
	// live doc — so a same-tick echo of our own change (however delayed by Preact's
	// scheduling) is recognized as our own and skipped, instead of being re-dispatched
	// as if it were an external change and potentially clobbering keystrokes typed since
	// (PROJ-305: this race was making the editor appear to freeze mid-typing).
	const lastEmitted = useRef(value);

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
					if (update.docChanged) {
						const next = update.state.doc.toString();
						lastEmitted.current = next;
						onChange(next);
					}
				}),
				EditorView.theme({
					"&": { background: "var(--bg)", color: "var(--text)" },
					".cm-content": {
						fontFamily: "ui-monospace, 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
						fontSize: "0.875rem",
						padding: "0.5rem 0.75rem",
						minHeight,
						caretColor: "var(--text)",
					},
					".cm-line": { lineHeight: "1.6" },
					".cm-focused": { outline: "none" },
					".cm-cursor": { borderLeftColor: "var(--text)" },
				}),
				EditorView.lineWrapping,
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
		view.dispatch({
			changes: { from: 0, to: current.length, insert: value },
		});
	}, [value]);

	return { containerRef, viewRef };
}

function useMarkdownCommands(viewRef: { current: EditorView | null }) {
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

export default function MarkdownEditor({ value, onChange, minHeight = "240px" }: Props) {
	const [mobilePreview, setMobilePreview] = useState(false);
	const [preview, setPreview] = useState("");

	useEffect(() => {
		const timer = setTimeout(() => {
			setPreview(renderMarkdown(value));
		}, 200);
		return () => clearTimeout(timer);
	}, [value]);

	const { containerRef, viewRef } = useMarkdownEditorView(value, onChange, minHeight);
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
