# Codebase Wiki

A GitHub-grounded wiki and Q&A tool for **any GitHub repo**. Give it `owner/name`
and it:

- classifies the repo's files and writes a set of topic pages (a table of contents),
- renders each page in two modes: technical **Wiki** pages and a picture-book **Field Guide**,
- answers free-form questions by reading the live source from GitHub, with citations that
  link to the exact lines at the commit it read,
- stays fresh by syncing against the branch head and regenerating only the pages whose
  files changed.

## Run it

```bash
cp .env.example .env.local   # fill in Astra, LLM and (optionally) GitHub credentials
npm install
npm run dev                  # http://localhost:3000/wiki
```

Open `/wiki?repo=owner/name&branch=main`, or use the **Repo** box in the branch menu.
A repo that has never been opened is analysed on first load, which takes a few minutes.

## Configuration

See [`.env.example`](.env.example). `WIKI_DEFAULT_REPO` is the repo shown when a request
names none.

## Data

Everything lives in one Astra collection, `wiki_toc_v2` (created on first use), shared by all repos.
Documents are keyed by repo and branch:

| Document | `_id` |
| --- | --- |
| topic | `<repo>:<branch>:<slug>` |
| snapshot (head SHA, job state, sync lease) | `<repo>:<branch>:snapshot` |

`repo` is the lower-cased `owner/name` and every document carries it as a field.

### Migrating data written before multi-repo support

Older documents have ids like `main:<slug>` and no `repo` field. Copy them to the new ids:

```bash
npm run migrate-wiki-repo -- --repo=owner/name              # dry run
npm run migrate-wiki-repo -- --repo=owner/name --apply      # copy
npm run migrate-wiki-repo -- --repo=owner/name --delete-old # remove originals that have a copy
```

## API

All routes take `repo` (`?repo=` or a body field), falling back to `WIKI_DEFAULT_REPO`,
and `branch`, falling back to the repo's default branch.

| Route | Purpose |
| --- | --- |
| `GET /api/wiki/repos` | Repos with a stored wiki |
| `GET /api/wiki/branches` | Branches of a repo |
| `GET /api/wiki/toc` | Topics (generates them on first call) |
| `POST /api/wiki/sync` | Sync a branch to its head |
| `POST /api/wiki/chat` | Streamed, cited answer |
| `GET /api/wiki/status` | Page freshness and job state |
| `POST /api/wiki/backfill`, `/rebuild`, `/jobs` | Generate, rebuild and control background jobs |

## Scripts

- `npm run seed-wiki -- --repo=owner/name [branch]` — generate and sync from the command line
- `scripts/regen-wiki-pictures.ts` — regenerate the Field Guide pages

## Not built yet

- **Auth.** The API is unauthenticated. Run it locally or behind your own access control.
- Design notes for a faster index live in [`wiki-index-plan.md`](wiki-index-plan.md); it was written
  for a single repo.
