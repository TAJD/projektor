// PROJ-920: validate MCP tool arguments against the tool's JSON `inputSchema` before the
// handler runs, so a wrongly-typed argument is a -32602 naming the field — never a handler
// that trips over `input as {...}` and surfaces as -32000 / 500.
//
// This covers the JSON Schema subset the hand-written tool schemas actually use: type
// (string/number/integer/boolean/object/array, or a list of them), nullable, enum,
// properties/required (recursively), items, min/maxLength, minimum/maximum and
// min/maxItems. Any other keyword is ignored rather than guessed at. Properties a schema
// doesn't declare are left alone: services still validate with their Zod schemas, which
// remain the source of truth for business rules (PROJ-895 will generate these schemas
// from them).
//
// Deliberately lenient where the services already are, so this never rejects a call that
// used to work: numeric strings pass for number/integer (the Zod schemas use z.coerce),
// "true"/"1"/"false"/"0"/"" pass for boolean (BooleanQueryParam), and null passes for any optional
// property (Zod's .nullable().optional() "clear this field" idiom). Everything else that
// doesn't match the declared type is rejected.

type Schema = Record<string, unknown>;

export interface ArgIssue {
	path: string;
	message: string;
}

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

// Mirrors BooleanQueryParam (schemas/common.ts).
const BOOLEAN_STRINGS = new Set(["true", "1", "false", "0", ""]);

function isNumericString(v: unknown): boolean {
	return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim());
}

function matchesType(v: unknown, t: string): boolean {
	switch (t) {
		case "boolean":
			return typeof v === "boolean" || BOOLEAN_STRINGS.has(v as string);
		case "string":
		case "object":
		case "array":
			return typeOf(v) === t;
		case "number":
			return (typeof v === "number" && Number.isFinite(v)) || isNumericString(v);
		case "integer":
			return (
				(typeof v === "number" && Number.isInteger(v)) ||
				(isNumericString(v) && Number.isInteger(Number(v)))
			);
		case "null":
			return v === null;
		default:
			return true; // unknown type keyword: don't reject on a guess
	}
}

function validate(value: unknown, schema: Schema, path: string, issues: ArgIssue[]): void {
	if (value === null && schema.nullable === true) return;

	const declared = schema.type;
	const types = Array.isArray(declared)
		? declared.filter((t): t is string => typeof t === "string")
		: typeof declared === "string"
			? [declared]
			: [];
	if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
		issues.push({ path, message: `must be ${types.join(" or ")}, got ${typeOf(value)}` });
		return;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
		issues.push({
			path,
			message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
		});
		return;
	}

	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength)
			issues.push({ path, message: `must be at least ${schema.minLength} characters` });
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
			issues.push({ path, message: `must be at most ${schema.maxLength} characters` });
	}

	if (typeof value === "number" || isNumericString(value)) {
		const n = Number(value);
		if (typeof schema.minimum === "number" && n < schema.minimum)
			issues.push({ path, message: `must be >= ${schema.minimum}` });
		if (typeof schema.maximum === "number" && n > schema.maximum)
			issues.push({ path, message: `must be <= ${schema.maximum}` });
	}

	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems)
			issues.push({ path, message: `must have at least ${schema.minItems} items` });
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
			issues.push({ path, message: `must have at most ${schema.maxItems} items` });
		const items = schema.items;
		if (items && typeof items === "object" && !Array.isArray(items)) {
			value.forEach((item, i) => {
				validate(item, items as Schema, `${path}[${i}]`, issues);
			});
		}
	}

	if (typeOf(value) === "object") {
		validateObject(value as Record<string, unknown>, schema, path, issues);
	}
}

function validateObject(
	obj: Record<string, unknown>,
	schema: Schema,
	path: string,
	issues: ArgIssue[]
): void {
	const props =
		schema.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, Schema>)
			: {};
	const prefix = path ? `${path}.` : "";
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && obj[key] === undefined) {
				issues.push({ path: `${prefix}${key}`, message: "is required" });
			}
		}
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const [key, sub] of Object.entries(props)) {
		const v = obj[key];
		if (v === undefined || !sub || typeof sub !== "object") continue;
		if (v === null && !required.has(key)) continue; // optional field cleared
		validate(v, sub, `${prefix}${key}`, issues);
	}
}

/** Validate a tool call's `arguments` object against the tool's inputSchema. */
export function validateToolArgs(inputSchema: Schema, args: Record<string, unknown>): ArgIssue[] {
	const issues: ArgIssue[] = [];
	validateObject(args, inputSchema, "", issues);
	return issues;
}
