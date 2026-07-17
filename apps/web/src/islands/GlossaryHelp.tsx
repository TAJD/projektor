import { useEffect, useId, useRef, useState } from "preact/hooks";
import { GLOSSARY_TERMS, type GlossaryTermId } from "./glossary-definitions";

// PROJ-395: a toggletip explaining SDLC/PM jargon (Sprint, Epic, Groups, Tokens) inline
// next to nav labels, for users unfamiliar with this kind of tool. Same interaction
// pattern (and CSS classes) as MetricHelp.tsx (PROJ-335) — reused rather than duplicated
// since the toggletip visuals are identical, only the content source differs.
export function GlossaryHelp({ id }: { id: GlossaryTermId }) {
	const term = GLOSSARY_TERMS[id];
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement>(null);
	const popoverId = useId();

	useEffect(() => {
		if (!open) return;
		function onPointerDown(e: MouseEvent) {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<span class="metric-help" ref={rootRef}>
			<button
				type="button"
				class="metric-help-trigger"
				aria-label={`About ${term.label}`}
				aria-expanded={open}
				aria-describedby={open ? popoverId : undefined}
				onClick={(e) => {
					e.preventDefault();
					setOpen((o) => !o);
				}}
			>
				<span aria-hidden="true">ⓘ</span>
			</button>
			{open && (
				<div
					id={popoverId}
					role="dialog"
					aria-modal="false"
					aria-label={`${term.label} definition`}
					class="metric-help-popover"
				>
					<p class="m-0 text-[0.8rem] text-text-base">{term.definition}</p>
				</div>
			)}
		</span>
	);
}
