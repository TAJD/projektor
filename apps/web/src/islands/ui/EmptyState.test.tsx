import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
	it("renders the title", () => {
		render(<EmptyState title="No projects yet" />);
		expect(screen.getByText("No projects yet")).toBeTruthy();
	});

	it("renders the description when provided", () => {
		render(<EmptyState title="No projects yet" description="Create one to get started" />);
		expect(screen.getByText("Create one to get started")).toBeTruthy();
	});

	it("omits the description paragraph when not provided", () => {
		const { container } = render(<EmptyState title="No projects yet" />);
		expect(container.querySelectorAll("p")).toHaveLength(1);
	});

	it("renders action content when provided", () => {
		render(
			<EmptyState title="No projects yet" action={<button type="button">Create project</button>} />
		);
		expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
	});

	it("renders icon content when provided", () => {
		render(<EmptyState title="No projects yet" icon={<span data-testid="icon">📁</span>} />);
		expect(screen.getByTestId("icon")).toBeTruthy();
	});

	it("applies an extra class to the wrapper", () => {
		const { container } = render(<EmptyState title="No projects yet" class="custom-class" />);
		expect(container.firstElementChild?.className).toContain("custom-class");
	});
});
