import type { JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";

export interface SelectOption {
	value: string;
	label: string;
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

	// Close on outside click, and on scroll/resize (the fixed menu can't track its
	// anchor, so dismiss rather than let it drift).
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
	}, [open, close]);

	function onKeyDown(e: KeyboardEvent) {
		if (disabled) return;
		if (!open) {
			if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				openMenu();
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setHighlight((h) => Math.min(h + 1, options.length - 1));
				break;
			case "ArrowUp":
				e.preventDefault();
				setHighlight((h) => Math.max(h - 1, 0));
				break;
			case "Home":
				e.preventDefault();
				setHighlight(0);
				break;
			case "End":
				e.preventDefault();
				setHighlight(options.length - 1);
				break;
			case "Enter":
			case " ":
				e.preventDefault();
				choose(highlight);
				break;
			case "Escape":
				e.preventDefault();
				close();
				break;
			case "Tab":
				close();
				break;
		}
	}

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
							onMouseEnter={() => setHighlight(i)}
							onClick={() => choose(i)}
						>
							{opt.label}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
