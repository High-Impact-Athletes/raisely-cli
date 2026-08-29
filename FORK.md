# HIA fork of @raisely/cli

This is High Impact Athletes' build of the [Raisely CLI](https://github.com/raisely/cli).
It tracks upstream and adds a small stack of fixes and features, each kept as
its own branch so any one of them can be adopted, PR'd upstream, or dropped
independently.

## Install

```bash
npm install -g "github:High-Impact-Athletes/raisely-cli#hia"
```

Do **not** install `@raisely/cli` from npm on machines that use this fork —
that replaces this build with unpatched upstream. Quick check for which build
is installed: `raisely update --help | grep allow-dirty` (no output =
upstream build).

## Branch model

| Branch | Contents | Upstream status |
|---|---|---|
| `master` | pristine mirror of `raisely/cli` `master` — never commit here | — |
| `fix/page-sync-filename-collision` | custom pages all share `name: "legacy"` and overwrite each other on sync | [raisely/cli#85](https://github.com/raisely/cli/pull/85) (open) |
| `fix/local-proxy-hang-and-injection` | `raisely local` hangs on every request (v2 `onProxyRes` on a v3 dep) and `$2` in page copy corrupts the override injection | [raisely/cli#86](https://github.com/raisely/cli/pull/86) (open) |
| `feat/git-safety-guards` | `update` refuses to run over a dirty git tree; `deploy` refuses when the last update is stale — see [SAFETY-GUARDS.md](SAFETY-GUARDS.md) | not yet PR'd |
| `hia` | **the install branch**: `master` + all of the above + this file | — |

Every feature branch is based directly on `master` and is independent of the
others (no overlapping files), so each can be cherry-picked or merged in any
combination.

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
