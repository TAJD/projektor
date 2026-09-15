import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "./Table";

describe("Table", () => {
	it("renders a table with the base class", () => {
		render(<Table>content</Table>);
		const table = screen.getByRole("table");
		expect(table.className).toBe("w-full border-collapse text-[0.9rem]");
	});

	it("passes through an extra class", () => {
		render(<Table class="extra">content</Table>);
		const table = screen.getByRole("table");
		expect(table.className).toBe("w-full border-collapse text-[0.9rem] extra");
	});
});

describe("TableHeaderCell", () => {
	it("renders a th with correct text and class", () => {
		render(
			<table>
				<thead>
					<tr>
						<TableHeaderCell>Name</TableHeaderCell>
					</tr>
				</thead>
			</table>
		);
		const header = screen.getByRole("columnheader", { name: "Name" });
		expect(header.className).toBe(
			"text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap"
		);
	});
});

describe("TableCell", () => {
	it("applies muted classes when muted=true", () => {
		render(
			<table>
				<tbody>
					<tr>
						<TableCell muted>Value</TableCell>
					</tr>
				</tbody>
			</table>
		);
		const cell = screen.getByRole("cell", { name: "Value" });
		expect(cell.className).toBe(
			"px-3 py-2 border-b border-border align-middle [tr:last-child_&]:border-b-0 font-mono text-[0.8rem] text-text-muted"
		);
	});

	it("does not apply muted classes when muted is omitted", () => {
		render(
			<table>
				<tbody>
					<tr>
						<TableCell>Value</TableCell>
					</tr>
				</tbody>
			</table>
		);
		const cell = screen.getByRole("cell", { name: "Value" });
		expect(cell.className).toBe(
			"px-3 py-2 border-b border-border align-middle [tr:last-child_&]:border-b-0"
		);
	});
});

describe("full table composition", () => {
	it("renders via Table/TableHead/TableBody/TableRow/TableHeaderCell/TableCell", () => {
		render(
			<Table>
				<TableHead>
					<TableRow>
						<TableHeaderCell>Name</TableHeaderCell>
						<TableHeaderCell>Scope</TableHeaderCell>
					</TableRow>
				</TableHead>
				<TableBody>
					<TableRow>
						<TableCell>Alice</TableCell>
						<TableCell>Admin</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);

		expect(screen.getByRole("table")).toBeTruthy();
		expect(screen.getAllByRole("columnheader")).toHaveLength(2);
		expect(screen.getAllByRole("cell")).toHaveLength(2);
	});

	it("forwards onClick on TableRow", () => {
		let clicked = false;
		render(
			<Table>
				<TableBody>
					<TableRow onClick={() => (clicked = true)}>
						<TableCell>Alice</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
		fireEvent.click(
			screen.getByRole("cell", { name: "Alice" }).closest("tr") as HTMLTableRowElement
		);
		expect(clicked).toBe(true);
	});
});
