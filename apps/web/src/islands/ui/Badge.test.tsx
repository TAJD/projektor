import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
	it("renders the bare .badge class when no extra class is given", () => {
		render(<Badge>Open</Badge>);
		const badge = screen.getByText("Open");
		expect(badge.className).toBe("badge");
	});

	it("passes through an extra class", () => {
		render(<Badge class="status-badge">Closed</Badge>);
		const badge = screen.getByText("Closed");
		expect(badge.className).toBe("badge status-badge");
	});

	it("applies the caller-supplied style", () => {
		render(<Badge style={{ backgroundColor: "red" }}>Urgent</Badge>);
		const badge = screen.getByText("Urgent");
		expect(badge.style.backgroundColor).toBe("red");
	});
});
