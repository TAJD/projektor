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
		expect(SubmitFeedbackSchema.safeParse({ rating: 5, ratingScale: "five_star" }).success).toBe(
			true
		);
	});
	it("rejects empty submission (neither rating nor body)", () => {
		expect(SubmitFeedbackSchema.safeParse({}).success).toBe(false);
	});
	it("rejects rating without ratingScale", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 5 }).success).toBe(false);
	});
	it("rejects ratingScale without rating", () => {
		expect(SubmitFeedbackSchema.safeParse({ body: "x", ratingScale: "thumbs" }).success).toBe(
			false
		);
	});

	it("accepts thumbs rating of -1 or 1", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: -1, ratingScale: "thumbs" }).success).toBe(
			true
		);
		expect(SubmitFeedbackSchema.safeParse({ rating: 1, ratingScale: "thumbs" }).success).toBe(true);
	});

	it("rejects an out-of-range thumbs rating", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 0, ratingScale: "thumbs" }).success).toBe(
			false
		);
		expect(SubmitFeedbackSchema.safeParse({ rating: 5, ratingScale: "thumbs" }).success).toBe(
			false
		);
	});

	it("accepts five_star ratings 1 through 5", () => {
		for (const rating of [1, 2, 3, 4, 5]) {
			expect(SubmitFeedbackSchema.safeParse({ rating, ratingScale: "five_star" }).success).toBe(
				true
			);
		}
	});

	it("rejects an out-of-range five_star rating", () => {
		expect(SubmitFeedbackSchema.safeParse({ rating: 0, ratingScale: "five_star" }).success).toBe(
			false
		);
		expect(SubmitFeedbackSchema.safeParse({ rating: 6, ratingScale: "five_star" }).success).toBe(
			false
		);
	});
});

describe("CreateFeedbackSourceSchema", () => {
	it("requires a name", () => {
		expect(
			CreateFeedbackSourceSchema.safeParse({ projectId: "p", name: "Onboarding" }).success
		).toBe(true);
		expect(CreateFeedbackSourceSchema.safeParse({ projectId: "p" }).success).toBe(false);
	});
});

describe("UpdateFeedbackSourceSchema", () => {
	it("requires at least one mutable field", () => {
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s" }).success).toBe(false);
		expect(UpdateFeedbackSourceSchema.safeParse({ sourceId: "s", isActive: false }).success).toBe(
			true
		);
	});
});
