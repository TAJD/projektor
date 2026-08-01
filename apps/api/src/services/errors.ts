export type ZodFlattenOutput = {
	formErrors: string[];
	fieldErrors: Record<string, string[] | undefined>;
};

export abstract class ServiceError extends Error {
	abstract readonly kind: string;
}

export class ValidationError extends ServiceError {
	readonly kind = "validation" as const;
	// cofferdam-ignore: Refactor.UnusedVariable: public ctor param, read at error-adapter.ts (err.issues) — CD-44
	constructor(public readonly issues: ZodFlattenOutput) {
		super("Validation failed");
	}
}

export class NotFoundError extends ServiceError {
	readonly kind = "not_found" as const;
	// PROJ-490: `details` mirrors ConflictError's — structured, client-facing extra
	// fields (e.g. patch_wiki_page's currentHeadings list on a heading-not-found miss)
	// beyond the plain message. Optional so every pre-existing plain-message
	// NotFoundError is unaffected.
	// cofferdam-ignore: Refactor.UnusedVariable: public readonly property read by error-adapter.ts
	constructor(
		message = "Not found",
		public readonly details?: Record<string, unknown>
	) {
		super(message);
	}
}

export class ForbiddenError extends ServiceError {
	readonly kind = "forbidden" as const;
	constructor(message = "Forbidden") {
		super(message);
	}
}

export class ConflictError extends ServiceError {
	readonly kind = "conflict" as const;
	// PROJ-484: `details` carries structured, client-facing extra fields (e.g. wiki's
	// optimistic-lock conflict: currentRevisionId + a unified diff) beyond the plain
	// message. Optional so every pre-existing plain-message ConflictError is unaffected.
	// cofferdam-ignore: Refactor.UnusedVariable: public readonly property read by error-adapter.ts
	constructor(
		message = "Conflict",
		public readonly details?: Record<string, unknown>
	) {
		super(message);
	}
}

export class PayloadTooLargeError extends ServiceError {
	readonly kind = "payload_too_large" as const;
	constructor(message = "Payload too large") {
		super(message);
	}
}

export class UnsupportedMediaTypeError extends ServiceError {
	readonly kind = "unsupported_media_type" as const;
	constructor(message = "Unsupported media type") {
		super(message);
	}
}
