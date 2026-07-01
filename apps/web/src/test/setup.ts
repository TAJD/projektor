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

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
