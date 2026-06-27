export type ZodFlattenOutput = {
	formErrors: string[];
	fieldErrors: Record<string, string[] | undefined>;
};

export abstract class ServiceError extends Error {
	abstract readonly kind: string;
}

export class ValidationError extends ServiceError {
	readonly kind = "validation" as const;
	constructor(public readonly issues: ZodFlattenOutput) {
		super("Validation failed");
	}
}

export class NotFoundError extends ServiceError {
	readonly kind = "not_found" as const;
	constructor(message = "Not found") {
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
	constructor(message = "Conflict") {
		super(message);
	}
}
