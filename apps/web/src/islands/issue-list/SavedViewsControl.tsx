import type { SavedView } from "../saved-views";
import type { useSavedViews } from "./useSavedViews";

type Saved = ReturnType<typeof useSavedViews>;

function ViewsMenuItem({
	view,
	activeViewName,
	applyView,
	deleteView,
}: Pick<Saved, "applyView" | "deleteView"> & { view: SavedView; activeViewName: string | null }) {
	return (
		<li
			key={view.name}
			class="select-option"
			data-selected={view.name === activeViewName || undefined}
			style={{
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				gap: "0.5rem",
			}}
		>
			<button
				type="button"
				style={{
					flexGrow: 1,
					cursor: "pointer",
					background: "none",
					border: "none",
					padding: 0,
					textAlign: "left",
					font: "inherit",
					color: "inherit",
				}}
				onClick={() => applyView(view)}
			>
				{view.name}
			</button>
			<button
				type="button"
				aria-label={`Delete view ${view.name}`}
				onClick={(e: MouseEvent) => {
					e.stopPropagation();
					deleteView(view.name);
				}}
				style={{
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
				×
			</button>
		</li>
	);
}

function ViewsMenu({ saved }: { saved: Saved }) {
	const {
		savedViews,
		activeViewName,
		showViewsMenu,
		setShowViewsMenu,
		viewsContainerRef,
		viewsMenuRef,
		viewsButtonRef,
		viewsMenuPos,
		applyView,
		deleteView,
	} = saved;
	if (savedViews.length === 0) return null;

	return (
		<div class="relative" ref={viewsContainerRef}>
			<button
				ref={viewsButtonRef}
				type="button"
				class="select-button"
				aria-haspopup="listbox"
				aria-expanded={showViewsMenu}
				aria-label="Saved views"
				onClick={() => {
					if (showViewsMenu) {
						setShowViewsMenu(false);
					} else {
						const rect = viewsButtonRef.current?.getBoundingClientRect();
						if (rect)
							viewsMenuPos.current = { top: rect.bottom + 4, left: rect.left, width: rect.width };
						setShowViewsMenu(true);
					}
				}}
			>
				<span>{activeViewName ?? "Views"}</span>
				<span class="select-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{showViewsMenu && (
				<ul
					ref={viewsMenuRef}
					class="select-menu"
					aria-label="Saved views"
					style={{
						position: "fixed",
						top: `${viewsMenuPos.current.top}px`,
						left: `${viewsMenuPos.current.left}px`,
						minWidth: `${viewsMenuPos.current.width}px`,
					}}
				>
					{savedViews.map((v) => (
						<ViewsMenuItem
							key={v.name}
							view={v}
							activeViewName={activeViewName}
							applyView={applyView}
							deleteView={deleteView}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function SaveViewControl({ saved }: { saved: Saved }) {
	const { showSaveInput, setShowSaveInput, saveViewName, setSaveViewName, doSaveView } = saved;

	if (!showSaveInput) {
		return (
			<button
				type="button"
				onClick={() => setShowSaveInput(true)}
				class="py-1 px-[0.625rem] rounded-full border border-border bg-bg text-text-muted cursor-pointer text-[0.8rem]"
			>
				Save view
			</button>
		);
	}

	return (
		<div class="flex items-center gap-1">
			<input
				type="text"
				value={saveViewName}
				onInput={(e) => setSaveViewName((e.target as HTMLInputElement).value)}
				onKeyDown={(e: KeyboardEvent) => {
					if (e.key === "Enter") doSaveView();
					if (e.key === "Escape") {
						setSaveViewName("");
						setShowSaveInput(false);
					}
				}}
				placeholder="View name…"
				// biome-ignore lint/a11y/noAutofocus: intentional — triggered by user action
				autoFocus
				class="py-1 px-[0.625rem] border border-border rounded bg-bg text-text-base text-[0.8rem] outline-none"
				style={{ width: "8rem" }}
			/>
			<button
				type="button"
				onClick={doSaveView}
				class="py-1 px-[0.625rem] rounded border border-border bg-bg text-text-base text-[0.8rem] cursor-pointer"
			>
				Save
			</button>
			<button
				type="button"
				aria-label="Cancel save view"
				onClick={() => {
					setSaveViewName("");
					setShowSaveInput(false);
				}}
				class="bg-transparent border-none text-text-muted cursor-pointer text-base px-1 leading-none"
			>
				×
			</button>
		</div>
	);
}

/** Views dropdown (apply/delete saved views) + the "Save view" button/input. */
export default function SavedViewsControl({ saved }: { saved: Saved }) {
	return (
		<>
			<ViewsMenu saved={saved} />
			<SaveViewControl saved={saved} />
		</>
	);
}
