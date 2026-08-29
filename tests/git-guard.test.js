import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULT_STALE_AFTER_MINUTES,
	formatAge,
	gateDeploy,
	gateUpdate,
	getGitState,
	getRepoKey,
	parsePorcelain,
	readSyncMarker,
	resolveStaleAfterMs,
	writeSyncMarker,
} from '../src/actions/git-guard.js';

const MINUTE = 60 * 1000;

function makeTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'raisely-git-guard-'));
}

function git(cwd, ...args) {
	return execFileSync(
		'git',
		['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
		{ cwd, stdio: ['ignore', 'pipe', 'pipe'] }
	)
		.toString()
		.trim();
}

function makeRepo() {
	const dir = makeTempDir();
	git(dir, 'init');
	fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', 'init');
	return dir;
}

// env stub that never bypasses the gates, regardless of the host shell
const CLEAN_ENV = {};

// ---------------------------------------------------------------------------
// parsePorcelain
// ---------------------------------------------------------------------------

test('parsePorcelain keeps real changes and drops blank lines', () => {
	const lines = parsePorcelain(
		' M components/foo/foo.js\n?? components/bar/\n\n'
	);
	assert.deepEqual(lines, [' M components/foo/foo.js', '?? components/bar/']);
});

test('parsePorcelain ignores the CLI-managed config files', () => {
	const lines = parsePorcelain('?? .raisely.json\n M raisely.json\n');
	assert.deepEqual(lines, []);
});

test('parsePorcelain handles renames and quoted paths', () => {
	assert.deepEqual(parsePorcelain('R  old.js -> new.js\n'), [
		'R  old.js -> new.js',
	]);
	assert.deepEqual(parsePorcelain('?? "has space.js"\n'), [
		'?? "has space.js"',
	]);
	// a rename INTO .raisely.json still counts as managed
	assert.deepEqual(parsePorcelain('R  config.json -> .raisely.json\n'), []);
});

// ---------------------------------------------------------------------------
// getGitState
// ---------------------------------------------------------------------------

test('getGitState reports non-repo directories', () => {
	const dir = makeTempDir();
	const state = getGitState(dir);
	assert.equal(state.isRepo, false);
	assert.deepEqual(state.dirtyFiles, []);
});

test('getGitState reports a clean repo', () => {
	const dir = makeRepo();
	const state = getGitState(dir);
	assert.equal(state.isRepo, true);
	assert.deepEqual(state.dirtyFiles, []);
});

test('getGitState reports untracked and modified files', () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
	fs.writeFileSync(path.join(dir, 'new.js'), 'x\n');
	const state = getGitState(dir);
	assert.equal(state.isRepo, true);
	assert.equal(state.dirtyFiles.length, 2);
});

test('getGitState treats an untracked .raisely.json as clean', () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, '.raisely.json'), '{}\n');
	const state = getGitState(dir);
	assert.deepEqual(state.dirtyFiles, []);
});

// ---------------------------------------------------------------------------
// sync markers
// ---------------------------------------------------------------------------

test('readSyncMarker returns null when no marker file exists', () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	assert.equal(readSyncMarker(dir, { markerFile }), null);
});

test('writeSyncMarker / readSyncMarker round-trip, keyed by repo root', () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	const now = Date.parse('2026-08-29T10:00:00.000Z');
	writeSyncMarker(dir, { markerFile, now });
	assert.equal(readSyncMarker(dir, { markerFile }), now);

	// reading from a subdirectory of the repo resolves to the same key
	const sub = path.join(dir, 'components');
	fs.mkdirSync(sub);
	assert.equal(readSyncMarker(sub, { markerFile }), now);
});

test('writeSyncMarker survives a corrupt marker file', () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	fs.writeFileSync(markerFile, 'not json');
	assert.equal(readSyncMarker(dir, { markerFile }), null);
	const now = Date.now();
	writeSyncMarker(dir, { markerFile, now });
	assert.equal(readSyncMarker(dir, { markerFile }), now);
});

test('markers for different repos do not collide', () => {
	const a = makeRepo();
	const b = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	writeSyncMarker(a, { markerFile, now: 1000 });
	writeSyncMarker(b, { markerFile, now: 2000 });
	assert.equal(readSyncMarker(a, { markerFile }), 1000);
	assert.equal(readSyncMarker(b, { markerFile }), 2000);
	assert.notEqual(getRepoKey(a), getRepoKey(b));
});

// ---------------------------------------------------------------------------
// resolveStaleAfterMs
// ---------------------------------------------------------------------------

test('resolveStaleAfterMs defaults to 5 minutes', () => {
	assert.equal(resolveStaleAfterMs({}), DEFAULT_STALE_AFTER_MINUTES * MINUTE);
});

test('resolveStaleAfterMs reads staleAfterMinutes from config', () => {
	assert.equal(
		resolveStaleAfterMs({ config: { staleAfterMinutes: 15 } }),
		15 * MINUTE
	);
});

test('resolveStaleAfterMs lets the flag beat the config', () => {
	assert.equal(
		resolveStaleAfterMs({
			config: { staleAfterMinutes: 15 },
			options: { staleAfter: 2 },
		}),
		2 * MINUTE
	);
});

test('resolveStaleAfterMs: config false disables the check', () => {
	assert.equal(
		resolveStaleAfterMs({ config: { staleAfterMinutes: false } }),
		null
	);
});

test('resolveStaleAfterMs falls back to the default on junk values', () => {
	assert.equal(
		resolveStaleAfterMs({ config: { staleAfterMinutes: 'soon' } }),
		DEFAULT_STALE_AFTER_MINUTES * MINUTE
	);
	assert.equal(
		resolveStaleAfterMs({ config: { staleAfterMinutes: -3 } }),
		DEFAULT_STALE_AFTER_MINUTES * MINUTE
	);
});

// ---------------------------------------------------------------------------
// formatAge
// ---------------------------------------------------------------------------

test('formatAge renders seconds, minutes, hours and days', () => {
	assert.equal(formatAge(30 * 1000), '30s');
	assert.equal(formatAge(5 * MINUTE), '5m');
	assert.equal(formatAge(3 * 60 * MINUTE + 12 * MINUTE), '3h 12m');
	assert.equal(formatAge(50 * 60 * MINUTE), '2d 2h');
});

// ---------------------------------------------------------------------------
// gateUpdate
// ---------------------------------------------------------------------------

test('gateUpdate passes on a clean repo', () => {
	const dir = makeRepo();
	assert.equal(gateUpdate({ cwd: dir, env: CLEAN_ENV }), true);
});

test('gateUpdate blocks on a dirty repo', () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, 'wip.js'), 'x\n');
	assert.equal(gateUpdate({ cwd: dir, env: CLEAN_ENV }), false);
});

test('gateUpdate is not bypassed by --force', () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, 'wip.js'), 'x\n');
	assert.equal(
		gateUpdate({ cwd: dir, options: { force: true }, env: CLEAN_ENV }),
		false
	);
});

test('gateUpdate honours --allow-dirty and RAISELY_ALLOW_DIRTY=1', () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, 'wip.js'), 'x\n');
	assert.equal(
		gateUpdate({ cwd: dir, options: { allowDirty: true }, env: CLEAN_ENV }),
		true
	);
	assert.equal(
		gateUpdate({ cwd: dir, env: { RAISELY_ALLOW_DIRTY: '1' } }),
		true
	);
});

test('gateUpdate warns but passes outside a git repo', () => {
	const dir = makeTempDir();
	assert.equal(gateUpdate({ cwd: dir, env: CLEAN_ENV }), true);
});

// ---------------------------------------------------------------------------
// gateDeploy
// ---------------------------------------------------------------------------

function deployArgs(dir, overrides = {}) {
	return {
		cwd: dir,
		config: {},
		options: {},
		env: CLEAN_ENV,
		markerFile: path.join(makeTempDir(), 'markers.json'),
		prompt: async () => {
			throw new Error('prompt should not be called');
		},
		...overrides,
	};
}

test('gateDeploy passes with a fresh marker', async () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	const now = Date.now();
	writeSyncMarker(dir, { markerFile, now: now - 2 * MINUTE });
	assert.equal(await gateDeploy(deployArgs(dir, { markerFile, now })), true);
});

test('gateDeploy blocks non-interactive deploys with a stale marker', async () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	const now = Date.now();
	writeSyncMarker(dir, { markerFile, now: now - 10 * MINUTE });
	assert.equal(
		await gateDeploy(
			deployArgs(dir, { markerFile, now, options: { force: true } })
		),
		false
	);
});

test('gateDeploy blocks non-interactive deploys with no marker at all', async () => {
	const dir = makeRepo();
	assert.equal(
		await gateDeploy(deployArgs(dir, { options: { force: true } })),
		false
	);
});

test('gateDeploy respects a custom --stale-after threshold', async () => {
	const dir = makeRepo();
	const markerFile = path.join(makeTempDir(), 'markers.json');
	const now = Date.now();
	writeSyncMarker(dir, { markerFile, now: now - 10 * MINUTE });
	assert.equal(
		await gateDeploy(
			deployArgs(dir, {
				markerFile,
				now,
				options: { force: true, staleAfter: 30 },
			})
		),
		true
	);
});

test('gateDeploy honours --allow-stale, env bypass, and config disable', async () => {
	const dir = makeRepo();
	assert.equal(
		await gateDeploy(
			deployArgs(dir, { options: { force: true, allowStale: true } })
		),
		true
	);
	assert.equal(
		await gateDeploy(
			deployArgs(dir, {
				options: { force: true },
				env: { RAISELY_ALLOW_STALE: '1' },
			})
		),
		true
	);
	assert.equal(
		await gateDeploy(
			deployArgs(dir, {
				options: { force: true },
				config: { staleAfterMinutes: false },
			})
		),
		true
	);
});

test('gateDeploy prompts interactively on a stale marker and obeys the answer', async () => {
	const dir = makeRepo();
	let asked = 0;
	const yes = await gateDeploy(
		deployArgs(dir, {
			prompt: async () => {
				asked += 1;
				return { confirm: true };
			},
		})
	);
	assert.equal(yes, true);
	assert.equal(asked, 1);

	const no = await gateDeploy(
		deployArgs(dir, { prompt: async () => ({ confirm: false }) })
	);
	assert.equal(no, false);
});

test('gateDeploy never blocks on a dirty tree (advisory only)', async () => {
	const dir = makeRepo();
	fs.writeFileSync(path.join(dir, 'wip.js'), 'x\n');
	const markerFile = path.join(makeTempDir(), 'markers.json');
	const now = Date.now();
	writeSyncMarker(dir, { markerFile, now });
	assert.equal(
		await gateDeploy(
			deployArgs(dir, { markerFile, now, options: { force: true } })
		),
		true
	);
});
