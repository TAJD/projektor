import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
	it("renders a div by default", () => {
		render(<Card>Content</Card>);
		const card = screen.getByText("Content");
		expect(card.tagName).toBe("DIV");
		expect(card.className).toBe(
			"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg"
		);
	});

	it("renders an anchor with href when as='a'", () => {
		render(
			<Card as="a" href="/projects/1">
				Project
			</Card>
		);
		const link = screen.getByRole("link", { name: "Project" }) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("/projects/1");
		expect(link.className).toBe(
			"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg no-underline"
		);
	});

	it("throws when as='a' without href", () => {
		expect(() => render(<Card as="a">No href</Card>)).toThrow();
	});

	it("passes through an extra class", () => {
		render(<Card class="metric-card">Content</Card>);
		const card = screen.getByText("Content");
		expect(card.className).toBe(
			"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg metric-card"
		);
	});

	it("adds hover treatment when interactive", () => {
		render(<Card interactive>Content</Card>);
		const card = screen.getByText("Content");
		expect(card.className).toBe(
			"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg transition-all duration-150 hover:border-accent hover:-translate-y-px"
		);
	});

	it("omits hover treatment when not interactive", () => {
		render(<Card>Content</Card>);
		const card = screen.getByText("Content");
		expect(card.className).not.toContain("hover:border-accent");
	});
});
