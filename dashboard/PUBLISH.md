# Publishing to GitHub Pages

Yan's dashboard lives at `yan-xie-webflow.github.io/agentic-dashboard/` — a GitHub Pages site
deployed from a public repo. Here's how to do the same for this dashboard.

## Option A — Standalone public repo (recommended, like Yan's)

1. **Create a new public GitHub repo** (e.g. `suchitrahari/dev-productivity-dashboard`)

```bash
# From any directory
gh repo create suchitrahari/dev-productivity-dashboard --public --clone
cd dev-productivity-dashboard
```

2. **Copy the dashboard HTML**

```bash
cp /path/to/webflow/ops/dev-productivity-report/dashboard/index.html ./index.html
```

3. **Push and enable GitHub Pages**

```bash
git add index.html
git commit -m "Add developer productivity dashboard"
git push origin main

# Enable GitHub Pages from the repo root (main branch)
gh api repos/suchitrahari/dev-productivity-dashboard/pages \
  --method POST \
  --field source='{"branch":"main","path":"/"}'
```

4. Your dashboard will be live at:
   `https://suchitrahari.github.io/dev-productivity-dashboard/`

## Option B — Publish from the webflow monorepo (internal)

If you want to keep it internal, host it on an internal GitHub Pages site or
serve from the webflow org's GitHub Pages namespace:

```bash
# In a separate docs branch
git checkout -b docs/dev-productivity-dashboard
mkdir -p docs/dev-productivity-dashboard
cp ops/dev-productivity-report/dashboard/index.html docs/dev-productivity-dashboard/index.html
git add docs/
git commit -m "Add dev productivity dashboard"
git push origin docs/dev-productivity-dashboard

# Enable Pages on the webflow org repo (requires admin access)
# Settings → Pages → Source: docs/ folder on this branch
```

## Updating the Dashboard

Each time you run a new report:

1. Update the data constants in `index.html` (the `const prsMerged`, `agentReqs`, etc. objects)
2. Or generate the HTML from `report.ts` with `--output index.html` (future enhancement)
3. Commit and push — GitHub Pages auto-deploys within ~60 seconds

## Making it auto-update (GitHub Actions)

Add `.github/workflows/update-dashboard.yml` to your dashboard repo:

```yaml
name: Update Dashboard
on:
  schedule:
    - cron: '0 9 * * 1' # Every Monday at 9am UTC
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate report data
        run: |
          # Call report.ts here with DX_DATABASE_URL
          # Then update index.html data constants
          echo "Add your data pipeline here"
      - name: Commit and push
        run: |
          git config user.email "github-actions@github.com"
          git config user.name "GitHub Actions"
          git add index.html
          git diff --staged --quiet || git commit -m "chore: auto-update dashboard $(date +%Y-%m-%d)"
          git push
```
