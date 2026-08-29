# Git safety guards

Two interlocking safety gates that protect against the CLI's two destructive
failure modes. Both are additions in `src/actions/git-guard.js` plus small
insertions in `update.js`, `deploy.js` and `cli.js`.

## The failure modes

1. **`raisely update` torches local work.** Update overwrites local
   stylesheets, components and pages with the org state. Any uncommitted
   local work in those files is unrecoverable.
2. **`raisely deploy` torches admin edits.** Deploy overwrites org pages and
   components with local state. If your local copy is stale, copy edits made
   in the Raisely admin since your last pull are silently destroyed.

## Gate 1 — clean tree before `update` (hard)

`raisely update` refuses to run when `git status --porcelain` shows
uncommitted changes (`.raisely.json` is ignored). Commit or stash first.

- Bypass per-run: `raisely update --allow-dirty`
- Bypass via env: `RAISELY_ALLOW_DIRTY=1`
- Not a git repository: warns loudly and proceeds (there is no safety net to
  enforce).
- `-f` / `--force` does **not** bypass this gate — force only skips the
  confirmation prompt.

Once this gate holds, `update` can never destroy work: everything it
overwrites is recoverable from git.

## Gate 2 — recent `update` before `deploy` (hard by default)

Every successful `raisely update` records a timestamp in
`~/.raisely-cli/sync-markers.json`, keyed by the git worktree root (stored
outside the repo so the marker never dirties the tree).

`raisely deploy` checks that timestamp. If the last update is older than the
threshold (**default: 5 minutes**) — or there is no record at all — deploy is
blocked:

- Interactive: a confirmation prompt (default **No**) after printing the safe
  recovery sequence.
- Non-interactive (`-f` or `cli: true` in config): hard failure with exit
  code 1.

Configuration (highest precedence first):

| Mechanism | Example | Effect |
|---|---|---|
| `--stale-after <minutes>` | `raisely deploy --stale-after 30` | per-run threshold |
| `staleAfterMinutes` in `.raisely.json` | `"staleAfterMinutes": 15` | per-repo threshold |
| `staleAfterMinutes: false` | `"staleAfterMinutes": false` | disables the check for the repo |
| `--allow-stale` | `raisely deploy -f --allow-stale` | per-run bypass |
| `RAISELY_ALLOW_STALE=1` | env | bypass (CI escape hatch) |

Deploying with a dirty tree is allowed but prints a warning (committed state
is recoverable state).

## The safe sequence (what the block message tells you)

```
1. commit local work:      git add -A && git commit
2. pull the org state:     raisely update -f
3. review what changed:    git diff
4. keep your version:      git checkout -- .   (or merge the pulled changes)
5. deploy:                 raisely deploy
```

Because Gate 1 requires a clean tree, step 2 can never destroy anything: the
org state lands as an ordinary working-tree diff against your commit, where
you can inspect, merge, or discard it.
