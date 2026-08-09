import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import { METRIC_DEFINITIONS, type MetricId } from "./metric-definitions";
import { Popover } from "./ui/Popover";

// PROJ-588: same clamped-portal approach as GlossaryHelp.tsx — an `anchored` popover
// pinned to `left: 0` of its trigger can overflow the viewport's right edge on a narrow
// phone when the trigger itself sits near that edge (e.g. a chart section heading in a
// dashboard's right column). `max-width: min(16rem, 80vw)` clips the overflow but doesn't
// reposition it back on-screen.
const POPOVER_WIDTH = 256; // 16rem, matches .popover-metric-help's `width`
const POPOVER_MARGIN = 8;
const POPOVER_GAP = 4;
// PROJ-588 review: unlike FiltersPopover the content here is two short, unscrollable
// paragraphs, so there's no maxHeight to clamp — just flip above the trigger when there
// isn't room below. 140px comfortably covers two wrapped paragraphs in a 256px-wide panel.
const POPOVER_EST_HEIGHT = 140;

export function computeMetricHelpPosition(rect: DOMRect): { top: number; left: number } {
	const left = Math.max(
		POPOVER_MARGIN,
		Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN)
	);
	const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_MARGIN;
	const above = rect.top - POPOVER_GAP - POPOVER_MARGIN;
	const flip = below < POPOVER_EST_HEIGHT && above > below;
	const top = flip
		? Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - POPOVER_EST_HEIGHT)
		: rect.bottom + POPOVER_GAP;
	return { top, left };
}

// PROJ-335: shared help affordance for every stat/chart, backed by metric-definitions.ts.
// A toggletip, not a native <dialog>/alert: a button that toggles a popover, dismissed via
// Escape or an outside click. Lives in its own module (rather than MetricsDashboard.tsx) so
// chart sections in other files, e.g. CodeHeatmap.tsx, can import it without a circular
// dependency on the dashboard that renders them.
export function MetricHelp({ id }: { id: MetricId }) {
	const def = METRIC_DEFINITIONS[id];
	const [open, setOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
	const rootRef = useRef<HTMLSpanElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const popoverId = useId();

	const reposition = useCallback(() => {
		const rect = triggerRef.current?.getBoundingClientRect();
		if (!rect) return;
		setPopoverPos(computeMetricHelpPosition(rect));
	}, []);

	function openPopover() {
		reposition();
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
		// CD-294: only a width change (rotation, desktop resize) invalidates the popover
		// enough to dismiss it — see GlossaryHelp.tsx's identical split for why.
		let lastWidth = window.innerWidth;
		function onResize() {
			if (window.innerWidth !== lastWidth) {
				lastWidth = window.innerWidth;
				setOpen(false);
				return;
			}
			reposition();
		}
		const vv = window.visualViewport;
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		vv?.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
			vv?.removeEventListener("resize", onResize);
		};
	}, [open, reposition]);

	return (
		<span class="metric-help" ref={rootRef}>
			<button
				ref={triggerRef}
				type="button"
				class="metric-help-trigger"
				aria-label={`About ${def.label}`}
				aria-expanded={open}
				aria-describedby={open ? popoverId : undefined}
				onClick={() => (open ? setOpen(false) : openPopover())}
			>
				<span aria-hidden="true">ⓘ</span>
			</button>
			{open && popoverPos && (
				<Popover
					id={popoverId}
					strategy="portal-fixed"
					class="popover-metric-help"
					role="dialog"
					ariaModal={false}
					ariaLabel={`${def.label} definition`}
					elementRef={popoverRef}
					position={popoverPos}
				>
					<p class="m-0 mb-1 text-[0.8rem] text-text-base">{def.definition}</p>
					<p class="m-0 text-[0.72rem] text-text-muted">{def.computation}</p>
				</Popover>
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
