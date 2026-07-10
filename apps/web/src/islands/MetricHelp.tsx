import { useEffect, useId, useRef, useState } from "preact/hooks";
import { METRIC_DEFINITIONS, type MetricId } from "./metric-definitions";

// PROJ-335: shared help affordance for every stat/chart, backed by metric-definitions.ts.
// A toggletip, not a native <dialog>/alert: a button that toggles a popover, dismissed via
// Escape or an outside click. Lives in its own module (rather than MetricsDashboard.tsx) so
// chart sections in other files, e.g. CodeHeatmap.tsx, can import it without a circular
// dependency on the dashboard that renders them.
export function MetricHelp({ id }: { id: MetricId }) {
	const def = METRIC_DEFINITIONS[id];
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
				aria-label={`About ${def.label}`}
				aria-expanded={open}
				aria-describedby={open ? popoverId : undefined}
				onClick={() => setOpen((o) => !o)}
			>
				<span aria-hidden="true">ⓘ</span>
			</button>
			{open && (
				<div
					id={popoverId}
					role="dialog"
					aria-modal="false"
					aria-label={`${def.label} definition`}
					class="metric-help-popover"
				>
					<p class="m-0 mb-1 text-[0.8rem] text-text-base">{def.definition}</p>
					<p class="m-0 text-[0.72rem] text-text-muted">{def.computation}</p>
				</div>
			)}
		</span>
	);
}

// Groups an h2 + MetricHelp icon + optional one-line caption, the pattern every chart
// section header on the metrics dashboard used ad hoc (title= tooltips, some with a caption
// paragraph) before PROJ-335 consolidated it onto the shared definitions map.
export function SectionHeading({ metricId, caption }: { metricId: MetricId; caption?: string }) {
	const def = METRIC_DEFINITIONS[metricId];
	return (
		<>
			<h2 class="m-0 mb-1 text-base font-semibold text-text-base inline-flex items-center gap-1.5">
				{def.label}
				<MetricHelp id={metricId} />
			</h2>
			{caption && <p class="m-0 mb-3 text-[0.72rem] text-text-muted">{caption}</p>}
		</>
	);
}
