# Contributing

Thanks for contributing! This document defines the branch, commit, PR and merge
rules for the project. They exist to keep history readable and `main` always
releasable. For the strategy behind these rules — the branching model
visualized, plus the full change lifecycle — see
[`docs/git-workflow.md`](docs/git-workflow.md).

## Getting started

```bash
nvm use            # Node 24 (.nvmrc)
npm install
cp .env.example .env.local
npm run dev
```

Before pushing, run the full local gate (the same checks CI runs):

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Project docs

Architecture and conventions (for both humans and Claude Code) live under
[`docs/`](docs/) — see [`docs/README.md`](docs/README.md) for the index. Read
those before extending the template.

## Branch rules

- **Never commit directly to `main`.** `main` is protected and only changes via
  a merged pull request.
- Branch off the latest `main` and name branches `<type>/<short-description>`:

  | Prefix      | Use for                                   |
  | ----------- | ----------------------------------------- |
  | `feat/`     | New features                              |
  | `fix/`      | Bug fixes                                 |
  | `docs/`     | Documentation only                        |
  | `chore/`    | Tooling, deps, config, no product change  |
  | `refactor/` | Code change with no behavior change       |
  | `test/`     | Tests only                                |

  Examples: `feat/contact-page`, `fix/sitemap-lastmod`.

- Keep branches short-lived; rebase on `main` if they fall behind:
  `git fetch origin && git rebase origin/main`.

## Commit rules

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(optional scope): <subject>

<optional body — the "why", wrapped at ~72 cols>
```

- **Types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`,
  `build`, `style`.
- Subject: imperative mood, lowercase, no trailing period
  (e.g. `feat: add contact page`, not `Added a contact page.`).
- A breaking change adds `!` after the type/scope (`feat!: …`) and a
  `BREAKING CHANGE:` footer.
- Keep each commit focused and green — don't mix a refactor with a feature.

## Pull request rules

- Open PRs against `main`, filling in the PR template.
- Title uses the same Conventional Commits format as commits — it becomes the
  merge commit subject.
- A PR must pass CI (lint, typecheck, test, build) and get at least one approving
  review before merge.
- Link related issues (`Closes #NN`). Keep PRs small and reviewable.

## Merge rules

- **Create a merge commit** (`gh pr merge --merge`) — the default. It preserves
  each branch's commits and records an explicit merge point, so `main` shows both
  the individual work and where each PR landed. (This is why commits must stay
  focused and green — they are kept, not flattened.)
- Rebase the branch on the latest `main` before merging
  (`git fetch origin && git rebase origin/main`) so history stays clean.
- The merge commit subject must be a valid Conventional Commit (the PR title).
- Delete the branch after merge.
- Don't merge your own PR without a passing CI run.

## No secrets in the repo

Never commit real domains, personal names, emails, SSH credentials, tokens or
other secrets. Site identity has env-driven SSHWeb defaults; deployment-specific
values belong in `.env.local`, which is gitignored.
