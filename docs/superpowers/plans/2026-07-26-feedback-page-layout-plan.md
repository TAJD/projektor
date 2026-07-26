# Feedback Page Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat, stacked-islands `/feedback` page with a card-grid summary page (one card per feedback source + a "New source" card) and a dedicated `/feedback/[sourceId]` detail page with Items/Summary/Settings tabs.

**Architecture:** Split the three existing monolithic islands (`FeedbackSourceManager`, `FeedbackSummary`, `FeedbackList`) into five focused islands: `FeedbackSourceGrid` (top-level cards), `NewSourceModal` (create-source dialog), `FeedbackSourceDetail` (detail-page shell: header, source-switch dropdown, ARIA tabs), `FeedbackSourceSettings` (per-source token/status controls), plus adapted single-source versions of `FeedbackSummary` and `FeedbackList`. No backend changes — everything reuses existing endpoints.

**Tech Stack:** Astro (static output) + Preact islands, TypeScript, Vitest + @testing-library/preact, Tailwind utility classes.

## Global Constraints

- No backend/API/schema changes — reuse `GET/POST /api/projects/:id/feedback-sources`, `PATCH`/`rotate`/`DELETE` on `/feedback-sources/:sourceId`, `GET /api/projects/:id/feedback`, `GET /api/projects/:id/feedback/summary`.
- Reuse existing UI patterns: card grid (`ProjectList.tsx`), shared `Select` component, ARIA tabs pattern (`GroupManager.tsx`), dynamic-route-with-client-resolve pattern (issue detail page).
- `class` not `className` (Preact, matches existing codebase convention).
- Revoked sources stay visible (muted), never hidden.
- Every new/adapted component follows the existing desktop-table + `max-sm:` mobile-card convention where a table already exists; card-grid views are inherently responsive via `repeat(auto-fill, minmax(...))` and need no separate mobile variant.
- Test with `pnpm --filter @projektor/web test -- <path>` from the repo root.

---

### Task 1: `FeedbackSourceSettings` island — per-source token/status controls

**Files:**
- Create: `apps/web/src/islands/FeedbackSourceSettings.tsx`
- Test: `apps/web/src/islands/FeedbackSourceSettings.test.tsx`

**Interfaces:**
- Produces: `export interface FeedbackSource { id: string; name: string; description: string | null; isActive: boolean; allowedOrigins: string[] | null; tokenPreview: string; createdAt: number; revokedAt: number | null; }` and `export default function FeedbackSourceSettings(props: { source: FeedbackSource; projectId: string; workspaceSlug?: string; onChanged: () => void }): JSX.Element`. Task 6 (`FeedbackSourceDetail`) imports both the type and the component.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/FeedbackSourceSettings.test.tsx
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceSettings, { type FeedbackSource } from "./FeedbackSourceSettings";

const SOURCE: FeedbackSource = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

function stubFetch() {
	const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/rotate")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ token: "fbk_rotated_token" }),
			});
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackSourceSettings", () => {
	it("renders token preview and created date", () => {
		stubFetch();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={() => {}}
			/>
		);
		expect(screen.getByText("abcdef012345…")).toBeTruthy();
	});

	it("toggling active PATCHes isActive and calls onChanged", async () => {
		const fetchMock = stubFetch();
		const onChanged = vi.fn();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={onChanged}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /^Active$/i }));
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
		const call = fetchMock.mock.calls.find((c) => c[1]?.method === "PATCH");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ isActive: false });
	});

	it("rotating requires confirmation, then shows the new raw token once", async () => {
		stubFetch();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={() => {}}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /Rotate token/i }));
		fireEvent.click(screen.getByRole("button", { name: /^Yes$/i }));
		expect(await screen.findByText("fbk_rotated_token")).toBeTruthy();
		expect(screen.getByText(/won't be able to see it again/i)).toBeTruthy();
	});

	it("revoking DELETEs the source and calls onChanged", async () => {
		const fetchMock = stubFetch();
		const onChanged = vi.fn();
		render(
			<FeedbackSourceSettings
				source={SOURCE}
				projectId="p1"
				workspaceSlug="my-ws"
				onChanged={onChanged}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: /Revoke source/i }));
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(fetchMock.mock.calls.some((c) => c[1]?.method === "DELETE")).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceSettings.test.tsx`
Expected: FAIL — `Cannot find module './FeedbackSourceSettings'`

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/FeedbackSourceSettings.tsx
import { useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

export interface FeedbackSource {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

interface Props {
	source: FeedbackSource;
	projectId: string;
	workspaceSlug?: string;
	onChanged: () => void;
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

export default function FeedbackSourceSettings({
	source,
	projectId,
	workspaceSlug,
	onChanged,
}: Props) {
	const [rotating, setRotating] = useState(false);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function toggleActive() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback-sources/${source.id}`, {
				method: "PATCH",
				workspaceSlug,
				body: { isActive: !source.isActive },
			});
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	async function confirmRotate() {
		try {
			const result = await apiFetch<{ token: string }>(
				`/api/projects/${projectId}/feedback-sources/${source.id}/rotate`,
				{ method: "POST", workspaceSlug }
			);
			setRotating(false);
			setNewToken(result.token);
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	async function revoke() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback-sources/${source.id}`, {
				method: "DELETE",
				workspaceSlug,
			});
			onChanged();
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<section class="flex flex-col gap-4 max-w-[520px]">
			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}

			{newToken && (
				<div class="bg-surface border border-border rounded-md p-4">
					<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
						⚠ Copy this token now — you won't be able to see it again.
					</p>
					<code class="block font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded break-all">
						{newToken}
					</code>
					<button
						type="button"
						class="btn btn-outline btn-sm mt-2"
						onClick={() => setNewToken(null)}
					>
						Done
					</button>
				</div>
			)}

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Token</span>
				<code class="font-mono text-[0.85rem]">{source.tokenPreview}</code>
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Status</span>
				<button type="button" class="btn btn-outline btn-sm w-fit" onClick={toggleActive}>
					{source.isActive ? "Active" : "Inactive"}
				</button>
			</div>

			<div class="flex flex-col gap-1">
				<span class="text-[0.8rem] font-semibold text-text-muted">Created</span>
				<span class="text-[0.875rem] text-text-base">{formatDate(source.createdAt)}</span>
			</div>

			<div class="flex flex-col gap-2">
				<span class="text-[0.8rem] font-semibold text-text-muted">Danger zone</span>
				{rotating ? (
					<span class="inline-flex gap-[0.375rem] items-center flex-wrap">
						<span class="text-[0.8rem] text-text-muted">Rotate? Old token dies.</span>
						<button type="button" class="btn btn-danger btn-sm" onClick={confirmRotate}>
							Yes
						</button>
						<button type="button" class="btn btn-outline btn-sm" onClick={() => setRotating(false)}>
							No
						</button>
					</span>
				) : (
					<span class="inline-flex gap-[0.375rem]">
						<button type="button" class="btn btn-outline btn-sm" onClick={() => setRotating(true)}>
							Rotate token
						</button>
						<button
							type="button"
							class="btn btn-outline btn-sm text-[var(--danger-text)] border-[var(--danger-border)]"
							onClick={revoke}
						>
							Revoke source
						</button>
					</span>
				)}
			</div>
		</section>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceSettings.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/FeedbackSourceSettings.tsx apps/web/src/islands/FeedbackSourceSettings.test.tsx
git commit -m "feat(web): add FeedbackSourceSettings island for per-source token/status controls"
```

---

### Task 2: `NewSourceModal` island — create-source dialog

**Files:**
- Create: `apps/web/src/islands/NewSourceModal.tsx`
- Test: `apps/web/src/islands/NewSourceModal.test.tsx`

**Interfaces:**
- Produces: `export default function NewSourceModal(props: { projectId: string; workspaceSlug?: string; onClose: () => void; onCreated: () => void }): JSX.Element`. Task 3 (`FeedbackSourceGrid`) renders this component.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/NewSourceModal.test.tsx
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
		render(<NewSourceModal projectId="p1" workspaceSlug="my-ws" onClose={() => {}} onCreated={() => {}} />);
		expect(screen.getByRole("button", { name: /Create source/i })).toBeDisabled();
		fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: "NPS" } });
		expect(screen.getByRole("button", { name: /Create source/i })).not.toBeDisabled();
	});

	it("creating a source shows the raw token once and calls onCreated", async () => {
		stubFetch();
		const onCreated = vi.fn();
		render(
			<NewSourceModal projectId="p1" workspaceSlug="my-ws" onClose={() => {}} onCreated={onCreated} />
		);
		fireEvent.input(screen.getByLabelText(/Name/i), { target: { value: "NPS" } });
		fireEvent.click(screen.getByRole("button", { name: /Create source/i }));
		expect(await screen.findByText("fbk_rawtoken_shown_once")).toBeTruthy();
		expect(onCreated).toHaveBeenCalled();
	});

	it("clicking Cancel calls onClose without creating a source", () => {
		const fetchMock = stubFetch();
		const onClose = vi.fn();
		render(<NewSourceModal projectId="p1" workspaceSlug="my-ws" onClose={onClose} onCreated={() => {}} />);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/NewSourceModal.test.tsx`
Expected: FAIL — `Cannot find module './NewSourceModal'`

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/NewSourceModal.tsx
import { useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface Props {
	projectId: string;
	workspaceSlug?: string;
	onClose: () => void;
	onCreated: () => void;
}

interface NewSourceResult {
	id: string;
	token: string;
}

function parseOrigins(raw: string): string[] | undefined {
	const list = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

const INPUT_CLASS =
	"w-full px-[0.625rem] py-[0.4rem] border border-border rounded text-[0.875rem] bg-bg text-text-base " +
	"font-[inherit] focus:outline-[2px] focus:outline-accent focus:outline-offset-1";

export default function NewSourceModal({ projectId, workspaceSlug, onClose, onCreated }: Props) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [origins, setOrigins] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [newToken, setNewToken] = useState<string | null>(null);

	async function handleCreate(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;
		setCreating(true);
		setError(null);
		try {
			const body: Record<string, unknown> = { name: name.trim() };
			if (description.trim()) body.description = description.trim();
			const parsed = parseOrigins(origins);
			if (parsed) body.allowedOrigins = parsed;
			const result = await apiFetch<NewSourceResult>(
				`/api/projects/${projectId}/feedback-sources`,
				{ method: "POST", workspaceSlug, body }
			);
			setNewToken(result.token);
			onCreated();
		} catch (e) {
			setError(String(e));
		} finally {
			setCreating(false);
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<div
			class="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/40 max-sm:items-end max-sm:pt-0"
			onClick={(e) => {
				if (e.target === e.currentTarget && !newToken) onClose();
			}}
		>
			<div
				class={[
					"bg-bg border border-border rounded-lg p-6 w-full max-w-[480px] max-h-[80vh] overflow-y-auto mx-4",
					"max-sm:rounded-t-lg max-sm:rounded-b-none max-sm:max-h-[90vh] max-sm:mx-0",
				].join(" ")}
				role="dialog"
				aria-modal="true"
				aria-label="New feedback source"
			>
				<h2 class="mb-5 text-lg font-bold text-text-base">New feedback source</h2>

				{newToken ? (
					<div class="bg-surface border border-border rounded-md p-4">
						<p class="text-[var(--danger-text)] text-[0.8rem] my-1">
							⚠ Copy this token now — you won't be able to see it again.
						</p>
						<code class="block font-mono text-[0.8rem] px-2 py-[0.375rem] bg-bg border border-border rounded break-all">
							{newToken}
						</code>
						<button type="button" class="btn btn-primary btn-sm mt-3" onClick={onClose}>
							Done
						</button>
					</div>
				) : (
					<form onSubmit={handleCreate}>
						{error && (
							<p role="alert" class="text-[var(--danger-text)] mb-3 text-sm">
								{error}
							</p>
						)}
						<div class="mb-[0.875rem]">
							<label
								class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
								for="fs-name"
							>
								Name *
							</label>
							<input
								id="fs-name"
								class={INPUT_CLASS}
								value={name}
								onInput={(e) => setName((e.target as HTMLInputElement).value)}
								required
								maxLength={100}
								// biome-ignore lint/a11y/noAutofocus: intentional — modal opens on user action
								autoFocus
							/>
						</div>
						<div class="mb-[0.875rem]">
							<label
								class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
								for="fs-desc"
							>
								Description
							</label>
							<input
								id="fs-desc"
								class={INPUT_CLASS}
								value={description}
								onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
								maxLength={500}
							/>
						</div>
						<div class="mb-[0.875rem]">
							<label
								class="block text-[0.78rem] font-semibold text-text-muted mb-[0.3rem] uppercase tracking-[0.04em]"
								for="fs-origins"
							>
								Allowed origins (one per line, optional)
							</label>
							<textarea
								id="fs-origins"
								class={INPUT_CLASS}
								rows={2}
								value={origins}
								onInput={(e) => setOrigins((e.target as HTMLTextAreaElement).value)}
							/>
						</div>
						<div class="flex gap-2">
							<button
								type="submit"
								class="btn btn-primary btn-sm"
								disabled={creating || !name.trim()}
							>
								{creating ? "Creating…" : "Create source"}
							</button>
							<button
								type="button"
								class="btn btn-outline btn-sm"
								onClick={onClose}
								disabled={creating}
							>
								Cancel
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/NewSourceModal.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/NewSourceModal.tsx apps/web/src/islands/NewSourceModal.test.tsx
git commit -m "feat(web): add NewSourceModal island for creating feedback sources"
```

---

### Task 3: `FeedbackSourceGrid` island — top-level card grid

**Files:**
- Create: `apps/web/src/islands/FeedbackSourceGrid.tsx`
- Test: `apps/web/src/islands/FeedbackSourceGrid.test.tsx`

**Interfaces:**
- Consumes: `NewSourceModal` from Task 2 (`{ projectId, workspaceSlug, onClose, onCreated }`).
- Produces: `export default function FeedbackSourceGrid(props: { workspaceSlug?: string; projectId?: string }): JSX.Element`. Task 7 (`feedback.astro`) renders this as the page body.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/FeedbackSourceGrid.test.tsx
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceGrid from "./FeedbackSourceGrid";

const ACTIVE_SOURCE = {
	id: "s1",
	name: "Onboarding survey",
	description: "post-signup",
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

const REVOKED_SOURCE = {
	id: "s2",
	name: "Old widget",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "ffffff000000…",
	createdAt: 900,
	revokedAt: 2000,
};

const SUMMARY = [
	{
		sourceId: "s1",
		sourceName: "Onboarding survey",
		totalCount: 5,
		versions: [{ appVersion: "v1", totalCount: 5, withCommentCount: 1, thumbsUpPct: 80, avgFiveStar: null, lastSeenAt: 5000 }],
	},
];

function stubFetch(sources = [ACTIVE_SOURCE, REVOKED_SOURCE], summary = SUMMARY) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/feedback/summary")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(summary) });
			}
			if (u.includes("/feedback-sources")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		})
	);
}

describe("FeedbackSourceGrid", () => {
	it("renders a card per source with volume and status, plus a New source card", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText("Onboarding survey")).toBeTruthy();
		expect(screen.getByText("5 total")).toBeTruthy();
		expect(screen.getByText("Old widget")).toBeTruthy();
		expect(screen.getByText("No feedback yet")).toBeTruthy();
		expect(screen.getByRole("button", { name: /New source/i })).toBeTruthy();
	});

	it("links each card to its detail page", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		const link = (await screen.findByText("Onboarding survey")).closest("a");
		expect(link?.getAttribute("href")).toBe("/feedback/s1");
	});

	it("marks a revoked source as Revoked", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Old widget");
		expect(screen.getByText("Revoked")).toBeTruthy();
	});

	it("opens the New source modal on click", async () => {
		stubFetch();
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		await screen.findByText("Onboarding survey");
		fireEvent.click(screen.getByRole("button", { name: /New source/i }));
		expect(screen.getByRole("dialog", { name: /New feedback source/i })).toBeTruthy();
	});

	it("renders an access-denied notice on a 403 list response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() =>
				Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
			)
		);
		render(<FeedbackSourceGrid workspaceSlug="my-ws" projectId="p1" />);
		expect(await screen.findByText(/Only workspace owners and admins/i)).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceGrid.test.tsx`
Expected: FAIL — `Cannot find module './FeedbackSourceGrid'`

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/FeedbackSourceGrid.tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import NewSourceModal from "./NewSourceModal";

interface FeedbackSource {
	id: string;
	name: string;
	description: string | null;
	isActive: boolean;
	allowedOrigins: string[] | null;
	tokenPreview: string;
	createdAt: number;
	revokedAt: number | null;
}

interface SourceVersionSummary {
	appVersion: string | null;
	totalCount: number;
	withCommentCount: number;
	thumbsUpPct: number | null;
	avgFiveStar: number | null;
	lastSeenAt: number;
}

interface SourceSummary {
	sourceId: string;
	sourceName: string | null;
	totalCount: number;
	versions: SourceVersionSummary[];
}

interface Props {
	workspaceSlug?: string;
	projectId?: string;
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

function statusLabel(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "Revoked";
	return s.isActive ? "Active" : "Inactive";
}

function statusClass(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "opacity-60";
	return s.isActive ? "" : "opacity-75";
}

const CARD_CLASS =
	"flex flex-col gap-2 p-4 bg-surface border border-border rounded-lg no-underline shadow-sm " +
	"transition-all duration-150 hover:border-accent hover:-translate-y-px";

function SourceCard({ source, summary }: { source: FeedbackSource; summary?: SourceSummary }) {
	const total = summary?.totalCount ?? 0;
	const lastSeenAt = summary?.versions.reduce((max, v) => Math.max(max, v.lastSeenAt), 0) ?? 0;
	return (
		<a href={`/feedback/${source.id}`} class={`${CARD_CLASS} ${statusClass(source)}`}>
			<div class="flex items-center justify-between gap-2">
				<span class="font-bold text-text-base">{source.name}</span>
				<span class="text-[0.7rem] font-medium px-1.5 py-0.5 rounded bg-bg border border-border text-text-muted">
					{statusLabel(source)}
				</span>
			</div>
			<span class="text-xs text-text-muted">{total === 0 ? "No feedback yet" : `${total} total`}</span>
			<span class="text-xs text-text-muted">
				{lastSeenAt > 0 ? `Last activity ${formatDate(lastSeenAt)}` : "No activity yet"}
			</span>
		</a>
	);
}

function NewSourceCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			class={`${CARD_CLASS} items-center justify-center text-text-muted font-medium min-h-[104px] cursor-pointer`}
		>
			+ New source
		</button>
	);
}

export default function FeedbackSourceGrid({ workspaceSlug, projectId: projectIdProp }: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);

	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [summaries, setSummaries] = useState<SourceSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(false);

	const fetchAll = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		setForbidden(false);
		try {
			const [sourcesData, summaryData] = await Promise.all([
				apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, { workspaceSlug }),
				apiFetch<SourceSummary[]>(`/api/projects/${projectId}/feedback/summary`, { workspaceSlug }),
			]);
			setSources(Array.isArray(sourcesData) ? sourcesData : []);
			setSummaries(Array.isArray(summaryData) ? summaryData : []);
		} catch (e) {
			if (String(e).includes(": 403")) setForbidden(true);
			else setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, workspaceSlug]);

	useEffect(() => {
		fetchAll();
	}, [fetchAll]);

	if (loading) return <p aria-live="polite">Loading feedback sources…</p>;
	if (forbidden) {
		return (
			<div class="p-4 bg-surface border border-border rounded-md text-text-muted">
				<strong>Access denied.</strong> Only workspace owners and admins can manage feedback sources.
			</div>
		);
	}
	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				Failed to load feedback sources: {error}
			</p>
		);
	}

	const summaryBySource = new Map(summaries.map((s) => [s.sourceId, s]));

	return (
		<section>
			<h1 class="text-xl font-bold text-text-base mb-4">Feedback sources</h1>
			<div class="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
				{sources.map((s) => (
					<SourceCard key={s.id} source={s} summary={summaryBySource.get(s.id)} />
				))}
				<NewSourceCard onClick={() => setShowCreate(true)} />
			</div>
			{showCreate && (
				<NewSourceModal
					projectId={projectId}
					workspaceSlug={workspaceSlug}
					onClose={() => setShowCreate(false)}
					onCreated={fetchAll}
				/>
			)}
		</section>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceGrid.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/FeedbackSourceGrid.tsx apps/web/src/islands/FeedbackSourceGrid.test.tsx
git commit -m "feat(web): add FeedbackSourceGrid island for the feedback summary page"
```

---

### Task 4: Scope `FeedbackSummary` to a single source

**Files:**
- Modify: `apps/web/src/islands/FeedbackSummary.tsx` (full rewrite)
- Modify: `apps/web/src/islands/FeedbackSummary.test.tsx` (full rewrite)

**Interfaces:**
- Produces: `export default function FeedbackSummary(props: { workspaceSlug?: string; projectId: string; sourceId: string }): JSX.Element`. Task 6 (`FeedbackSourceDetail`) renders this in the Summary tab.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/FeedbackSummary.test.tsx (replaces the existing file)
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSummary from "./FeedbackSummary";

const SUMMARY = [
	{
		sourceId: "s1",
		sourceName: "Onboarding survey",
		totalCount: 3,
		versions: [
			{
				appVersion: "v1.1.0",
				totalCount: 2,
				withCommentCount: 1,
				thumbsUpPct: null,
				avgFiveStar: 4.5,
				lastSeenAt: 200,
			},
			{
				appVersion: null,
				totalCount: 1,
				withCommentCount: 0,
				thumbsUpPct: 100,
				avgFiveStar: null,
				lastSeenAt: 100,
			},
		],
	},
	{
		sourceId: "s2",
		sourceName: "Other source",
		totalCount: 99,
		versions: [
			{ appVersion: "v9", totalCount: 99, withCommentCount: 0, thumbsUpPct: null, avgFiveStar: null, lastSeenAt: 999 },
		],
	},
];

function stubFetch(data: unknown = SUMMARY) {
	const fetchMock = vi
		.fn()
		.mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve(data) }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("FeedbackSummary", () => {
	it("renders only the requested source's total count, ignoring other sources", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect(await screen.findByText(/3 total/i)).toBeTruthy();
		expect(screen.queryByText(/99 total/i)).toBeNull();
	});

	it("renders avg star rating and comment count for a version", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByText(/3 total/i);
		expect(screen.getByText(/v1\.1\.0/)).toBeTruthy();
		expect(screen.getByText(/4\.5★ avg/)).toBeTruthy();
		expect(screen.getByText(/1 with comments/)).toBeTruthy();
	});

	it("renders thumbs-up % and falls back to 'Unknown version' for a null appVersion", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByText(/3 total/i);
		expect(screen.getByText(/Unknown version/i)).toBeTruthy();
		expect(screen.getByText(/👍 100%/)).toBeTruthy();
	});

	it("hides the comment-count badge when a version has no written feedback", async () => {
		stubFetch();
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByText("Unknown version");
		expect(screen.queryByText(/0 with comments/)).toBeNull();
	});

	it("shows an empty state when the source has no summary entry", async () => {
		stubFetch([]);
		render(<FeedbackSummary workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect(await screen.findByText(/No feedback yet/i)).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSummary.test.tsx`
Expected: FAIL — the current component has no required `sourceId` prop / doesn't filter, so "renders only the requested source's total count" fails (both totals render).

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/FeedbackSummary.tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

interface VersionSummary {
	appVersion: string | null;
	totalCount: number;
	withCommentCount: number;
	thumbsUpPct: number | null;
	avgFiveStar: number | null;
	lastSeenAt: number;
}

interface SourceSummary {
	sourceId: string;
	sourceName: string | null;
	totalCount: number;
	versions: VersionSummary[];
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
	sourceId: string;
}

function versionMetric(v: VersionSummary): string {
	const parts: string[] = [];
	if (v.thumbsUpPct !== null) parts.push(`👍 ${v.thumbsUpPct}%`);
	if (v.avgFiveStar !== null) parts.push(`${v.avgFiveStar.toFixed(1)}★ avg`);
	if (parts.length === 0) parts.push("No ratings");
	return parts.join(" · ");
}

export default function FeedbackSummary({ workspaceSlug, projectId, sourceId }: Props) {
	const [summary, setSummary] = useState<SourceSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchSummary = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<SourceSummary[]>(`/api/projects/${projectId}/feedback/summary`, {
				workspaceSlug,
			});
			const list = Array.isArray(data) ? data : [];
			setSummary(list.find((s) => s.sourceId === sourceId) ?? null);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, sourceId, workspaceSlug]);

	useEffect(() => {
		fetchSummary();
	}, [fetchSummary]);

	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	}
	if (loading) return <p aria-live="polite">Loading summary…</p>;
	if (!summary || summary.versions.length === 0) {
		return (
			<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
				No feedback yet.
			</div>
		);
	}

	return (
		<section class="flex flex-col gap-4">
			<div class="bg-surface rounded-lg border border-border p-4">
				<div class="flex items-baseline gap-2 mb-2">
					<span class="text-[0.8rem] text-text-muted">{summary.totalCount} total</span>
				</div>
				<ul class="flex flex-col gap-1">
					{summary.versions.map((v) => (
						<li
							key={v.appVersion ?? "unknown"}
							class="flex flex-wrap gap-x-3 text-[0.875rem] text-text-muted"
						>
							<span class="font-medium text-text-base">{v.appVersion ?? "Unknown version"}</span>
							<span>{versionMetric(v)}</span>
							{v.withCommentCount > 0 && <span>{v.withCommentCount} with comments</span>}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSummary.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/FeedbackSummary.tsx apps/web/src/islands/FeedbackSummary.test.tsx
git commit -m "refactor(web): scope FeedbackSummary to a single source"
```

---

### Task 5: Scope `FeedbackList` to a single source and swap the status filter to `Select`

**Files:**
- Modify: `apps/web/src/islands/FeedbackList.tsx` (full rewrite)
- Modify: `apps/web/src/islands/FeedbackList.test.tsx` (full rewrite)

**Interfaces:**
- Consumes: `Select` from `apps/web/src/islands/Select.tsx` (`{ value, options, onChange, ariaLabel }`, existing component, unchanged).
- Produces: `export default function FeedbackList(props: { workspaceSlug?: string; projectId: string; sourceId: string }): JSX.Element`. Task 6 (`FeedbackSourceDetail`) renders this in the Items tab.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/FeedbackList.test.tsx (replaces the existing file)
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_WIDTH, setViewportWidth } from "../test/viewport";
import FeedbackList from "./FeedbackList";

const ROW = {
	id: "f1",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: 5,
	ratingScale: "five_star",
	body: "Great onboarding",
	submitterLabel: "a@b.com",
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1000,
};

const ROW_2 = {
	id: "f2",
	sourceId: "s1",
	sourceName: "Onboarding survey",
	rating: -1,
	ratingScale: "thumbs",
	body: "Confusing step",
	submitterLabel: null,
	sourceUrl: null,
	appVersion: null,
	status: "new",
	linkedIssueId: null,
	createdAt: 1001,
};

function stubFetch(rows: unknown[] = [ROW, ROW_2], bulkConvertStatus = 201) {
	const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/bulk-convert-to-issue")) {
			if (bulkConvertStatus !== 201) {
				return Promise.resolve({
					ok: false,
					status: bulkConvertStatus,
					json: () => Promise.resolve({ error: "Conflict" }),
				});
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ id: "issue-1", convertedCount: 2 }),
			});
		}
		if (u.includes("/bulk-mark-reviewed")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ updated: 2 }) });
		}
		if (u.includes("/convert-to-issue")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "issue-1" }) });
		}
		if (u.includes("/feedback")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function table() {
	return within(screen.getByRole("table"));
}

describe("FeedbackList", () => {
	it("renders feedback rows with body, scoped to the given source", async () => {
		const fetchMock = stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect((await screen.findAllByText("Great onboarding")).length).toBeGreaterThan(0);
		expect(String(fetchMock.mock.calls[0][0])).toContain("sourceId=s1");
	});

	it("changing the status filter refetches with the status query param", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
		fireEvent.click(screen.getByRole("option", { name: "Reviewed" }));
		await waitFor(() => {
			expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("status=reviewed"))).toBe(
				true
			);
		});
	});

	it("mark-reviewed PATCHes with status reviewed and refetches", async () => {
		const fetchMock = stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(table().getByRole("button", { name: /Mark reviewed/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					const body = call[1]?.body ? JSON.parse(String(call[1].body)) : null;
					return (
						String(call[0]).includes("/feedback/f1") &&
						call[1]?.method === "PATCH" &&
						body?.status === "reviewed"
					);
				})
			).toBe(true);
		});
	});

	it("convert-to-issue POSTs and refetches", async () => {
		const fetchMock = stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(table().getByRole("button", { name: /Convert to issue/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					(call) => String(call[0]).includes("/convert-to-issue") && call[1]?.method === "POST"
				)
			).toBe(true);
		});
	});

	it("select-all then bulk mark-reviewed POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Mark all reviewed$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-mark-reviewed")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.length === 2 && call[1]?.method === "POST";
				})
			).toBe(true);
		});
	});

	it("select-all then bulk convert-to-issue POSTs both ids and refetches", async () => {
		const fetchMock = stubFetch();
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some((call) => {
					if (!String(call[0]).includes("/bulk-convert-to-issue")) return false;
					const body = JSON.parse(String(call[1]?.body));
					return body.feedbackIds.includes("f1") && body.feedbackIds.includes("f2");
				})
			).toBe(true);
		});
	});

	it("shows an error and keeps the selection when bulk convert-to-issue conflicts", async () => {
		stubFetch([ROW, ROW_2], 409);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		fireEvent.click(screen.getByLabelText(/select all/i));
		fireEvent.click(screen.getByRole("button", { name: /^Convert all to issue$/i }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/2 selected/i)).toBeTruthy();
	});
});

describe("FeedbackList — mobile viewport", () => {
	it("renders a mobile-card fallback alongside the desktop table", async () => {
		setViewportWidth(MOBILE_WIDTH);
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect((await screen.findAllByText("Great onboarding")).length).toBe(2);
	});
});

const ROW_WITH_CONTEXT = {
	...ROW,
	id: "f3",
	sourceUrl: "https://ironvolume.example.com/wod?seed=abc123&focus=strength",
};

const ROW_BARE_URL = { ...ROW, id: "f4", sourceUrl: "https://ironvolume.example.com/wod" };
const ROW_MALFORMED_URL = { ...ROW, id: "f5", sourceUrl: "not a url" };
const ROW_JS_URL = { ...ROW, id: "f6", sourceUrl: "javascript:alert(1)" };

describe("FeedbackList structured context", () => {
	it("shows a Context toggle with the param count and expands to reveal params + raw link", async () => {
		stubFetch([ROW_WITH_CONTEXT]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		const toggle = table().getByRole("button", { name: /Context \(2\)/i });
		expect(screen.queryByText(/seed:/i)).toBeNull();
		fireEvent.click(toggle);
		expect(table().getByText(/seed:\s*abc123/i)).toBeTruthy();
		expect(table().getByText(/focus:\s*strength/i)).toBeTruthy();
		expect(table().getByRole("link", { name: ROW_WITH_CONTEXT.sourceUrl })).toBeTruthy();
	});

	it("shows a Context (0) toggle for a sourceUrl with no query string, expanding to just the raw link", async () => {
		stubFetch([ROW_BARE_URL]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		const toggle = table().getByRole("button", { name: /Context \(0\)/i });
		fireEvent.click(toggle);
		expect(table().getByRole("link", { name: ROW_BARE_URL.sourceUrl })).toBeTruthy();
	});

	it("renders no Context toggle when sourceUrl is null", async () => {
		stubFetch([ROW]);
		render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});

	it("renders no Context toggle for a malformed sourceUrl, without throwing", async () => {
		stubFetch([ROW_MALFORMED_URL]);
		expect(() =>
			render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />)
		).not.toThrow();
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});

	it("renders no Context toggle for a javascript: sourceUrl, without throwing", async () => {
		stubFetch([ROW_JS_URL]);
		expect(() =>
			render(<FeedbackList workspaceSlug="my-ws" projectId="p1" sourceId="s1" />)
		).not.toThrow();
		await screen.findAllByText("Great onboarding");
		expect(table().queryByRole("button", { name: /Context/i })).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackList.test.tsx`
Expected: FAIL — `sourceId` prop isn't required/used yet, and `getByRole("combobox", { name: "Status" })` doesn't match the current native `<select>`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/FeedbackList.tsx
import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import Select from "./Select";

interface Feedback {
	id: string;
	sourceId: string;
	sourceName: string | null;
	rating: number | null;
	ratingScale: string | null;
	body: string | null;
	submitterLabel: string | null;
	sourceUrl: string | null;
	appVersion: string | null;
	status: string;
	linkedIssueId: string | null;
	createdAt: number;
}

interface Props {
	workspaceSlug?: string;
	projectId: string;
	sourceId: string;
}

const STATUS_OPTIONS = [
	{ value: "", label: "All" },
	{ value: "new", label: "New" },
	{ value: "reviewed", label: "Reviewed" },
	{ value: "actioned", label: "Actioned" },
];

const TD = "px-3 py-2 border-b border-border align-top text-[0.875rem]";
const TH = "text-left px-3 py-2 border-b-2 border-border font-semibold text-text-base whitespace-nowrap";

function ratingDisplay(rating: number | null, scale: string | null): string {
	if (rating === null) return "—";
	if (scale === "thumbs") return rating > 0 ? "👍" : "👎";
	return "★".repeat(Math.max(0, Math.min(5, rating)));
}

function formatDate(ts: number): string {
	return new Date(ts * 1000).toLocaleDateString();
}

function parseContext(sourceUrl: string | null): { url: string; params: [string, string][] } | null {
	if (!sourceUrl) return null;
	try {
		const parsed = new URL(sourceUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return { url: sourceUrl, params: Array.from(parsed.searchParams.entries()) };
	} catch {
		return null;
	}
}

function FeedbackContext({ row, expanded, onToggle }: { row: Feedback; expanded: boolean; onToggle: () => void }) {
	const context = parseContext(row.sourceUrl);
	if (!context) return null;
	return (
		<div class="mt-1">
			<button type="button" class="text-[0.75rem] text-text-muted underline" onClick={onToggle}>
				Context ({context.params.length})
			</button>
			{expanded && (
				<div class="text-[0.75rem] text-text-muted mt-1 flex flex-col gap-0.5">
					<a href={context.url} target="_blank" rel="noopener noreferrer" class="underline">
						{context.url}
					</a>
					{context.params.map(([key, value]) => (
						<div key={key}>
							{key}: {value}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function FeedbackRowActions({
	row,
	onMarkReviewed,
	onConvert,
}: {
	row: Feedback;
	onMarkReviewed: (id: string) => void;
	onConvert: (id: string) => void;
}) {
	return (
		<div class="flex gap-2 flex-wrap">
			{row.status === "new" && (
				<button type="button" class="btn btn-outline btn-sm" onClick={() => onMarkReviewed(row.id)}>
					Mark reviewed
				</button>
			)}
			{row.linkedIssueId ? (
				<span class="text-[0.8rem] text-text-muted">Linked</span>
			) : (
				<button type="button" class="btn btn-outline btn-sm" onClick={() => onConvert(row.id)}>
					Convert to issue
				</button>
			)}
		</div>
	);
}

interface FeedbackMobileCardsProps {
	rows: Feedback[];
	selected: Set<string>;
	expanded: Set<string>;
	onToggleRow: (id: string) => void;
	onToggleExpanded: (id: string) => void;
	onMarkReviewed: (id: string) => void;
	onConvert: (id: string) => void;
}

function FeedbackMobileCards({
	rows,
	selected,
	expanded,
	onToggleRow,
	onToggleExpanded,
	onMarkReviewed,
	onConvert,
}: FeedbackMobileCardsProps) {
	return (
		<div class="hidden max-sm:flex max-sm:flex-col max-sm:gap-3">
			{rows.map((r) => (
				<div key={r.id} class="py-3 px-4 border border-border rounded-md bg-surface">
					<div class="flex items-start gap-2 mb-2">
						<input
							type="checkbox"
							aria-label={`select row ${r.id}`}
							checked={selected.has(r.id)}
							onChange={() => onToggleRow(r.id)}
							class="mt-1"
						/>
						<div class="flex-1">
							<div class="flex justify-between items-center gap-2 mb-1">
								<span class="text-[0.9rem]">{ratingDisplay(r.rating, r.ratingScale)}</span>
								<span class="text-[0.75rem] text-text-muted">{formatDate(r.createdAt)}</span>
							</div>
							<div class="text-[0.875rem] text-text-base">{r.body ?? "—"}</div>
							{r.submitterLabel && (
								<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
							)}
							<FeedbackContext row={r} expanded={expanded.has(r.id)} onToggle={() => onToggleExpanded(r.id)} />
							<div class="text-[0.75rem] text-text-muted mt-1">{r.status}</div>
						</div>
					</div>
					<FeedbackRowActions row={r} onMarkReviewed={onMarkReviewed} onConvert={onConvert} />
				</div>
			))}
		</div>
	);
}

export default function FeedbackList({ workspaceSlug, projectId, sourceId }: Props) {
	const [rows, setRows] = useState<Feedback[]>([]);
	const [status, setStatus] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const fetchRows = useCallback(async () => {
		if (!projectId || !sourceId) return;
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams({ sourceId });
			if (status) params.set("status", status);
			const data = await apiFetch<Feedback[]>(
				`/api/projects/${projectId}/feedback?${params.toString()}`,
				{ workspaceSlug }
			);
			setRows(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, sourceId, status, workspaceSlug]);

	useEffect(() => {
		fetchRows();
	}, [fetchRows]);

	async function convert(id: string) {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/${id}/convert-to-issue`, {
				method: "POST",
				workspaceSlug,
			});
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function markReviewed(id: string) {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/${id}`, {
				method: "PATCH",
				body: { status: "reviewed" },
				workspaceSlug,
			});
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function bulkMarkReviewed() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-mark-reviewed`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	async function bulkConvertToIssue() {
		try {
			await apiFetch(`/api/projects/${projectId}/feedback/bulk-convert-to-issue`, {
				method: "POST",
				body: { feedbackIds: Array.from(selected) },
				workspaceSlug,
			});
			setSelected(new Set());
			await fetchRows();
		} catch (e) {
			setError(String(e));
		}
	}

	function toggleSelectAll() {
		setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
	}

	function toggleRow(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function toggleExpanded(id: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	return (
		<section>
			<div class="flex gap-4 items-end mb-4">
				<div class="flex flex-col gap-1">
					<span class="text-[0.8rem] font-semibold text-text-muted">Status</span>
					<Select
						ariaLabel="Status"
						value={status}
						onChange={(v) => {
							setStatus(v);
							setSelected(new Set());
						}}
						options={STATUS_OPTIONS}
					/>
				</div>
			</div>

			{error && (
				<p role="alert" class="text-[var(--danger-text)]">
					{error}
				</p>
			)}
			{selected.size > 0 && (
				<div class="flex gap-2 items-center mb-3 p-2 bg-surface border border-border rounded">
					<span class="text-[0.85rem] text-text-muted">{selected.size} selected</span>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkMarkReviewed}>
						Mark all reviewed
					</button>
					<button type="button" class="btn btn-outline btn-sm" onClick={bulkConvertToIssue}>
						Convert all to issue
					</button>
				</div>
			)}
			{loading ? (
				<p aria-live="polite">Loading feedback…</p>
			) : rows.length === 0 ? (
				<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
					No feedback yet.
				</div>
			) : (
				<>
					<div class="overflow-x-auto max-sm:hidden">
						<table class="w-full border-collapse text-[0.9rem]">
							<thead>
								<tr>
									<th class={TH}>
										<input
											type="checkbox"
											aria-label="select all"
											checked={rows.length > 0 && selected.size === rows.length}
											onChange={toggleSelectAll}
										/>
									</th>
									<th class={TH}>Rating</th>
									<th class={TH}>Feedback</th>
									<th class={TH}>Status</th>
									<th class={TH}>Received</th>
									<th class={TH}></th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => (
									<tr key={r.id}>
										<td class={TD}>
											<input
												type="checkbox"
												aria-label={`select row ${r.id}`}
												checked={selected.has(r.id)}
												onChange={() => toggleRow(r.id)}
											/>
										</td>
										<td class={TD}>{ratingDisplay(r.rating, r.ratingScale)}</td>
										<td class={`${TD} text-text-base`}>
											<div>{r.body ?? "—"}</div>
											{r.submitterLabel && (
												<div class="text-[0.75rem] text-text-muted mt-1">{r.submitterLabel}</div>
											)}
											<FeedbackContext row={r} expanded={expanded.has(r.id)} onToggle={() => toggleExpanded(r.id)} />
										</td>
										<td class={`${TD} text-text-muted`}>{r.status}</td>
										<td class={`${TD} text-text-muted`}>{formatDate(r.createdAt)}</td>
										<td class={`${TD} whitespace-nowrap`}>
											<FeedbackRowActions row={r} onMarkReviewed={markReviewed} onConvert={convert} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<FeedbackMobileCards
						rows={rows}
						selected={selected}
						expanded={expanded}
						onToggleRow={toggleRow}
						onToggleExpanded={toggleExpanded}
						onMarkReviewed={markReviewed}
						onConvert={convert}
					/>
				</>
			)}
		</section>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackList.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/FeedbackList.tsx apps/web/src/islands/FeedbackList.test.tsx
git commit -m "refactor(web): scope FeedbackList to a single source, use shared Select for status filter"
```

---

### Task 6: `FeedbackSourceDetail` island — detail-page shell (header + dropdown + tabs)

**Files:**
- Create: `apps/web/src/islands/FeedbackSourceDetail.tsx`
- Test: `apps/web/src/islands/FeedbackSourceDetail.test.tsx`

**Interfaces:**
- Consumes: `FeedbackSourceSettings`/`FeedbackSource` from Task 1, `FeedbackSummary` from Task 4 (`{ workspaceSlug, projectId, sourceId }`), `FeedbackList` from Task 5 (`{ workspaceSlug, projectId, sourceId }`), `Select` (existing).
- Produces: `export default function FeedbackSourceDetail(props: { workspaceSlug?: string; projectId?: string; sourceId: string }): JSX.Element`. Task 8 (`[sourceId].astro`) renders this as the page body.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/islands/FeedbackSourceDetail.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import FeedbackSourceDetail from "./FeedbackSourceDetail";

const SOURCE_A = {
	id: "s1",
	name: "Onboarding survey",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "abcdef012345…",
	createdAt: 1000,
	revokedAt: null,
};

const SOURCE_B = {
	id: "s2",
	name: "Widget",
	description: null,
	isActive: true,
	allowedOrigins: null,
	tokenPreview: "ffffff000000…",
	createdAt: 900,
	revokedAt: null,
};

function stubFetch(sources = [SOURCE_A, SOURCE_B]) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/feedback-sources")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(sources) });
			}
			if (u.includes("/feedback/summary")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			if (u.includes("/feedback")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
		})
	);
}

describe("FeedbackSourceDetail", () => {
	it("renders the source name, status, and a source-switch dropdown", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		expect(await screen.findByRole("heading", { name: "Onboarding survey" })).toBeTruthy();
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.getByRole("combobox", { name: /Switch feedback source/i })).toBeTruthy();
	});

	it("defaults to the Items tab and shows a tablist with three tabs", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByRole("heading", { name: "Onboarding survey" });
		expect(screen.getByRole("tab", { name: "Items", selected: true })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Summary" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
	});

	it("switching to the Settings tab renders token/status controls", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
		await screen.findByRole("heading", { name: "Onboarding survey" });
		fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
		expect(await screen.findByText("abcdef012345…")).toBeTruthy();
	});

	it("shows a not-found state for an unknown sourceId", async () => {
		stubFetch();
		render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="does-not-exist" />);
		expect(await screen.findByText(/Feedback source not found/i)).toBeTruthy();
	});

	it("switching sources via the dropdown navigates to the new source's detail page", async () => {
		stubFetch();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", { value: { ...originalLocation, href: "" }, writable: true });
		try {
			render(<FeedbackSourceDetail workspaceSlug="my-ws" projectId="p1" sourceId="s1" />);
			await screen.findByRole("heading", { name: "Onboarding survey" });
			fireEvent.click(screen.getByRole("combobox", { name: /Switch feedback source/i }));
			fireEvent.click(screen.getByRole("option", { name: "Widget" }));
			await waitFor(() => expect(window.location.href).toContain("/feedback/s2"));
		} finally {
			Object.defineProperty(window, "location", { value: originalLocation, writable: true });
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceDetail.test.tsx`
Expected: FAIL — `Cannot find module './FeedbackSourceDetail'`

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/islands/FeedbackSourceDetail.tsx
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";
import FeedbackList from "./FeedbackList";
import FeedbackSourceSettings, { type FeedbackSource } from "./FeedbackSourceSettings";
import FeedbackSummary from "./FeedbackSummary";
import Select from "./Select";

interface Props {
	workspaceSlug?: string;
	projectId?: string;
	sourceId: string;
}

type TabId = "items" | "summary" | "settings";
const TABS: TabId[] = ["items", "summary", "settings"];
const TAB_LABELS: Record<TabId, string> = { items: "Items", summary: "Summary", settings: "Settings" };

const TAB_LIST = "flex gap-1 border-b border-border mb-4";
const tabBtnClass = (active: boolean) =>
	"px-4 py-2 text-[0.85rem] font-semibold border-b-2 -mb-px bg-transparent cursor-pointer " +
	(active ? "border-accent text-text-base" : "border-transparent text-text-muted hover:text-text-base");

function statusLabel(s: FeedbackSource): string {
	if (s.revokedAt !== null) return "Revoked";
	return s.isActive ? "Active" : "Inactive";
}

export default function FeedbackSourceDetail({ workspaceSlug, projectId: projectIdProp, sourceId }: Props) {
	const [projectId, setProjectId] = useState(projectIdProp ?? "");
	useEffect(() => {
		if (projectIdProp) return;
		const fromUrl = new URLSearchParams(window.location.search).get("projectId");
		if (fromUrl) setProjectId(fromUrl);
	}, [projectIdProp]);

	const [sources, setSources] = useState<FeedbackSource[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<TabId>("items");
	const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

	const fetchSources = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<FeedbackSource[]>(`/api/projects/${projectId}/feedback-sources`, {
				workspaceSlug,
			});
			setSources(Array.isArray(data) ? data : []);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [projectId, workspaceSlug]);

	useEffect(() => {
		fetchSources();
	}, [fetchSources]);

	function focusTab(id: TabId) {
		tabRefs.current[id]?.focus();
	}

	function onTabKeyDown(e: KeyboardEvent) {
		const idx = TABS.indexOf(tab);
		let nextId: TabId | null = null;
		if (e.key === "ArrowRight") nextId = TABS[(idx + 1) % TABS.length];
		else if (e.key === "ArrowLeft") nextId = TABS[(idx - 1 + TABS.length) % TABS.length];
		else if (e.key === "Home") nextId = TABS[0];
		else if (e.key === "End") nextId = TABS[TABS.length - 1];
		if (!nextId) return;
		e.preventDefault();
		setTab(nextId);
		focusTab(nextId);
	}

	if (loading) return <p aria-live="polite">Loading source…</p>;
	if (error) {
		return (
			<p role="alert" class="text-[var(--danger-text)]">
				{error}
			</p>
		);
	}

	const source = sources.find((s) => s.id === sourceId);
	if (!source) {
		return (
			<div class="p-6 text-center text-text-muted bg-surface rounded-lg border border-border">
				Feedback source not found.
			</div>
		);
	}

	return (
		<div>
			<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
				<div class="flex items-center gap-2">
					<h1 class="text-xl font-bold text-text-base m-0">{source.name}</h1>
					<span class="text-[0.7rem] font-medium px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted">
						{statusLabel(source)}
					</span>
				</div>
				{sources.length > 1 && (
					<Select
						ariaLabel="Switch feedback source"
						value={source.id}
						onChange={(id) => {
							window.location.href = `/feedback/${id}${projectId ? `?projectId=${projectId}` : ""}`;
						}}
						options={sources.map((s) => ({ value: s.id, label: s.name }))}
					/>
				)}
			</div>

			<div role="tablist" aria-label="Feedback source" class={TAB_LIST} onKeyDown={onTabKeyDown}>
				{TABS.map((id) => (
					<button
						key={id}
						ref={(el) => {
							tabRefs.current[id] = el;
						}}
						type="button"
						role="tab"
						id={`feedback-tab-${id}`}
						aria-selected={tab === id}
						aria-controls={`feedback-tabpanel-${id}`}
						tabIndex={tab === id ? 0 : -1}
						class={tabBtnClass(tab === id)}
						onClick={() => setTab(id)}
					>
						{TAB_LABELS[id]}
					</button>
				))}
			</div>

			{tab === "items" && (
				<div role="tabpanel" id="feedback-tabpanel-items" aria-labelledby="feedback-tab-items">
					<FeedbackList workspaceSlug={workspaceSlug} projectId={projectId} sourceId={source.id} />
				</div>
			)}
			{tab === "summary" && (
				<div role="tabpanel" id="feedback-tabpanel-summary" aria-labelledby="feedback-tab-summary">
					<FeedbackSummary workspaceSlug={workspaceSlug} projectId={projectId} sourceId={source.id} />
				</div>
			)}
			{tab === "settings" && (
				<div role="tabpanel" id="feedback-tabpanel-settings" aria-labelledby="feedback-tab-settings">
					<FeedbackSourceSettings
						source={source}
						projectId={projectId}
						workspaceSlug={workspaceSlug}
						onChanged={fetchSources}
					/>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @projektor/web test -- src/islands/FeedbackSourceDetail.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/islands/FeedbackSourceDetail.tsx apps/web/src/islands/FeedbackSourceDetail.test.tsx
git commit -m "feat(web): add FeedbackSourceDetail island with tabs and source-switch dropdown"
```

---

### Task 7: Slim down `feedback.astro` to the card grid

**Files:**
- Modify: `apps/web/src/pages/feedback.astro` (full rewrite)

**Interfaces:**
- Consumes: `FeedbackSourceGrid` from Task 3.

- [ ] **Step 1: Rewrite the page**

```astro
---
import Base from '../layouts/Base.astro';
import ProjectNav from '../islands/ProjectNav';
import FeedbackSourceGrid from '../islands/FeedbackSourceGrid';

const workspaceSlug = import.meta.env.PUBLIC_WORKSPACE_SLUG as string | undefined;
---
<Base title="Feedback — Projektor">
  <ProjectNav client:load workspaceSlug={workspaceSlug} pageLabel="Feedback" />
  <div class="page-container">
    <FeedbackSourceGrid client:load workspaceSlug={workspaceSlug} />
  </div>
</Base>
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @projektor/web exec astro check`
Expected: no new errors introduced by this file (pre-existing unrelated errors, if any, are out of scope).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/feedback.astro
git commit -m "refactor(web): slim /feedback down to the source card grid"
```

---

### Task 8: New `/feedback/[sourceId]` detail route

**Files:**
- Create: `apps/web/src/pages/feedback/[sourceId].astro`

**Interfaces:**
- Consumes: `FeedbackSourceDetail` from Task 6.

- [ ] **Step 1: Write the route**

```astro
---
import Base from '../../layouts/Base.astro';
import ProjectNav from '../../islands/ProjectNav';
import FeedbackSourceDetail from '../../islands/FeedbackSourceDetail';

export async function getStaticPaths() {
  // Paths are unknown at build time; the island resolves the source client-side
  // via the sourceId prop (GET /api/projects/:id/feedback-sources).
  return [];
}

const { sourceId } = Astro.params as { sourceId: string };
const workspaceSlug = import.meta.env.PUBLIC_WORKSPACE_SLUG as string | undefined;
---
<Base title="Feedback source — Projektor">
  <ProjectNav client:load workspaceSlug={workspaceSlug} pageLabel="Feedback" />
  <div class="page-container">
    <FeedbackSourceDetail client:load workspaceSlug={workspaceSlug} sourceId={sourceId} />
  </div>
</Base>
```

- [ ] **Step 2: Build to confirm the route compiles under static output**

Run: `pnpm --filter @projektor/web build`
Expected: build succeeds; output includes `dist/feedback/[sourceId]/` or equivalent client-resolved route (static output with `getStaticPaths` returning `[]` emits no prerendered pages for this route, matching the existing issue-detail route).

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/pages/feedback/[sourceId].astro"
git commit -m "feat(web): add /feedback/[sourceId] detail route"
```

---

### Task 9: Remove the superseded `FeedbackSourceManager` island

**Files:**
- Delete: `apps/web/src/islands/FeedbackSourceManager.tsx`
- Delete: `apps/web/src/islands/FeedbackSourceManager.test.tsx`

Its responsibilities are now fully covered by `FeedbackSourceGrid` (Task 3, listing + create), `NewSourceModal` (Task 2, create form), and `FeedbackSourceSettings` (Task 1, token/status controls). Confirm no remaining imports before deleting.

- [ ] **Step 1: Confirm no other file imports it**

Run: `grep -rn "FeedbackSourceManager" apps/web/src --include=*.astro --include=*.tsx`
Expected: no matches outside the two files being deleted.

- [ ] **Step 2: Delete the files**

```bash
git rm apps/web/src/islands/FeedbackSourceManager.tsx apps/web/src/islands/FeedbackSourceManager.test.tsx
```

- [ ] **Step 3: Run the full web test suite**

Run: `pnpm --filter @projektor/web test`
Expected: PASS, no references to the deleted files remain.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(web): remove FeedbackSourceManager, superseded by the source grid/modal/settings split"
```

---

### Task 10: Manual verification (desktop + mobile)

Not a subagent task — run this yourself against the dev server after Tasks 1-9 land, per the spec's testing section.

- [ ] Start the dev server: `pnpm --filter @projektor/web dev` (proxying `/api` to the local API per `astro.config.mjs`).
- [ ] Desktop viewport: navigate to `/feedback?projectId=<id>` — confirm one card per source (name, status, total, last activity) plus a trailing "+ New source" card.
- [ ] Create a source via the modal — confirm it appears in the grid and the raw token is shown once.
- [ ] Click a card — confirm navigation to `/feedback/<sourceId>` with header, status badge, and (if >1 source) the switch dropdown.
- [ ] Exercise all three tabs (Items/Summary/Settings) — confirm scoped data, arrow-key/Home/End tab navigation.
- [ ] In Settings: rotate token (confirm/cancel), toggle active, revoke — confirm each round-trips and the grid reflects the change afterward.
- [ ] Switch sources via the header dropdown — confirm it navigates to the other source's detail page.
- [ ] Mobile viewport (e.g. 375px via claude-in-chrome or browser devtools): repeat the grid → card → detail → tabs flow; confirm the Items tab's table/mobile-card responsive convention still works and the grid/tabs/modal remain usable at narrow widths.
- [ ] Confirm a revoked source still appears in the grid, visually muted, and its detail page still loads.
