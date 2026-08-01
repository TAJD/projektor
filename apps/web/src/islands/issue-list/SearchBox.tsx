import type { RefObject } from "preact";

export default function SearchBox({
	searchQuery,
	setSearchQuery,
	isSearchActive,
	searchInputRef,
}: {
	searchQuery: string;
	setSearchQuery: (v: string) => void;
	isSearchActive: boolean;
	searchInputRef: RefObject<HTMLInputElement>;
}) {
	return (
		<div class="flex items-center gap-1 max-sm:w-full">
			<input
				ref={searchInputRef}
				type="search"
				value={searchQuery}
				onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
				placeholder="Search…"
				aria-label="Search issues"
				class={`py-1 px-[0.625rem] border border-border rounded bg-bg text-text-base text-[0.8rem]
					outline-none max-sm:w-full ${isSearchActive ? "w-48" : "w-28"}`}
				style={{ transition: "width 0.2s" }}
			/>
			{isSearchActive && (
				<button
					type="button"
					aria-label="Clear search"
					onClick={() => {
						setSearchQuery("");
						searchInputRef.current?.focus();
					}}
					class="bg-transparent border-none text-text-muted cursor-pointer text-base px-1 leading-none"
				>
					×
				</button>
			)}
		</div>
	);
}
