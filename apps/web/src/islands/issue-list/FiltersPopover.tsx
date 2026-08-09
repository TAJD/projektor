import type { Dispatch, StateUpdater } from "preact/hooks";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { categoryColor, type TaskStatus } from "../board-utils";

export type DateField = "" | "completed" | "updated";

// PROJ-588: opened low on a phone, this fixed-position panel had no viewport clamping —
// the date-range fields and "Clear all" could fall below the viewport with nothing to
// scroll to reach them. Same flip/clamp/scroll shape as Select.tsx's computeMenuPosition,
// tuned for this panel's own width and content height rather than a listbox row.
const POPOVER_WIDTH = 256; // 16rem, matches the inline minWidth below
const POPOVER_GAP = 4;
const POPOVER_MARGIN = 8;
const POPOVER_MIN_HEIGHT = 160;
const POPOVER_MAX_HEIGHT = 420;

export interface FiltersPopoverPos {
	top: number;
	left: number;
	maxHeight: number;
}

export function computeFiltersPopoverPosition(rect: DOMRect): FiltersPopoverPos {
	const left = Math.max(
		POPOVER_MARGIN,
		Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN)
	);
	const below = window.innerHeight - rect.bottom - POPOVER_GAP - POPOVER_MARGIN;
	const above = rect.top - POPOVER_GAP - POPOVER_MARGIN;
	const flip = below < POPOVER_MIN_HEIGHT && above > below;
	const space = flip ? above : below;
	const maxHeight = Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, space));
	const top = flip
		? Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - maxHeight)
		: rect.bottom + POPOVER_GAP;
	return { top, left, maxHeight };
}

const PILL_COLORS: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "var(--priority-urgent-solid)", text: "var(--on-accent)" },
	high: { bg: "var(--priority-high-solid)", text: "var(--on-accent)" },
	medium: { bg: "var(--priority-medium-solid)", text: "var(--on-accent)" },
	low: { bg: "var(--priority-low-solid)", text: "var(--on-accent)" },
};

function StatusPills({
	derivedStatuses,
	filterStatuses,
	setFilterStatuses,
}: {
	derivedStatuses: readonly TaskStatus[];
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
}) {
	return (
		<div class="flex flex-wrap gap-1 mb-3">
			{derivedStatuses.map((s) => {
				const active = filterStatuses.includes(s.id);
				return (
					<button
						type="button"
						key={s.id}
						aria-pressed={active}
						onClick={() =>
							setFilterStatuses((prev) =>
								active ? prev.filter((id) => id !== s.id) : [...prev, s.id]
							)
						}
						style={{
							padding: "0.25rem 0.625rem",
							borderRadius: "9999px",
							border: active ? "none" : "1px solid var(--border)",
							background: active ? categoryColor(s.category) : "var(--bg)",
							color: active ? "var(--on-accent)" : "var(--text)",
							cursor: "pointer",
							fontSize: "0.8rem",
							fontWeight: active ? 600 : 400,
						}}
					>
						{s.name}
					</button>
				);
			})}
		</div>
	);
}

function PriorityPills({
	filterPriorities,
	setFilterPriorities,
}: {
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
}) {
	return (
		<div class="flex flex-wrap gap-1">
			{(["urgent", "high", "medium", "low"] as const).map((p) => {
				const active = filterPriorities.includes(p);
				const col = PILL_COLORS[p];
				return (
					<button
						type="button"
						key={p}
						aria-pressed={active}
						onClick={() =>
							setFilterPriorities((prev) => (active ? prev.filter((k) => k !== p) : [...prev, p]))
						}
						style={{
							padding: "0.25rem 0.625rem",
							borderRadius: "9999px",
							border: active ? "none" : "1px solid var(--border)",
							background: active ? col.bg : "var(--bg)",
							color: active ? col.text : "var(--text)",
							cursor: "pointer",
							fontSize: "0.8rem",
							fontWeight: active ? 600 : 400,
							textTransform: "capitalize" as const,
						}}
					>
						{p}
					</button>
				);
			})}
		</div>
	);
}

function DateRangeFilter({
	filterDateField,
	setFilterDateField,
	filterDateFrom,
	setFilterDateFrom,
	filterDateTo,
	setFilterDateTo,
}: {
	filterDateField: DateField;
	setFilterDateField: Dispatch<StateUpdater<DateField>>;
	filterDateFrom: string;
	setFilterDateFrom: Dispatch<StateUpdater<string>>;
	filterDateTo: string;
	setFilterDateTo: Dispatch<StateUpdater<string>>;
}) {
	return (
		<>
			{/* Date range (PROJ-212) — bound a chosen timestamp column server-side */}
			<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2 mt-3">
				Date range
			</div>
			<select
				aria-label="Date filter field"
				value={filterDateField}
				onChange={(e) => setFilterDateField((e.target as HTMLSelectElement).value as DateField)}
				class="w-full px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base cursor-pointer"
			>
				<option value="">No date filter</option>
				<option value="completed">Completed date</option>
				<option value="updated">Last edited date</option>
			</select>
			{filterDateField && (
				<div class="flex gap-2 mt-2">
					<label class="flex-1 text-[0.7rem] text-text-muted">
						From
						<input
							type="date"
							aria-label="From date"
							value={filterDateFrom}
							onInput={(e) => setFilterDateFrom((e.target as HTMLInputElement).value)}
							class="w-full px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base mt-[0.2rem]"
						/>
					</label>
					<label class="flex-1 text-[0.7rem] text-text-muted">
						To
						<input
							type="date"
							aria-label="To date"
							value={filterDateTo}
							onInput={(e) => setFilterDateTo((e.target as HTMLInputElement).value)}
							class="w-full px-2 py-[0.3rem] border border-border rounded text-sm bg-bg text-text-base mt-[0.2rem]"
						/>
					</label>
				</div>
			)}
		</>
	);
}

interface FiltersPopoverProps {
	derivedStatuses: readonly TaskStatus[];
	filterStatuses: string[];
	setFilterStatuses: Dispatch<StateUpdater<string[]>>;
	filterPriorities: string[];
	setFilterPriorities: Dispatch<StateUpdater<string[]>>;
	filterDateField: DateField;
	setFilterDateField: Dispatch<StateUpdater<DateField>>;
	filterDateFrom: string;
	setFilterDateFrom: Dispatch<StateUpdater<string>>;
	filterDateTo: string;
	setFilterDateTo: Dispatch<StateUpdater<string>>;
	isSearchActive: boolean;
}

function FiltersToggleButton({
	buttonRef,
	isSearchActive,
	activeFilterCount,
	onToggle,
}: {
	buttonRef: { current: HTMLButtonElement | null };
	isSearchActive: boolean;
	activeFilterCount: number;
	onToggle: () => void;
}) {
	const activeStyle =
		activeFilterCount > 0
			? { border: "none", background: "var(--accent)", color: "var(--on-accent)", fontWeight: 600 }
			: {
					border: "1px solid var(--border)",
					background: "var(--bg)",
					color: "var(--text)",
					fontWeight: 400,
				};
	const searchState = isSearchActive
		? { cursor: "default", opacity: 0.4 }
		: { cursor: "pointer", opacity: 1 };

	return (
		<button
			ref={buttonRef}
			type="button"
			disabled={isSearchActive}
			onClick={onToggle}
			style={{
				padding: "0.25rem 0.625rem",
				borderRadius: "9999px",
				...activeStyle,
				...searchState,
				fontSize: "0.8rem",
				transition: "opacity 0.15s",
			}}
		>
			{activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters"}
		</button>
	);
}

function FiltersPopoverContent(
	props: Pick<
		FiltersPopoverProps,
		| "derivedStatuses"
		| "filterStatuses"
		| "setFilterStatuses"
		| "filterPriorities"
		| "setFilterPriorities"
		| "filterDateField"
		| "setFilterDateField"
		| "filterDateFrom"
		| "setFilterDateFrom"
		| "filterDateTo"
		| "setFilterDateTo"
	> & { activeFilterCount: number }
) {
	const {
		derivedStatuses,
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		activeFilterCount,
	} = props;
	return (
		<>
			<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
				Status
			</div>
			<StatusPills
				derivedStatuses={derivedStatuses}
				filterStatuses={filterStatuses}
				setFilterStatuses={setFilterStatuses}
			/>
			<div class="text-[0.7rem] font-semibold text-text-muted uppercase tracking-[0.04em] mb-2">
				Priority
			</div>
			<PriorityPills
				filterPriorities={filterPriorities}
				setFilterPriorities={setFilterPriorities}
			/>
			<DateRangeFilter
				filterDateField={props.filterDateField}
				setFilterDateField={props.setFilterDateField}
				filterDateFrom={props.filterDateFrom}
				setFilterDateFrom={props.setFilterDateFrom}
				filterDateTo={props.filterDateTo}
				setFilterDateTo={props.setFilterDateTo}
			/>
			{activeFilterCount > 0 && (
				<div class="border-t border-border pt-2 mt-3">
					<button
						type="button"
						onClick={() => {
							setFilterStatuses([]);
							setFilterPriorities([]);
							props.setFilterDateField("");
							props.setFilterDateFrom("");
							props.setFilterDateTo("");
						}}
						class="bg-transparent border-none text-text-muted cursor-pointer text-[0.8rem] p-0"
					>
						✕ Clear all
					</button>
				</div>
			)}
		</>
	);
}

export default function FiltersPopover({
	derivedStatuses,
	filterStatuses,
	setFilterStatuses,
	filterPriorities,
	setFilterPriorities,
	filterDateField,
	setFilterDateField,
	filterDateFrom,
	setFilterDateFrom,
	filterDateTo,
	setFilterDateTo,
	isSearchActive,
}: FiltersPopoverProps) {
	const [showFiltersPopover, setShowFiltersPopover] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [popoverPos, setPopoverPos] = useState<FiltersPopoverPos | null>(null);

	const reposition = useCallback(() => {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (rect) setPopoverPos(computeFiltersPopoverPosition(rect));
	}, []);

	useEffect(() => {
		if (!showFiltersPopover) return;
		function onPointer(e: MouseEvent) {
			const target = e.target as Node;
			if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
				setShowFiltersPopover(false);
			}
		}
		// Orientation change / desktop resize can invalidate a clamped position computed
		// at open time (e.g. rotating the phone the popover was flipped-above on).
		window.addEventListener("resize", reposition);
		document.addEventListener("mousedown", onPointer);
		return () => {
			window.removeEventListener("resize", reposition);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [showFiltersPopover, reposition]);

	const dateFilterActive = !!(filterDateField && (filterDateFrom || filterDateTo));
	const activeFilterCount =
		filterStatuses.length + filterPriorities.length + (dateFilterActive ? 1 : 0);

	return (
		<div class="relative" ref={containerRef}>
			<FiltersToggleButton
				buttonRef={buttonRef}
				isSearchActive={isSearchActive}
				activeFilterCount={activeFilterCount}
				onToggle={() => {
					if (showFiltersPopover) {
						setShowFiltersPopover(false);
					} else {
						reposition();
						setShowFiltersPopover(true);
					}
				}}
			/>
			{showFiltersPopover && popoverPos && (
				<div
					ref={popoverRef}
					style={{
						position: "fixed",
						top: `${popoverPos.top}px`,
						left: `${popoverPos.left}px`,
						// CD-294: 200 is the popover layer (Base.astro's `.popover`). At 100 this
						// sat *under* the fixed topbar (110), which it can slide beneath — the
						// coordinates are captured once on open and never track the page scroll.
						zIndex: 200,
						background: "var(--surface)",
						border: "1px solid var(--border)",
						borderRadius: "0.5rem",
						padding: "0.75rem",
						boxShadow: "var(--shadow-sm)",
						minWidth: "16rem",
						// PROJ-588 review: the left clamp assumes POPOVER_WIDTH (256px); without a
						// matching maxWidth, content wider than that could still push the right edge
						// past the viewport.
						maxWidth: "calc(100vw - 16px)",
						// PROJ-588: clamp+flip alone isn't enough on a short phone viewport where
						// even the flipped side can't fit every field — scroll within the panel
						// rather than letting it (or its contents) run off-screen.
						maxHeight: `${popoverPos.maxHeight}px`,
						overflowY: "auto",
						overscrollBehavior: "contain",
					}}
				>
					<FiltersPopoverContent
						derivedStatuses={derivedStatuses}
						filterStatuses={filterStatuses}
						setFilterStatuses={setFilterStatuses}
						filterPriorities={filterPriorities}
						setFilterPriorities={setFilterPriorities}
						filterDateField={filterDateField}
						setFilterDateField={setFilterDateField}
						filterDateFrom={filterDateFrom}
						setFilterDateFrom={setFilterDateFrom}
						filterDateTo={filterDateTo}
						setFilterDateTo={setFilterDateTo}
						activeFilterCount={activeFilterCount}
					/>
				</div>
			)}
		</div>
	);
}
