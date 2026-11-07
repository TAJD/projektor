import { drizzle as createDrizzle } from "drizzle-orm/d1";

const instances = new WeakMap<object, WeakMap<object, unknown>>();

export const drizzle = ((client: object, config?: { schema?: object }) => {
	const schema = config?.schema;
	if (!schema || Object.keys(config).length !== 1) {
		return createDrizzle(client as never, config as never);
	}
	let bySchema = instances.get(client);
	if (!bySchema) {
		bySchema = new WeakMap();
		instances.set(client, bySchema);
	}
	let db = bySchema.get(schema);
	if (!db) {
		db = createDrizzle(client as never, config as never);
		bySchema.set(schema, db);
	}
	return db;
}) as typeof createDrizzle;
