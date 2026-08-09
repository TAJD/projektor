import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import NewSourceModal from "./NewSourceModal";

function stubFetch() {
	const fetchMock = vi.fn().mockImplementation(() =>
		Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ id: "s2", token: "fbk_rawtoken_shown_once" }),
		})
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("NewSourceModal", () => {
	it("disables submit until a name is entered", () => {
		stubFetch();
		render(
			<NewSourceModal
				projectId="p1"
				workspaceSlug="my-ws"
				onClose={() => {}}
				onCreated={() => {}}
			/>
		);
		expect(
			(screen.getByRole("button", { name: /Create source/i }) as HTMLButtonElement).disabled
		).toBe(true);
		fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: "NPS" } });
		expect(
			(screen.getByRole("button", { name: /Create source/i }) as HTMLButtonElement).disabled
		).toBe(false);
	});

	it("creating a source shows the raw token once and calls onCreated", async () => {
		stubFetch();
		const onCreated = vi.fn();
		render(
			<NewSourceModal
				projectId="p1"
				workspaceSlug="my-ws"
				onClose={() => {}}
				onCreated={onCreated}
			/>
		);
		fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: "NPS" } });
		fireEvent.click(screen.getByRole("button", { name: /Create source/i }));
		expect(await screen.findByText("fbk_rawtoken_shown_once")).toBeTruthy();
		expect(onCreated).toHaveBeenCalled();
	});

	it("clicking Cancel calls onClose without creating a source", () => {
		const fetchMock = stubFetch();
		const onClose = vi.fn();
		render(
			<NewSourceModal projectId="p1" workspaceSlug="my-ws" onClose={onClose} onCreated={() => {}} />
		);
		fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
		expect(onClose).toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("clicking Done after token reveal calls onClose", async () => {
		stubFetch();
		const onClose = vi.fn();
		render(
			<NewSourceModal projectId="p1" workspaceSlug="my-ws" onClose={onClose} onCreated={() => {}} />
		);
		fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: "NPS" } });
		fireEvent.click(screen.getByRole("button", { name: /Create source/i }));
		fireEvent.click(await screen.findByRole("button", { name: /^Done$/i }));
		expect(onClose).toHaveBeenCalled();
	});

	it("sizes the panel in dvh and contains its own scroll (CD-294)", () => {
		// `vh` is iOS's *large* viewport — never shrunk for the keyboard or an expanded
		// URL bar — so an 80vh panel's action row can sit below the fold with no way to
		// scroll to it. `overscroll-contain` stops the panel's scroll chaining to the page.
		stubFetch();
		render(
			<NewSourceModal
				projectId="p1"
				workspaceSlug="my-ws"
				onClose={() => {}}
				onCreated={() => {}}
			/>
		);
		const panel = screen.getByRole("dialog", { name: "New feedback source" });
		expect(panel.className).toContain("max-h-[80dvh]");
		expect(panel.className).toContain("max-sm:max-h-[90dvh]");
		expect(panel.className).toContain("overscroll-contain");
		expect(panel.className).not.toMatch(/max-h-\[\d+vh\]/);
	});
});
