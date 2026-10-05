# HIA fork of @raisely/cli

This is High Impact Athletes' build of the [Raisely CLI](https://github.com/raisely/cli).
It tracks upstream and adds a small stack of fixes and features, each kept as
its own branch so any one of them can be adopted, PR'd upstream, or dropped
independently.

## Install

```bash
npm install -g "github:High-Impact-Athletes/raisely-cli#hia"
```

The fork installs under the package name **`@hia/raisely-cli`** (bin is still
`raisely`). This is deliberate armour against npm clobbering the build:

- `npm update -g @raisely/cli` / `npm upgrade -g @raisely/cli` — no-op; that
  package isn't installed. (Verified 2026-08-30: when the fork was still
  named `@raisely/cli`, this command silently replaced it with registry
  vanilla even though the versions matched.)
- `npm install -g @raisely/cli` — npm refuses with an `EEXIST` bin conflict,
  because a *different* package (`@hia/raisely-cli`) owns the `raisely` bin.
  **That error is by design** — it means the guard worked. Don't `--force`
  through it.
- Managing the fork itself: `npm uninstall -g @hia/raisely-cli`,
  `npm ls -g @hia/raisely-cli`.

Quick check for which build is installed:
`raisely update --help | grep allow-dirty` (no output = upstream build).

Upstream releases are still detected — the CLI checks the registry's
`@raisely/cli` dist-tags and prints fork-specific refresh instructions
instead of `npm update`.

## Branch model

| Branch | Contents | Upstream status |
|---|---|---|
| `master` | pristine mirror of `raisely/cli` `master` — never commit here | — |
| `fix/page-sync-filename-collision` | custom pages all share `name: "legacy"` and overwrite each other on sync | [raisely/cli#85](https://github.com/raisely/cli/pull/85) (open) |
| `fix/local-proxy-hang-and-injection` | `raisely local` hangs on every request (v2 `onProxyRes` on a v3 dep) and `$2` in page copy corrupts the override injection | [raisely/cli#86](https://github.com/raisely/cli/pull/86) (open) |
| `feat/git-safety-guards` | `update` refuses to run over a dirty git tree; `deploy` refuses when the last update is stale — see [SAFETY-GUARDS.md](SAFETY-GUARDS.md) | not yet PR'd |
| `feat/page-publish` | `raisely publish`: previews and publishes page copy only (text fields, diffed against live, never components/styles); blocks non-copy changes, refuses uncommitted page files, digest-confirmed — see the README "Copy editors" section | not yet PR'd |
| `hia` | **the install branch**: `master` + all of the above + this file | — |

Every feature branch is based directly on `master` and is independent of the
others (no overlapping files, except that `feat/git-safety-guards` and
`feat/page-publish` both add commands/options to `src/cli.js`, which merges
cleanly), so each can be cherry-picked or merged in any combination.

## Maintenance

`hia` is the only actively maintained stack. When upstream ships a release:

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout hia && git rebase upstream/master
npx vitest run                       # full suite must pass
git push --force-with-lease origin hia
npm install -g "github:High-Impact-Athletes/raisely-cli#hia"
```

Commits that upstream has merged drop out of the stack automatically during
the rebase. The feature branches are snapshots — refresh one (rebase it onto
the new `master`) only when you need it standalone, e.g. to open or update an
upstream PR.

The two `fix/*` branches carry the exact commits behind the open PRs
(PR heads live on `k-r-a-s-s/cli`; remote `kev` in the working clone).
Don't rewrite those branches while the PRs are open.
