import type { JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";

export interface SelectOption {
	value: string;
	label: string;
	/**
	 * PROJ-565: an optional trailing action rendered inside the option row (e.g. delete a
	 * saved view). Stops propagation so it never triggers `onChange` for the option itself.
	 */
	action?: {
		ariaLabel: string;
		/** Defaults to "×". */
		icon?: string;
		onClick: () => void;
	};
}

const OPEN_TRIGGER_KEYS = new Set(["ArrowDown", "Enter", " "]);

/** Matches Base.astro's mobile `@media (max-width: 640px)` Select rules. */
const MOBILE_MENU_QUERY = "(max-width: 640px)";
const MENU_GAP = 4;
const MENU_VIEWPORT_MARGIN = 8;
/** Mirrors `.select-menu`'s `max-height: 16rem` in Base.astro. */
const MENU_MAX_HEIGHT = 256;
const MENU_MIN_HEIGHT = 80;

export interface MenuPos {
	top: number;
	left: number;
	width: number;
	maxHeight: number;
}

/**
 * Below `MOBILE_MENU_QUERY` the menu is a CSS-owned bottom sheet: the component
 * must NOT emit inline coordinates, because inline styles beat class rules
 * regardless of specificity (same split as Popover.tsx's `strategy` prop).
 */
function isMobileMenu(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.(MOBILE_MENU_QUERY).matches === true;
}

function viewportHeight(): number {
	return window.visualViewport?.height ?? window.innerHeight;
}

/**
 * CD-294: clamp the fixed menu to the *visual* viewport and flip it above the
 * trigger when below has no room. Without this a select in the lower half of a
 * phone screen opens a menu whose bottom is off-screen and unreachable — a
 * `position: fixed` element can't be scrolled into view.
 */
export function computeMenuPosition(rect: DOMRect): MenuPos {
	const below = viewportHeight() - rect.bottom - MENU_GAP - MENU_VIEWPORT_MARGIN;
	const above = rect.top - MENU_GAP - MENU_VIEWPORT_MARGIN;
	const flip = below < MENU_MIN_HEIGHT && above > below;
	const space = flip ? above : below;
	const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, space));
	const top = flip
		? Math.max(MENU_VIEWPORT_MARGIN, rect.top - MENU_GAP - maxHeight)
		: rect.bottom + MENU_GAP;
	return { top, left: rect.left, width: rect.width, maxHeight };
}

// Close on genuine outside taps and on width changes (orientation), but only
// *reposition* on scroll and height-only resizes. CD-294: iOS fires `resize` on
// keyboard show/hide and on Safari chrome collapsing, so closing there made
// every dropdown vanish the moment it was tapped.
function useCloseOnOutside(
	open: boolean,
	close: () => void,
	reposition: () => void,
	rootRef: Readonly<{ current: HTMLDivElement | null }>
) {
	useEffect(() => {
		if (!open) return;
		let lastWidth = window.innerWidth;
		function onDocPointer(e: Event) {
			if (!rootRef.current?.contains(e.target as Node)) close();
		}
		function onScroll(e: Event) {
			if (rootRef.current?.contains(e.target as Node)) return;
			reposition();
		}
		function onResize() {
			if (window.innerWidth !== lastWidth) {
				lastWidth = window.innerWidth;
				close();
				return;
			}
			reposition();
		}
		const vv = window.visualViewport;
		document.addEventListener("pointerdown", onDocPointer);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		vv?.addEventListener("resize", onResize);
		vv?.addEventListener("scroll", reposition);
		return () => {
			document.removeEventListener("pointerdown", onDocPointer);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
			vv?.removeEventListener("resize", onResize);
			vv?.removeEventListener("scroll", reposition);
		};
	}, [open, close, reposition, rootRef]);
}

interface SelectKeyDownConfig {
	disabled: boolean;
	open: boolean;
	openMenu: () => void;
	optionCount: number;
	highlight: number;
	setHighlight: (fn: (h: number) => number) => void;
	choose: (index: number) => void;
	close: () => void;
	/** PROJ-565: runs the highlighted option's `action`, if it has one. Returns whether it did. */
	runAction: (index: number) => boolean;
}

function createSelectKeyDownHandler({
	disabled,
	open,
	openMenu,
	optionCount,
	highlight,
	setHighlight,
	choose,
	close,
	runAction,
}: SelectKeyDownConfig) {
	return function onKeyDown(e: KeyboardEvent) {
		if (disabled) return;
		if (!open) {
			if (OPEN_TRIGGER_KEYS.has(e.key)) {
				e.preventDefault();
				openMenu();
			}
			return;
		}
		const handlers: Record<string, (e: KeyboardEvent) => void> = {
			ArrowDown: (ev) => {
				ev.preventDefault();
				setHighlight((h) => Math.min(h + 1, optionCount - 1));
			},
			ArrowUp: (ev) => {
				ev.preventDefault();
				setHighlight((h) => Math.max(h - 1, 0));
			},
			Home: (ev) => {
				ev.preventDefault();
				setHighlight(() => 0);
			},
			End: (ev) => {
				ev.preventDefault();
				setHighlight(() => optionCount - 1);
			},
			Enter: (ev) => {
				ev.preventDefault();
				choose(highlight);
			},
			" ": (ev) => {
				ev.preventDefault();
				choose(highlight);
			},
			Escape: (ev) => {
				ev.preventDefault();
				close();
			},
			Tab: () => close(),
			// PROJ-565: the trailing per-item action (e.g. delete a saved view) is a
			// nested <button>, but this listbox uses the aria-activedescendant pattern —
			// DOM focus never leaves the trigger, so the button is otherwise unreachable
			// by keyboard. Delete/Backspace on the highlighted option runs it instead.
			// Only preventDefault when there's actually an action to run, so plain
			// Selects (no action on any option) don't swallow the keystroke.
			Delete: (ev) => {
				if (runAction(highlight)) ev.preventDefault();
			},
			Backspace: (ev) => {
				if (runAction(highlight)) ev.preventDefault();
			},
		};
		handlers[e.key]?.(e);
	};
}

interface SelectMenuProps {
	baseId: string;
	options: SelectOption[];
	value: string;
	highlight: number;
	/** `null` = mobile sheet mode: CSS owns position, emit no inline coordinates. */
	menuPos: MenuPos | null;
	ariaLabel: string;
	capitalize: boolean;
	onHighlight: (i: number) => void;
	onChoose: (i: number) => void;
}

function SelectMenu({
	baseId,
	options,
	value,
	highlight,
	menuPos,
	ariaLabel,
	capitalize,
	onHighlight,
	onChoose,
}: SelectMenuProps) {
	return (
		<ul
			id={`${baseId}-menu`}
			class="select-menu"
			role="listbox"
			aria-label={ariaLabel}
			style={
				menuPos
					? {
							position: "fixed",
							top: `${menuPos.top}px`,
							left: `${menuPos.left}px`,
							minWidth: `${menuPos.width}px`,
							maxHeight: `${menuPos.maxHeight}px`,
						}
					: undefined
			}
		>
			{options.map((opt, i) => (
				<li
					key={opt.value}
					id={`${baseId}-opt-${i}`}
					role="option"
					aria-selected={opt.value === value}
					// PROJ-565: an explicit aria-label pins the accessible name to just the
					// label — without it, the nested action button's own aria-label gets
					// folded into the option's computed name (browser accname rules
					// substitute a descendant's aria-label into the concatenation), so an
					// option like "My bugs" would announce as "My bugs Delete view My bugs".
					aria-label={opt.action ? opt.label : undefined}
					data-selected={opt.value === value || undefined}
					class={i === highlight ? "select-option highlighted" : "select-option"}
					style={{ textTransform: capitalize ? "capitalize" : undefined }}
					onMouseEnter={() => onHighlight(i)}
					onClick={() => onChoose(i)}
				>
					{opt.action ? <span style={{ flexGrow: 1 }}>{opt.label}</span> : opt.label}
					{opt.action && (
						<button
							type="button"
							aria-label={opt.action.ariaLabel}
							onClick={(e: MouseEvent) => {
								e.stopPropagation();
								opt.action?.onClick();
							}}
							style={{
								marginLeft: "auto",
								background: "none",
								border: "none",
								cursor: "pointer",
								color: "var(--text-muted)",
								padding: "0 0.2rem",
								fontSize: "0.85rem",
								lineHeight: "1",
								flexShrink: 0,
							}}
						>
							{opt.action.icon ?? "×"}
						</button>
					)}
				</li>
			))}
		</ul>
	);
}

interface Props {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	ariaLabel: string;
	disabled?: boolean;
	/** Inline styles merged onto the trigger button (e.g. priority colours). */
	buttonStyle?: JSX.CSSProperties;
	/** Capitalize option/label text (priority values are stored lowercase). */
	capitalize?: boolean;
	/** Extra class appended to the trigger button. */
	buttonClass?: string;
	/**
	 * PROJ-565: label shown when `value` matches no option (e.g. no saved view is active
	 * yet). Falls back to the raw `value` when omitted, unchanged from prior behavior.
	 */
	placeholder?: string;
}

/**
 * A thin, hand-rolled select: a <button> trigger + an absolutely-positioned
 * listbox. No native <select>, no dependencies. Keyboard-accessible via the
 * button + listbox + aria-activedescendant pattern. Styling lives in Base.astro
 * (`.select`, `.select-button`, `.select-menu`, `.select-option`) so islands
 * share one source of truth.
 */
export default function Select({
	value,
	options,
	onChange,
	ariaLabel,
	disabled = false,
	buttonStyle,
	capitalize = false,
	buttonClass,
	placeholder,
}: Props) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const baseId = useId();

	const selectedIndex = options.findIndex((o) => o.value === value);
	const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

	const close = useCallback(() => setOpen(false), []);

	// On desktop the menu is positioned with `position: fixed` from the button's
	// rect so it escapes any `overflow` clipping ancestor (e.g. the
	// horizontally-scrollable issue table) — the way a native popup would. Below
	// the mobile breakpoint it becomes a CSS-owned bottom sheet (`menuPos: null`).
	const reposition = useCallback(() => {
		const rect = isMobileMenu() ? undefined : buttonRef.current?.getBoundingClientRect();
		setMenuPos(rect ? computeMenuPosition(rect) : null);
	}, []);

	function openMenu() {
		reposition();
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		setOpen(true);
	}

	function choose(index: number) {
		const opt = options[index];
		if (opt) onChange(opt.value);
		setOpen(false);
	}

	// PROJ-565: keyboard equivalent of clicking an option's trailing action button.
	// Returns whether an action actually ran, so the caller only preventDefaults then.
	function runAction(index: number): boolean {
		const action = options[index]?.action;
		if (!action) return false;
		action.onClick();
		return true;
	}

	// PROJ-565: an action (e.g. delete) can shrink `options` while the menu is open —
	// clamp so `highlight`/`aria-activedescendant` never point past the new end.
	useEffect(() => {
		if (highlight > options.length - 1) setHighlight(Math.max(0, options.length - 1));
	}, [options.length, highlight]);

	useCloseOnOutside(open, close, reposition, rootRef);

	const onKeyDown = createSelectKeyDownHandler({
		disabled,
		open,
		openMenu,
		optionCount: options.length,
		highlight,
		setHighlight,
		choose,
		close,
		runAction,
	});

	const label = selected?.label ?? (value || placeholder || "");

	return (
		<div class="select" ref={rootRef}>
			<button
				ref={buttonRef}
				type="button"
				role="combobox"
				class={buttonClass ? `select-button ${buttonClass}` : "select-button"}
				style={{ textTransform: capitalize ? "capitalize" : undefined, ...buttonStyle }}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={`${baseId}-menu`}
				aria-activedescendant={open ? `${baseId}-opt-${highlight}` : undefined}
				disabled={disabled}
				onClick={() => (open ? close() : openMenu())}
				onKeyDown={onKeyDown}
			>
				<span>{label}</span>
				<span class="select-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{open && (
				<SelectMenu
					baseId={baseId}
					options={options}
					value={value}
					highlight={highlight}
					menuPos={menuPos}
					ariaLabel={ariaLabel}
					capitalize={capitalize}
					onHighlight={setHighlight}
					onChoose={choose}
				/>
			)}
		</div>
	);
}
