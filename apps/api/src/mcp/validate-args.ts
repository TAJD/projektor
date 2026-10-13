// PROJ-920: validate MCP tool arguments against the tool's JSON `inputSchema` before the
// handler runs, so a wrongly-typed argument is a -32602 naming the field — never a handler
// that trips over `input as {...}` and surfaces as -32000 / 500.
//
// This covers the JSON Schema subset the hand-written tool schemas actually use: type
// (string/number/integer/boolean/object/array, or a list of them), nullable, enum,
// properties/required (recursively), items, min/maxLength, minimum/maximum and
// min/maxItems; other keywords are ignored rather than guessed at. Zod stays the source of
// truth (PROJ-895 generates these schemas from it). An undeclared key is reported, with a
// did-you-mean, unless its object allows additionalProperties or declares no properties.
//
// Types are checked as leniently as the services check them, so a type never fails a call
// that used to work: numeric strings pass for number/integer (the Zod schemas use z.coerce),
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

const MAX_SUGGESTION_DISTANCE = 2;

function editDistance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}

function closest(key: string, candidates: string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
	for (const candidate of candidates) {
		if (Math.abs(candidate.length - key.length) >= bestDistance) continue;
		const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
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
			: undefined;
	const prefix = path ? `${path}.` : "";
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && obj[key] === undefined) {
				issues.push({ path: `${prefix}${key}`, message: "is required" });
			}
		}
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	for (const [key, sub] of Object.entries(props ?? {})) {
		const v = obj[key];
		if (v === undefined || !sub || typeof sub !== "object") continue;
		if (v === null && !required.has(key)) continue; // optional field cleared
		validate(v, sub, `${prefix}${key}`, issues);
	}
	if (!props || schema.additionalProperties) return;
	const declared = Object.keys(props);
	for (const key of Object.keys(obj)) {
		if (Object.hasOwn(props, key)) continue;
		const near = closest(key, declared);
		issues.push({
			path: `${prefix}${key}`,
			message: `Unknown argument "${key}"${near ? `; did you mean "${near}"?` : ""}`,
		});
	}
}

/** Validate a tool call's `arguments` object against the tool's inputSchema. */
export function validateToolArgs(inputSchema: Schema, args: Record<string, unknown>): ArgIssue[] {
	const issues: ArgIssue[] = [];
	validateObject(args, inputSchema, "", issues);
	return issues;
}
