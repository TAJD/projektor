import type { JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";

export interface SelectOption {
	value: string;
	label: string;
}

const OPEN_TRIGGER_KEYS = new Set(["ArrowDown", "Enter", " "]);

// Close on outside click, and on scroll/resize (the fixed menu can't track its
// anchor, so dismiss rather than let it drift).
function useCloseOnOutside(open: boolean, close: () => void, rootRef: { current: HTMLDivElement | null }) {
	useEffect(() => {
		if (!open) return;
		function onDocPointer(e: MouseEvent) {
			if (!rootRef.current?.contains(e.target as Node)) close();
		}
		function onScroll(e: Event) {
			if (rootRef.current?.contains(e.target as Node)) return;
			close();
		}
		document.addEventListener("mousedown", onDocPointer);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", onDocPointer);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open, close, rootRef]);
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
		};
		handlers[e.key]?.(e);
	};
}

interface SelectMenuProps {
	baseId: string;
	options: SelectOption[];
	value: string;
	highlight: number;
	menuPos: { top: number; left: number; width: number };
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
			style={{
				position: "fixed",
				top: `${menuPos.top}px`,
				left: `${menuPos.left}px`,
				minWidth: `${menuPos.width}px`,
			}}
		>
			{options.map((opt, i) => (
				<li
					key={opt.value}
					id={`${baseId}-opt-${i}`}
					role="option"
					aria-selected={opt.value === value}
					class={i === highlight ? "select-option highlighted" : "select-option"}
					style={{ textTransform: capitalize ? "capitalize" : undefined }}
					onMouseEnter={() => onHighlight(i)}
					onClick={() => onChoose(i)}
				>
					{opt.label}
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
}: Props) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number }>({
		top: 0,
		left: 0,
		width: 0,
	});
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const baseId = useId();

	const selectedIndex = options.findIndex((o) => o.value === value);
	const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

	const close = useCallback(() => setOpen(false), []);

	// Open at the current selection. The menu is positioned with `position: fixed`
	// from the button's rect so it escapes any `overflow` clipping ancestor (e.g.
	// the horizontally-scrollable issue table) — the way a native popup would.
	function openMenu() {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
		setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
		setOpen(true);
	}

	function choose(index: number) {
		const opt = options[index];
		if (opt) onChange(opt.value);
		setOpen(false);
	}

	useCloseOnOutside(open, close, rootRef);

	const onKeyDown = createSelectKeyDownHandler({
		disabled,
		open,
		openMenu,
		optionCount: options.length,
		highlight,
		setHighlight,
		choose,
		close,
	});

	const label = selected?.label ?? value;

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
