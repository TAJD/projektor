// Shared vitest setup for the web (Preact island) test suite.
//
// Wired via `setupFiles` in vitest.config.ts, so it runs before every test file.
// It provides two things every island test relies on:
//
//  1. A default `fetch` stub. Islands fetch on mount; without a stub jsdom has no
//     `fetch` and the component throws. The default resolves an empty-but-ok
//     response so a test that doesn't care about the network gets a sane no-op.
//     A test that DOES care overrides it per-case with `vi.stubGlobal("fetch", …)`
//     (see the island test files for the canonical mock-fetch pattern).
//  2. Cleanup after every test: unmount rendered trees and restore stubbed globals
//     so state never leaks between tests.
import { cleanup } from "@testing-library/preact";
import { afterEach, beforeEach, vi } from "vitest";
import { __resetApiFetchStateForTests } from "../utils/api-client";

// jsdom has no matchMedia; uPlot's pixel-ratio watcher calls it at import time.
if (!window.matchMedia) {
	window.matchMedia = vi.fn().mockImplementation(() => ({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	})) as unknown as typeof window.matchMedia;
}

// jsdom has no ResizeObserver; UplotChart uses one to rebuild on container resize.
if (typeof window.ResizeObserver === "undefined") {
	window.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}

// jsdom implements no canvas 2d context (getContext returns null) and no Path2D,
// so uPlot's deferred draw — a microtask that outlives the test — throws
// asynchronously even though every chart test passes. Stub a no-op context and
// Path2D so any chart island can render/redraw under test without a live canvas.
const noopCanvasCtx = new Proxy(
	{
		measureText: () => ({ width: 0 }),
		createLinearGradient: () => ({ addColorStop() {} }),
		getImageData: () => ({ data: [] }),
		canvas: { width: 0, height: 0 },
	},
	{ get: (target, prop) => (prop in target ? Reflect.get(target, prop) : () => {}) }
);
HTMLCanvasElement.prototype.getContext = (() =>
	noopCanvasCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;

if (typeof globalThis.Path2D === "undefined") {
	globalThis.Path2D = class {
		addPath() {}
		moveTo() {}
		lineTo() {}
		arc() {}
		rect() {}
		closePath() {}
	} as unknown as typeof Path2D;
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
	// The in-flight GET dedupe map (PROJ-443) is module-scoped; a test that mocks a
	// never-resolving fetch would otherwise hand its pending promise to the next test.
	__resetApiFetchStateForTests();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
