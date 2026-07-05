import { useEffect, useRef, useState } from "preact/hooks";
import {
	captureView,
	filtersMatch,
	parseSavedViews,
	removeView,
	type SavedView,
	type SavedViewFilters,
	upsertView,
	viewsStorageKey,
} from "../saved-views";

/** Owns saved-views state (localStorage-backed) and the views-menu UI state. */
export function useSavedViews(
	filterProject: string,
	currentFilters: SavedViewFilters,
	onApply: (filters: SavedViewFilters) => void
) {
	const [savedViews, setSavedViews] = useState<SavedView[]>([]);
	const [activeViewName, setActiveViewName] = useState<string | null>(null);
	const [showSaveInput, setShowSaveInput] = useState(false);
	const [saveViewName, setSaveViewName] = useState("");
	const [showViewsMenu, setShowViewsMenu] = useState(false);
	const viewsContainerRef = useRef<HTMLDivElement>(null);
	const viewsMenuRef = useRef<HTMLUListElement>(null);
	const viewsButtonRef = useRef<HTMLButtonElement>(null);
	const viewsMenuPos = useRef<{ top: number; left: number; width: number }>({
		top: 0,
		left: 0,
		width: 0,
	});

	// Load saved views from localStorage when the project context changes (PROJ-141)
	useEffect(() => {
		setSavedViews(parseSavedViews(localStorage.getItem(viewsStorageKey(filterProject))));
	}, [filterProject]);

	// Close views menu on outside click (PROJ-141)
	useEffect(() => {
		if (!showViewsMenu) return;
		function onPointer(e: MouseEvent) {
			const target = e.target as Node;
			if (!viewsContainerRef.current?.contains(target) && !viewsMenuRef.current?.contains(target)) {
				setShowViewsMenu(false);
			}
		}
		document.addEventListener("mousedown", onPointer);
		return () => document.removeEventListener("mousedown", onPointer);
	}, [showViewsMenu]);

	// Clear active view name when filters drift from the saved state (PROJ-141)
	useEffect(() => {
		if (!activeViewName) return;
		const activeView = savedViews.find((v) => v.name === activeViewName);
		if (!activeView) {
			setActiveViewName(null);
			return;
		}
		if (!filtersMatch(currentFilters, activeView.filters)) setActiveViewName(null);
	}, [currentFilters, activeViewName, savedViews]);

	function doSaveView() {
		const name = saveViewName.trim();
		if (!name) return;
		const newView: SavedView = captureView(name, currentFilters);
		const key = viewsStorageKey(filterProject);
		const updated = upsertView(savedViews, newView);
		setSavedViews(updated);
		// safe-ls: cosmetic filter preference, no API dependency
		localStorage.setItem(key, JSON.stringify(updated));
		setActiveViewName(name);
		setSaveViewName("");
		setShowSaveInput(false);
	}

	function deleteView(name: string) {
		const key = viewsStorageKey(filterProject);
		const updated = removeView(savedViews, name);
		setSavedViews(updated);
		// safe-ls: cosmetic filter preference, no API dependency
		localStorage.setItem(key, JSON.stringify(updated));
		if (activeViewName === name) setActiveViewName(null);
	}

	function applyView(view: SavedView) {
		onApply(view.filters);
		setActiveViewName(view.name);
		setShowViewsMenu(false);
	}

	return {
		savedViews,
		activeViewName,
		showSaveInput,
		setShowSaveInput,
		saveViewName,
		setSaveViewName,
		showViewsMenu,
		setShowViewsMenu,
		viewsContainerRef,
		viewsMenuRef,
		viewsButtonRef,
		viewsMenuPos,
		doSaveView,
		deleteView,
		applyView,
	};
}
