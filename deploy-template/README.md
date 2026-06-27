# My Projektor Deployment

Personal deployment of [projektor](https://github.com/REPLACE/projektor) on Cloudflare.

## First-time setup

```bash
# 1. Clone with submodule
git clone --recurse-submodules https://github.com/YOU/YOUR-DEPLOY-REPO

# 2. Provision Cloudflare resources (D1, KV, R2)
bash setup.sh

# 3. Fill in the IDs printed by setup.sh into wrangler.toml

# 4. Set secrets
wrangler secret put JWT_SECRET

# 5. Apply migrations and deploy
cd projektor && npx wrangler d1 migrations apply projektor --remote --config ../wrangler.toml
npx wrangler deploy --config ../wrangler.toml
```

## Updating projektor

```bash
git submodule update --remote --merge
git add projektor
git commit -m "chore: bump projektor"
git push
# GitHub Actions deploys automatically
```

## Future: npm packages

Once projektor publishes `@projektor/api` to npm, replace the submodule with:

```toml
# wrangler.toml
main = "./src/index.ts"
```

```ts
// src/index.ts
import app from '@projektor/api'
export default app
```
