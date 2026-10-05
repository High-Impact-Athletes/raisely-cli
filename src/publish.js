/**
 * `raisely publish [pages...]`: publish page copy (and only copy) to the
 * live site, diffed against a fresh live snapshot.
 *
 * See plans/2026-10-05-raisely-publish/SPEC.md §3.1-§3.3, §3.6, §3.7.
 *
 * Exit codes (§3.2):
 *   0  published, nothing to publish, or a dry-run with no blockers
 *   1  runtime failure (auth/API error, a PATCH failed, TOCTOU abort)
 *   2  refused before writing anything
 */
import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import glob from 'glob-promise';

import api from './actions/api.js';
import { publishPage } from './actions/pages.js';
import {
	detectLayout,
	shouldRefuseLayoutForCommand,
	getLegacyLayoutRefusalMessage,
} from './actions/layout.js';
import { loadConfig } from './config.js';
import {
	diffPage,
	reportDigest,
	renderPreview,
	buildJsonReport,
} from './actions/publish-diff.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

export const CONFIRM_HINT =
	're-run with --confirm <digest> after a human has reviewed this preview';
export const UNCOMMITTED_TEXT =
	'commit your changes first, so what goes live is in git';
export const DUPLICATE_TEXT =
	'two files point at the same live page; delete the stale one (ask Kevin)';
export const TOCTOU_TEXT =
	'changed on the live site while you were reviewing; run publish again';
export const DONE_TEXT = 'Done. Now push your commit: git push';

const GIT_FETCH_TIMEOUT_MS = 10_000;

class Refusal extends Error {
	constructor(message, code = EXIT_REFUSED) {
		super(message);
		this.code = code;
	}
}

function toErrorMessage(e) {
	if (typeof e === 'string' && e.trim()) return e.trim();
	if (e && typeof e.message === 'string' && e.message.trim()) {
		return e.message.trim();
	}
	return String(e);
}

function git(args, opts = {}) {
	const result = spawnSync('git', args, {
		cwd: process.cwd(),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...opts,
	});
	return {
		ok: !result.error && result.status === 0,
		stdout: (result.stdout || '').toString(),
		stderr: (result.stderr || '').toString(),
	};
}

function isInteractive() {
	return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** Two timestamps denote the same instant (string-equal or same epoch ms). */
function sameInstant(a, b) {
	if (a === b) return true;
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	return !Number.isNaN(ta) && ta === tb;
}

/**
 * REVERT (§3.6): live was edited after the file's last commit. Both sides are
 * compared as absolute instants, so timezone offsets don't matter. If either
 * date is missing or unparseable we flag REVERT (the conservative choice).
 */
export function isRevert(liveUpdatedAt, lastCommitIso) {
	const live = Date.parse(liveUpdatedAt);
	const committed = Date.parse(lastCommitIso);
	if (Number.isNaN(live) || Number.isNaN(committed)) return true;
	return live > committed;
}

function stripJson(name) {
	return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

/**
 * Collect local page files and resolve scope (§3.3 steps 2-3).
 * Throws Refusal for unknown names, unparseable in-scope files and
 * duplicate uuids touching scope.
 */
async function collectLocalPages(cwd, config, names, warn) {
	const files = (
		await glob('campaigns/*/pages/**/*.json', { cwd, nodir: true })
	).sort();

	const wanted = (names || []).map(stripJson);
	if (wanted.length) {
		const known = new Set(files.map((f) => stripJson(path.basename(f))));
		const unknown = (names || []).filter((n) => !known.has(stripJson(n)));
		if (unknown.length) {
			throw new Refusal(
				`Unknown page name(s): ${unknown.join(', ')}. ` +
					'Use the file name of a page in campaigns/*/pages/ (with or without .json).'
			);
		}
	}
	const inScope = (file) =>
		!wanted.length || wanted.includes(stripJson(path.basename(file)));

	const pages = [];
	const unparseable = [];
	for (const file of files) {
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));
		} catch (e) {
			if (inScope(file)) unparseable.push(`${file}: ${e.message}`);
			else warn(`Skipping ${file}: not valid JSON`);
			continue;
		}
		if (!data || typeof data !== 'object' || !data.uuid) {
			if (inScope(file)) warn(`Skipping ${file}: it has no uuid`);
			continue;
		}
		if (
			!data.campaignUuid ||
			!config.campaigns.includes(data.campaignUuid)
		) {
			if (inScope(file)) {
				warn(
					`Skipping ${file}: its campaignUuid isn't one of this repo's campaigns`
				);
			}
			continue;
		}
		pages.push({ file, data, inScope: inScope(file) });
	}

	if (unparseable.length) {
		throw new Refusal(
			`These page files are not valid JSON:\n  ${unparseable.join('\n  ')}`
		);
	}

	const byUuid = new Map();
	for (const p of pages) {
		if (!byUuid.has(p.data.uuid)) byUuid.set(p.data.uuid, []);
		byUuid.get(p.data.uuid).push(p);
	}
	const dupes = [];
	for (const [uuid, group] of byUuid) {
		if (group.length > 1 && group.some((p) => p.inScope)) {
			dupes.push(`${uuid}: ${group.map((p) => p.file).join(' and ')}`);
		}
	}
	if (dupes.length) {
		throw new Refusal(
			`Duplicate page uuid:\n  ${dupes.join('\n  ')}\n${DUPLICATE_TEXT}`
		);
	}

	return pages.filter((p) => p.inScope);
}

/** Git checks (§3.3 step 4). Throws Refusal; warns when behind upstream. */
function gitChecks(scoped, warn) {
	const inside = git(['rev-parse', '--is-inside-work-tree']);
	if (!inside.ok || inside.stdout.trim() !== 'true') {
		throw new Refusal(
			'This folder is not inside a git repository. Publish only works from a git checkout of the site repo.'
		);
	}

	const dirty = [];
	for (const p of scoped) {
		const status = git(['status', '--porcelain', '--', p.file]);
		if (!status.ok) {
			throw new Refusal(
				`Could not check git status for ${p.file}: ${status.stderr.trim()}`
			);
		}
		if (status.stdout.trim()) dirty.push(p.file);
	}
	if (dirty.length) {
		throw new Refusal(
			`These page files have uncommitted changes:\n  ${dirty.join('\n  ')}\n` +
				`${UNCOMMITTED_TEXT}.`
		);
	}

	// Best effort: never fails the run.
	git(['fetch', '--quiet'], { timeout: GIT_FETCH_TIMEOUT_MS });
	const behind = git(['rev-list', '--count', 'HEAD..@{u}']);
	const n = parseInt(behind.stdout.trim(), 10);
	if (behind.ok && n > 0) {
		warn(`Your copy is ${n} commit(s) behind; run git pull`);
	}
}

function lastCommitDate(file) {
	const r = git(['log', '-1', '--format=%cI', '--', file]);
	return r.ok ? r.stdout.trim() : '';
}

async function confirm(message) {
	const answer = await inquirer.prompt([
		{ type: 'confirm', name: 'confirm', message, default: false },
	]);
	return answer.confirm === true;
}

/**
 * Run the publish command. Returns the exit code (never calls process.exit).
 * @param {string[]} names page file basenames (with or without .json)
 * @param {{dryRun?: boolean, json?: boolean, confirm?: string}} options
 */
export async function runPublish(names = [], options = {}) {
	const jsonMode = !!options.json;
	// In --json mode stdout carries only the JSON document.
	const say = (msg, color) => {
		const text = color ? chalk[color](msg) : msg;
		if (jsonMode) console.error(text);
		else console.log(text);
	};
	const warn = (msg) => say(msg, 'yellow');
	const fail = (msg) => say(msg, 'red');

	const cwd = process.cwd();
	const layout = detectLayout(cwd);
	if (shouldRefuseLayoutForCommand('publish', layout)) {
		fail(getLegacyLayoutRefusalMessage('publish', layout));
		return EXIT_REFUSED;
	}

	if (jsonMode && !options.dryRun) {
		fail('--json only works together with --dry-run.');
		return EXIT_REFUSED;
	}

	try {
		const config = await loadConfig();
		if (
			!config ||
			!Array.isArray(config.campaigns) ||
			!config.campaigns.length
		) {
			throw new Refusal(
				'No campaigns configured. Run publish from a site repo set up with raisely init.'
			);
		}

		const scoped = await collectLocalPages(cwd, config, names, warn);
		gitChecks(scoped, warn);

		// Snapshot (§3.3 step 5): one list call per campaign.
		const live = new Map();
		try {
			for (const campaignUuid of config.campaigns) {
				const res = await api({
					path: `/campaigns/${campaignUuid}/pages?private=1&includeBody=1&limit=999`,
				});
				for (const page of (res && res.data) || []) {
					live.set(page.uuid, page);
				}
			}
		} catch (e) {
			throw new Refusal(
				`Could not load the live pages: ${toErrorMessage(e)}`,
				EXIT_FAILED
			);
		}

		const pages = [];
		for (const p of scoped) {
			const livePage = live.get(p.data.uuid);
			if (!livePage) {
				warn(
					`Skipping ${p.file}: no live page with uuid ${p.data.uuid} (it may have been deleted)`
				);
				continue;
			}
			const diff = diffPage(p.data, livePage);
			const page = {
				file: p.file,
				uuid: p.data.uuid,
				liveUpdatedAt: livePage.updatedAt,
				revert: false,
				...diff,
			};
			if (page.status === 'copy') {
				page.revert = isRevert(
					livePage.updatedAt,
					lastCommitDate(p.file)
				);
			}
			pages.push(page);
		}

		const digest = reportDigest(pages);
		const report = { digest, pages };
		const blocked = pages.some((p) => p.status === 'blocked');
		const toPublish = pages.filter((p) => p.status === 'copy');

		if (jsonMode) {
			console.log(JSON.stringify(buildJsonReport(report), null, 2));
		} else {
			say(renderPreview(report));
		}

		if (blocked) return EXIT_REFUSED;
		if (!toPublish.length) return EXIT_OK;
		if (options.dryRun) return EXIT_OK;

		let selected = toPublish;
		if (options.confirm !== undefined) {
			if (String(options.confirm).trim() !== digest) {
				throw new Refusal(
					`The digest you confirmed (${options.confirm}) does not match the current digest (${digest}).\n` +
						'The live site or your page files changed since that preview was made. ' +
						`Review the preview above, then ${CONFIRM_HINT}.`
				);
			}
		} else if (!isInteractive()) {
			throw new Refusal(`Not an interactive terminal: ${CONFIRM_HINT}.`);
		} else {
			if (
				!(await confirm(
					`Publish ${toPublish.length} page(s) to the live site?`
				))
			) {
				say('Nothing was published.');
				return EXIT_OK;
			}
			selected = [];
			for (const p of toPublish) {
				if (
					p.revert &&
					!(await confirm(
						`${p.file} was changed on the live site after your copy. Publish it anyway and undo those live changes?`
					))
				) {
					warn(`Skipping ${p.file}`);
					continue;
				}
				selected.push(p);
			}
			if (!selected.length) {
				say('Nothing was published.');
				return EXIT_OK;
			}
		}

		// Write sequentially, with a TOCTOU re-check before each PATCH.
		const results = [];
		for (const p of selected) {
			try {
				const current = await api({
					path: `/pages/${p.uuid}?private=1`,
				});
				const currentUpdatedAt =
					current && current.data && current.data.updatedAt;
				if (!sameInstant(currentUpdatedAt, p.liveUpdatedAt)) {
					results.push({ page: p, ok: false, reason: TOCTOU_TEXT });
					continue;
				}
				await publishPage(p.uuid, p.payload);
				results.push({ page: p, ok: true });
			} catch (e) {
				results.push({ page: p, ok: false, reason: toErrorMessage(e) });
			}
		}

		console.log('');
		for (const r of results) {
			if (r.ok) say(`✓ ${r.page.file}`, 'green');
			else say(`✗ ${r.page.file}: ${r.reason}`, 'red');
		}
		if (results.some((r) => !r.ok)) {
			fail(
				'Some pages were not published. Re-running publish is safe: it only sends what is still different.'
			);
			return EXIT_FAILED;
		}
		say(DONE_TEXT, 'green');
		return EXIT_OK;
	} catch (e) {
		if (e instanceof Refusal) {
			fail(e.message);
			return e.code;
		}
		fail(toErrorMessage(e));
		return EXIT_FAILED;
	}
}

export default async function publish(names, options = {}) {
	const code = await runPublish(names || [], options || {});
	process.exitCode = code;
	return code;
}
