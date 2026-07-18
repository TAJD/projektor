import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { GLOSSARY_TERMS, type GlossaryTermId } from "./glossary-definitions";

// PROJ-395: a toggletip explaining SDLC/PM jargon (Sprint, Epic, Groups, Tokens) inline
// next to nav labels, for users unfamiliar with this kind of tool. Same interaction
// pattern (and CSS classes) as MetricHelp.tsx (PROJ-335) — reused rather than duplicated
// since the toggletip visuals are identical, only the content source differs.
//
// PROJ-419: the Groups/Tokens triggers live inside the sidebar, which has
// `overflow-y: auto` (forcing overflow-x to `auto` too - CSS spec: one
// non-visible axis forces the other) - clipping a plain CSS `position:
// absolute` popover. A `position: fixed` popover alone isn't enough to escape
// it: on mobile the sidebar becomes an off-canvas drawer with a CSS
// `transform`, and a transformed ancestor becomes the containing block for
// its `position: fixed` descendants too, reintroducing the exact same
// clipping. Portalling the popover to `document.body` sidesteps both cases
// (no DOM ancestor to be clipped or transformed by), while the position is
// still computed from the trigger's rect, same as Select.tsx's dropdown.
const POPOVER_WIDTH = 256; // 16rem, matches .metric-help-popover's `width`
const POPOVER_MARGIN = 8;

export function GlossaryHelp({ id }: { id: GlossaryTermId }) {
	const term = GLOSSARY_TERMS[id];
	const [open, setOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
	const rootRef = useRef<HTMLSpanElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const popoverId = useId();

	function openPopover() {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) {
			const left = Math.max(
				POPOVER_MARGIN,
				Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN)
			);
			setPopoverPos({ top: rect.bottom + 4, left });
		}
		setOpen(true);
	}

	function isInside(node: Node) {
		return !!(rootRef.current?.contains(node) || popoverRef.current?.contains(node));
	}

	useEffect(() => {
		if (!open) return;
		function onPointerDown(e: MouseEvent) {
			if (!(e.target instanceof Node) || !isInside(e.target)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		function onScroll(e: Event) {
			if (e.target instanceof Node && isInside(e.target)) return;
			setOpen(false);
		}
		function onResize() {
			setOpen(false);
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [open]);

	return (
		<span class="metric-help" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				class="metric-help-trigger"
				aria-label={`About ${term.label}`}
				aria-expanded={open}
				aria-describedby={open ? popoverId : undefined}
				onClick={(e) => {
					e.preventDefault();
					if (open) setOpen(false);
					else openPopover();
				}}
			>
				<span aria-hidden="true">ⓘ</span>
			</button>
			{open &&
				popoverPos &&
				createPortal(
					<div
						id={popoverId}
						ref={popoverRef}
						role="dialog"
						aria-modal="false"
						aria-label={`${term.label} definition`}
						class="metric-help-popover"
						style={{ position: "fixed", top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
					>
						<p class="m-0 text-[0.8rem] text-text-base">{term.definition}</p>
					</div>,
					document.body
				)}
		</span>
	);
}
