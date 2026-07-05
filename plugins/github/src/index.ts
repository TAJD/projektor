import { definePlugin, defineMCPTool } from '@projektor/plugin-sdk'

// cofferdam-ignore: Design.OrphanExport: plugin manifest, not yet wired into pluginRegistry (PROJ-260)
export default definePlugin({
  id: 'github',
  name: 'GitHub',
  version: '0.1.0',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS github_links (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        pr_url TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        repo TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    },
  ],
  mcpTools: [
    defineMCPTool({
      name: 'github_link_pr',
      description: 'Link a GitHub pull request to an issue',
      inputSchema: {
        type: 'object',
        required: ['issueId', 'prUrl', 'prNumber', 'repo'],
        properties: {
          issueId: { type: 'string' },
          prUrl: { type: 'string' },
          prNumber: { type: 'number' },
          repo: { type: 'string' },
        },
      },
      async handler(input, ctx) {
        const { issueId, prUrl, prNumber, repo } = input as {
          issueId: string; prUrl: string; prNumber: number; repo: string
        }
        const id = crypto.randomUUID()
        await ctx.db.prepare(
          'INSERT INTO github_links (id, issue_id, pr_url, pr_number, repo, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(id, issueId, prUrl, prNumber, repo, Math.floor(Date.now() / 1000)).run()
        return { id }
      },
    }),
  ],
})
