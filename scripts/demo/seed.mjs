import { parseArgs } from "node:util";
import { PROJECTS, WIKI_PAGES } from "./content.mjs";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: "https://projektor-demo.tajdickson.workers.dev" },
		workspace: { type: "string", default: "projektor-demo" },
	},
});
const token = process.env.DEMO_ADMIN_TOKEN;
if (!token) {
	console.error(
		"usage: DEMO_ADMIN_TOKEN=pk_... node scripts/demo/seed.mjs [--url <origin>] [--workspace <slug>]"
	);
	process.exit(2);
}
const origin = values.url.replace(/\/$/, "");

async function api(method, path, body) {
	const res = await fetch(`${origin}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Workspace-Slug": values.workspace,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : null;
}

const rows = (body, ...keys) => {
	if (Array.isArray(body)) return body;
	for (const key of keys) if (Array.isArray(body?.[key])) return body[key];
	throw new Error(`unexpected list shape: ${JSON.stringify(body).slice(0, 200)}`);
};

async function resetProjects() {
	const all = rows(await api("GET", "/api/projects"), "projects", "items");
	for (const project of all.filter((p) => p.workspace_slug === values.workspace)) {
		await api("DELETE", `/api/projects/${project.id}`);
		console.log(`deleted project ${project.key}`);
	}
}

async function publicViewersGroupId() {
	const groups = rows(
		await api("GET", `/api/workspaces/${values.workspace}/groups`),
		"groups",
		"items"
	);
	const group = groups.find((g) => g.name === "Public viewers");
	if (!group) throw new Error('no "Public viewers" group: is PUBLIC_READ_ONLY on?');
	return group.id;
}

async function seedProject(spec, groupId) {
	const project = await api("POST", "/api/projects", {
		name: spec.name,
		key: spec.key,
		description: spec.description,
	});
	await api("PUT", `/api/workspaces/${values.workspace}/groups/${groupId}/grants`, {
		projectId: project.id,
		role: "viewer",
	});
	const refs = new Map();
	for (const issue of spec.issues) {
		const { ref, parent, comments = [], report, links, ...fields } = issue;
		const created = await api("POST", "/api/issues", {
			projectId: project.id,
			...fields,
			status: report ? "in_progress" : fields.status,
			...(parent ? { parentId: refs.get(parent) } : {}),
			...(links ? { links: links.map((l) => ({ type: l.type, target: refs.get(l.target) })) } : {}),
		});
		refs.set(ref, created.id);
		for (const body of comments) {
			await api("POST", `/api/issues/${created.id}/comments`, { body });
		}
		if (report) {
			await api("PATCH", `/api/issues/${created.id}`, {
				status: fields.status,
				completionReport: report,
			});
		}
	}
	console.log(`seeded project ${spec.key}: ${spec.issues.length} issues`);
}

async function seedWiki() {
	const existing = rows(await api("GET", "/api/wiki?limit=500"), "pages", "items");
	const bySlug = new Map(existing.map((p) => [p.slug, p]));
	const wanted = new Set(["page-templates"]);
	for (const page of WIKI_PAGES) {
		wanted.add(page.slug);
		if (bySlug.has(page.slug)) {
			await api("PUT", `/api/wiki/${page.slug}`, { title: page.title, content: page.content });
		} else {
			const created = await api("POST", "/api/wiki", {
				title: page.title,
				content: page.content,
			});
			if (created.slug !== page.slug) {
				throw new Error(`wiki page "${page.title}" got slug ${created.slug}, want ${page.slug}`);
			}
		}
	}
	for (const page of existing) {
		if (!wanted.has(page.slug)) {
			await api("DELETE", `/api/wiki/${page.slug}`);
			console.log(`deleted wiki page ${page.slug}`);
		}
	}
	console.log(`seeded ${WIKI_PAGES.length} wiki pages`);
}

const groupId = await publicViewersGroupId();
await resetProjects();
for (const spec of PROJECTS) await seedProject(spec, groupId);
await seedWiki();
console.log(`demo reseeded at ${origin}`);
