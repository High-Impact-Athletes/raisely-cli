import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';

import { br, log } from '../helpers.js';

/**
 * Git safety guards for `raisely update` and `raisely deploy`.
 *
 * `raisely update` overwrites local stylesheets, components and pages with
 * the org state. If the working tree has uncommitted changes, that work is
 * unrecoverable. The update gate refuses to run until the tree is clean.
 *
 * `raisely deploy` overwrites org pages/components with local state. If the
 * last `raisely update` was a while ago, edits made in the Raisely admin
 * since then are silently destroyed. The deploy gate refuses (or prompts)
 * when the last successful update is older than a configurable threshold.
 *
 * The two gates interlock: the deploy gate's remedy is "commit, update,
 * review, deploy" — and the update gate guarantees that update can never
 * run over uncommitted work.
 */

export const DEFAULT_STALE_AFTER_MINUTES = 5;

// Files the CLI itself manages that shouldn't count as "uncommitted work"
const IGNORED_STATUS_PATHS = new Set(['.raisely.json', 'raisely.json']);

export function getMarkerFile() {
	return path.join(os.homedir(), '.raisely-cli', 'sync-markers.json');
}

function execGit(args, cwd) {
	return execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'pipe', 'ignore'],
	})
		.toString()
		.trim();
}

/**
 * Stable key for the repo (or plain directory) the CLI is running in.
 * Uses the git worktree root when available so the marker survives
 * running commands from a subdirectory.
 */
export function getRepoKey(cwd) {
	try {
		const root = execGit(['rev-parse', '--show-toplevel'], cwd);
		if (root) return fs.realpathSync(root);
	} catch (e) {
		// not a git repo, or git not installed — fall through
	}
	try {
		return fs.realpathSync(cwd);
	} catch (e) {
		return cwd;
	}
}

/**
 * Parse `git status --porcelain` output into the lines that represent
 * real uncommitted work (drops CLI-managed files like .raisely.json).
 */
export function parsePorcelain(text) {
	return text
		.split('\n')
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.filter((line) => {
			let entryPath = line.slice(3);
			// renames appear as "R  old -> new"
			const arrow = entryPath.indexOf(' -> ');
			if (arrow !== -1) entryPath = entryPath.slice(arrow + 4);
			// paths with special characters are quoted
			if (entryPath.startsWith('"') && entryPath.endsWith('"')) {
				entryPath = entryPath.slice(1, -1);
			}
			return !IGNORED_STATUS_PATHS.has(entryPath);
		});
}

/**
 * @returns {{ isRepo: boolean, dirtyFiles: string[] }}
 */
export function getGitState(cwd) {
	let isRepo = false;
	try {
		isRepo =
			execGit(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
	} catch (e) {
		isRepo = false;
	}
	if (!isRepo) return { isRepo: false, dirtyFiles: [] };

	let statusOutput;
	try {
		statusOutput = execFileSync('git', ['status', '--porcelain'], {
			cwd,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).toString();
	} catch (e) {
		// status failed on a real repo — fail safe and treat as dirty
		return {
			isRepo: true,
			dirtyFiles: ['(git status failed — could not verify a clean tree)'],
		};
	}

	return { isRepo: true, dirtyFiles: parsePorcelain(statusOutput) };
}

/** @returns {number|null} epoch ms of the last successful update, or null */
export function readSyncMarker(cwd, { markerFile = getMarkerFile() } = {}) {
	try {
		const map = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
		const entry = map[getRepoKey(cwd)];
		if (!entry || !entry.updatedAt) return null;
		const ts = Date.parse(entry.updatedAt);
		return Number.isFinite(ts) ? ts : null;
	} catch (e) {
		return null;
	}
}

export function writeSyncMarker(
	cwd,
	{ markerFile = getMarkerFile(), now = Date.now() } = {}
) {
	let map = {};
	try {
		map = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
	} catch (e) {
		// missing or corrupt — start fresh
	}
	if (typeof map !== 'object' || map === null || Array.isArray(map)) {
		map = {};
	}
	map[getRepoKey(cwd)] = { updatedAt: new Date(now).toISOString() };
	fs.mkdirSync(path.dirname(markerFile), { recursive: true });
	fs.writeFileSync(markerFile, JSON.stringify(map, null, 2));
}

/**
 * Resolve the deploy staleness threshold in ms.
 * Precedence: --stale-after flag > staleAfterMinutes in .raisely.json > default.
 * A config value of `false` disables the check entirely (returns null).
 */
export function resolveStaleAfterMs({ config = {}, options = {} } = {}) {
	let minutes;
	if (options.staleAfter !== undefined) minutes = options.staleAfter;
	else if (config.staleAfterMinutes !== undefined) {
		minutes = config.staleAfterMinutes;
	} else minutes = DEFAULT_STALE_AFTER_MINUTES;

	if (minutes === false) return null;
	const n = Number(minutes);
	if (!Number.isFinite(n) || n <= 0) {
		return DEFAULT_STALE_AFTER_MINUTES * 60 * 1000;
	}
	return n * 60 * 1000;
}

export function formatAge(ms) {
	if (ms < 60 * 1000) return `${Math.max(0, Math.round(ms / 1000))}s`;
	const mins = Math.floor(ms / (60 * 1000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Gate for `raisely update`: refuse to pull the org state over
 * uncommitted local work. Synchronous, needs no config or auth.
 *
 * @returns {boolean} true when the update may proceed
 */
export function gateUpdate({
	cwd = process.cwd(),
	options = {},
	env = process.env,
} = {}) {
	const bypass = options.allowDirty || env.RAISELY_ALLOW_DIRTY === '1';
	const state = getGitState(cwd);

	if (!state.isRepo) {
		br();
		log(
			`Warning: this directory is not a git repository. Files overwritten by update cannot be recovered.`,
			'yellow'
		);
		log(
			`Consider: ${chalk.bold.white('git init && git add -A && git commit')} before syncing.`,
			'yellow'
		);
		return true;
	}

	if (state.dirtyFiles.length === 0) return true;

	if (bypass) {
		br();
		log(
			`Warning: proceeding over ${state.dirtyFiles.length} uncommitted change(s) (--allow-dirty). Overwritten work will be unrecoverable.`,
			'yellow'
		);
		return true;
	}

	br();
	log(`Update blocked: your working tree has uncommitted changes.`, 'red');
	log(
		`${chalk.bold.white('raisely update')} overwrites local files with the org state — uncommitted work would be unrecoverable.`,
		'white'
	);
	br();
	const preview = state.dirtyFiles.slice(0, 15);
	preview.forEach((line) => log(`  ${line}`, 'yellow'));
	if (state.dirtyFiles.length > preview.length) {
		log(
			`  … and ${state.dirtyFiles.length - preview.length} more`,
			'yellow'
		);
	}
	br();
	log(`Commit or stash first:`, 'white');
	log(
		`  ${chalk.bold.white('git add -A && git commit -m "wip"')}   (or: ${chalk.bold.white('git stash -u')})`,
		'white'
	);
	br();
	log(
		`Or re-run with ${chalk.bold.white('--allow-dirty')} (env: RAISELY_ALLOW_DIRTY=1) to skip this check.`,
		'white'
	);
	return false;
}

/**
 * Gate for `raisely deploy`: warn about uncommitted changes (advisory),
 * and block when the last successful `raisely update` is older than the
 * staleness threshold — pages/components edited in the Raisely admin since
 * then would be silently overwritten.
 *
 * @returns {Promise<boolean>} true when the deploy may proceed
 */
export async function gateDeploy({
	cwd = process.cwd(),
	config = {},
	options = {},
	env = process.env,
	markerFile = getMarkerFile(),
	now = Date.now(),
	prompt = (questions) => inquirer.prompt(questions),
} = {}) {
	// Advisory only — never blocks the tight edit → deploy loop
	const state = getGitState(cwd);
	if (state.isRepo && state.dirtyFiles.length > 0) {
		br();
		log(
			`Warning: deploying with ${state.dirtyFiles.length} uncommitted change(s). Commit first if you want the deployed state recoverable from git.`,
			'yellow'
		);
	}

	const staleAfterMs = resolveStaleAfterMs({ config, options });
	if (staleAfterMs === null) return true; // disabled via config

	const allowStale = options.allowStale || env.RAISELY_ALLOW_STALE === '1';
	const marker = readSyncMarker(cwd, { markerFile });
	const age = marker === null ? null : now - marker;
	const isStale = marker === null || age > staleAfterMs;

	if (!isStale) {
		log(`Safety: last raisely update was ${formatAge(age)} ago.`, 'green');
		return true;
	}

	if (allowStale) {
		br();
		log(
			`Warning: skipping the recent-update safety check (--allow-stale). Admin edits made since your last update may be overwritten.`,
			'yellow'
		);
		return true;
	}

	br();
	if (marker === null) {
		log(
			`Deploy safety check: no record of a ${chalk.bold.white('raisely update')} in this repo from this machine.`,
			'red'
		);
	} else {
		log(
			`Deploy safety check: last ${chalk.bold.white('raisely update')} here was ${formatAge(age)} ago (limit: ${formatAge(staleAfterMs)}).`,
			'red'
		);
	}
	log(
		`Deploying now would overwrite any pages or components edited in the Raisely admin since then.`,
		'white'
	);
	br();
	log(`Safe sequence:`, 'white');
	log(`  1. commit local work:      git add -A && git commit`, 'white');
	log(`  2. pull the org state:     raisely update -f`, 'white');
	log(`  3. review what changed:    git diff`, 'white');
	log(
		`  4. keep your version:      git checkout -- .   (or merge the pulled changes)`,
		'white'
	);
	log(`  5. deploy:                 raisely deploy`, 'white');
	br();

	const interactive = !config.cli && !options.force;
	if (!interactive) {
		log(
			`Deploy blocked (non-interactive). Re-run with ${chalk.bold.white('--allow-stale')} to override, or adjust with --stale-after <minutes>.`,
			'red'
		);
		return false;
	}

	const response = await prompt([
		{
			type: 'confirm',
			name: 'confirm',
			default: false,
			message: 'Deploy anyway?',
		},
	]);
	return Boolean(response.confirm);
}
