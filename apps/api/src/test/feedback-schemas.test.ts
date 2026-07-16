import { describe, expect, it } from "vitest";
import {
	CreateFeedbackSourceSchema,
	SubmitFeedbackSchema,
	UpdateFeedbackSourceSchema,
} from "../schemas/feedback";

describe("SubmitFeedbackSchema", () => {
	it("accepts a body-only submission", () => {
		expect(SubmitFeedbackSchema.safeParse({ body: "great" }).success).toBe(true);
	});
	it("accepts rating + ratingScale", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 5, ratingScale: "five_star" }).success).toBe(true);
	});
	it("rejects empty submission (neither rating nor body)", () => {
		expect(SubmitFeedbackSchema.safeParse({}).success).toBe(false);
	});
	it("rejects rating without ratingScale", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 5 }).success).toBe(false);
	});
	it("rejects ratingScale without rating", () => {
		expect(SubmitFeedbackSchema.safeParse({ body: "x", ratingScale: "thumbs" }).success).toBe(false);
	});
});

describe("CreateFeedbackSourceSchema", () => {
	it("requires a name", () => {
		expect(CreateFeedbackSourceSchema.safeParse({ projectId: "p", name: "Onboarding" }).success).toBe(true);
		expect(CreateFeedbackSourceSchema.safeParse({ projectId: "p" }).success).toBe(false);
	});
});

describe("UpdateFeedbackSourceSchema", () => {
	it("requires at least one mutable field", () => {
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s" }).success).toBe(false);
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s", isActive: false }).success).toBe(true);
	});
});
