import Select, { type SelectOption } from "../ui/Select";
import type { useSavedViews } from "./useSavedViews";

type Saved = ReturnType<typeof useSavedViews>;

// PROJ-565: Select's option renderer now supports a per-item trailing action, so this no
// longer needs its own hand-rolled trigger/menu — Select owns positioning, outside-click,
// and keyboard handling in one shared place instead of duplicating it here.
function ViewsMenu({ saved }: { saved: Saved }) {
	const { savedViews, activeViewName, applyView, deleteView } = saved;
	if (savedViews.length === 0) return null;

	const options: SelectOption[] = savedViews.map((v) => ({
		value: v.name,
		label: v.name,
		action: { ariaLabel: `Delete view ${v.name}`, onClick: () => deleteView(v.name) },
	}));

	return (
		<Select
			value={activeViewName ?? ""}
			options={options}
			onChange={(name) => {
				const view = savedViews.find((v) => v.name === name);
				if (view) applyView(view);
			}}
			ariaLabel="Saved views"
			placeholder="Views"
		/>
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
				class="py-1 px-[0.625rem] border border-border rounded bg-bg text-text-base text-[0.8rem] outline-hidden"
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
