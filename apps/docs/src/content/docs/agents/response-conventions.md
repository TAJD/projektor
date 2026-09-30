---
title: "Response conventions"
description: "How MCP tool results are shaped: summary/full views, fields, dropped nulls and internal ids, the {items, next} list shape, and the 20,000-character cap."
sidebar:
  order: 3
---
MCP tool results are metered in tokens, so they are shaped to carry only what an agent
can act on. REST (`/api/*`) is unchanged: it always returns the full row shape.

## Dropped fields

Unless you pass `verbose:true`, a result omits:

- `null` values, empty arrays, zero rollups and `false` defaults (an omitted key means null / empty / false).
- Internal ids: `workspace_id`, `project_id`, `type_id`, `status_id`, `created_by_id`.
- Duplicated name/key pairs: `project_key`, `project_name`, `type_key`, `type_name`, `status_key`, `status_name`. The kept equivalents are `ref` (`PROJ-42`), `type`, `status` and `priority`.

`labels` is a real array (`["mcp","api"]`), not a JSON string. A custom workflow status is kept as `status_key` when it differs from the legacy `status`. `verbose:true` returns the raw row.

## `view=summary|full`

List and get tools for issues take `view`. The default is `full` on the current surface.

| View | Issue fields |
| --- | --- |
| `summary` | `ref`, `title`, `status`, `priority`, `type`, `parent?`, `assignee?`, `updated` |
| `full` | everything non-empty: the summary fields plus `body` (when requested), `labels`, `status_category`, `assignee_id`/`assignee_name`, `sprint_id`, `created_at`, `updated_at`, `completed_at`, `needs_audit`, `rollup`, `links`, `customFields`, `url` |

`parent` is the parent's id until refs are returned everywhere. `assignee` is the
assignee's name.

## `fields=`

`fields` is an explicit allowlist and wins over `view`. Pass an array or a comma-separated string:
`fields: "ref,title,updated"`. Every named field is always present, with `null` if the
issue has no value for it. Unknown names are a validation error.

## Lists: `{items, next}`

Every MCP list returns `{items: [...], next?: "..."}`. When `next` is present, pass it
back unchanged as `cursor` to get the following page. When it is absent there are no more.

| Tool | Continue with |
| --- | --- |
| `list_issues` | `cursor` (a `(created_at,id)` compound cursor); `total` is included |
| `search_wiki` | `cursor` (the next offset) |
| `list_wiki_changes` | `cursor` (in place of `since`); `next` is absent when there were no changes |
| `list_project_activity`, `search_issues` | `{items}` only; use `limit`/`since` |
| `list_comments`, `wiki_tree` | `{items}` only, never cut |

Before and after for `list_issues` (50 issues): ~54 KB before; with `view=summary`, ~7 KB.

```jsonc
// before
{"items":[{"id":"…","workspace_id":"…","project_id":"…","number":42,"title":"Fix login",
  "status":"todo","priority":"high","assignee_id":null,"labels":"[]","parent_id":null,
  "type_id":"…","type_key":"bug","type_name":"Bug","status_id":"…","status_key":"todo",
  "status_name":"Todo","sprint_id":null,"created_by_id":"…","completed_at":null,
  "needs_audit":false,"project_key":"PROJ","project_name":"Projektor","customFields":[],"url":"…"}],
 "nextCursor":"1790200737:…","total":120}

// after: view=summary
{"items":[{"ref":"PROJ-42","title":"Fix login","status":"todo","priority":"high",
  "type":"bug","updated":1790201659}],"next":"1790200737:…","total":120}
```

## The 20,000-character cap

`list_issues`, `search_wiki`, `list_wiki_changes` and `list_project_activity` cap a single
result at about 20,000 characters, cut on an item boundary so it is always valid JSON. When
it fires the result carries `truncated:true`:

- `list_issues`, `search_wiki` and `list_wiki_changes` set `next` to resume right after the last item returned, so nothing is skipped. (`list_wiki_changes` never cuts in the middle of one second, because `since` is exclusive.)
- `list_project_activity` has no cursor: a `hint` says to lower `limit` or raise `since`.

`list_comments` and `wiki_tree` are not cut, because a dropped tail could not be recovered.
A result is never a partial JSON document.

## Reading long content

Long text is read in windows so one call never returns an unbounded blob.

- **Lists**: `bodyChars=N` (0–1000, default 0) adds the first N characters of each item's `body`, with `bodyTruncated:true` when it was cut. `includeBody:true` still returns whole bodies. Read the rest with `get_issue`.
- **`get_issue`**: `body` is returned up to 16,000 characters. If it is longer, the result has `bodyTruncated:true`, `bodyTotalChars` and `next`; pass `next` back as `cursor` for the rest.
- **`get_wiki_page`**: `content` is at most `maxChars` (default 8,000, max 20,000). `totalChars` is the full length and `outline` lists the page's headings. When `next` is present, pass it back as `cursor`. `section=<heading text or slug>` returns just that section (through the next heading of the same or higher level). An unknown section returns `sectionFound:false` and the `outline`, not an error. Frontmatter fields (`type`, `tags`, `status`, …) are still returned parsed. `contentTruncated:true` means `content` is only part of the page: never send it back to `update_wiki_page`, which would overwrite the page with the fragment; use `patch_wiki_page`.

Cursors are character offsets and always fall on whole characters, so a window never splits an emoji.

Tip: call `get_wiki_page` once, read the `outline`, then fetch only the `section` you need.
