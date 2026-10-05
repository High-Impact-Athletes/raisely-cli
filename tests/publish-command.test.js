import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	spawnSync: vi.fn(),
	prompt: vi.fn(),
	loadConfig: vi.fn(),
}));

vi.mock('../src/actions/api.js', () => ({ default: mocks.api }));
vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal()),
	spawnSync: mocks.spawnSync,
}));
vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }));
vi.mock('../src/config.js', () => ({ loadConfig: mocks.loadConfig }));

import publish, {
	isRevert,
	runPublish,
	CONFIRM_HINT,
	DONE_TEXT,
	DUPLICATE_TEXT,
	TOCTOU_TEXT,
	UNCOMMITTED_TEXT,
} from '../src/publish.js';
import {
	PAYLOAD_FIELDS,
	reportDigest,
	diffPage,
} from '../src/actions/publish-diff.js';
import { publishPage } from '../src/actions/pages.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAMPAIGN = 'campaign-uuid-1';
const CAMPAIGN_PATH = 'race';
const OLD_DATE = '2026-09-01T10:00:00.000Z';
const COMMIT_DATE = '2026-10-01T12:00:00+13:00'; // = 2026-09-30T23:00:00Z

const leaf = (text) => ({ object: 'leaf', text, marks: [] });
const para = (text) => ({
	object: 'block',
	type: 'paragraph',
	data: {},
	nodes: [{ object: 'text', leaves: [leaf(text)] }],
});
const body = (text) => [
	{
		uuid: 'row-1',
		data: { spacing: 'normal' },
		cells: [
			{
				uuid: 'cell-1',
				type: 'slate',
				data: {
					document: {
						object: 'document',
						data: {},
						nodes: [para(text)],
					},
				},
			},
		],
	},
];

function livePage(name, overrides = {}) {
	return {
		uuid: `uuid-${name}`,
		path: `/${name}`,
		title: `${name} title`,
		internalTitle: name,
		name,
		status: 'PUBLISHED',
		body: body(`${name} text`),
		provider: null,
		condition: null,
		image: null,
		metaDescription: null,
		socialTitle: null,
		socialDescription: null,
		protected: false,
		hash: 'jwt-differs-every-time',
		public: {},
		updatedAt: OLD_DATE,
		...overrides,
	};
}

function fileFor(live, overrides = {}) {
	const { hash, public: _p, updatedAt, ...rest } = live;
	return { ...rest, campaignUuid: CAMPAIGN, ...overrides };
}

// ---------------------------------------------------------------------------
// Harness: temp repo dir, mocked git, mocked API, mocked prompt, TTY flags.
// ---------------------------------------------------------------------------

let tmp;
let state;
let out;
let err;
const ttyBackup = {};

function writePage(name, data, campaignPath = CAMPAIGN_PATH) {
	const dir = path.join(tmp, 'campaigns', campaignPath, 'pages');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.json`);
	fs.writeFileSync(
		file,
		typeof data === 'string' ? data : JSON.stringify(data, null, 4)
	);
	return path.relative(tmp, file);
}

function setTTY(value) {
	Object.defineProperty(process.stdin, 'isTTY', {
		value,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(process.stdout, 'isTTY', {
		value,
		configurable: true,
		writable: true,
	});
}

function gitImpl(cmd, args) {
	const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
	const [sub] = args;
	state.gitCalls.push(args.join(' '));
	if (sub === 'rev-parse') {
		return state.insideWorkTree
			? ok('true\n')
			: {
					status: 128,
					stdout: '',
					stderr: 'fatal: not a git repository',
				};
	}
	if (sub === 'status') {
		const file = args[args.length - 1];
		return ok(state.dirty.has(file) ? ` M ${file}\n` : '');
	}
	if (sub === 'fetch') return ok();
	if (sub === 'rev-list') return ok(`${state.behind}\n`);
	if (sub === 'log') {
		const file = args[args.length - 1];
		return ok(`${state.commitDates[file] || COMMIT_DATE}\n`);
	}
	return { status: 1, stdout: '', stderr: 'unexpected git call' };
}

function apiImpl(opts) {
	const method = opts.method || 'GET';
	state.apiCalls.push({ method, path: opts.path, json: opts.json });
	const listMatch = opts.path.match(/^\/campaigns\/([^/]+)\/pages\?/);
	if (method === 'GET' && listMatch) {
		return Promise.resolve({
			data: state.live.filter(
				(p) => (p.$campaign || CAMPAIGN) === listMatch[1]
			),
		});
	}
	const pageMatch = opts.path.match(/^\/pages\/([^?]+)\?private=1$/);
	if (pageMatch && method === 'GET') {
		const page = state.live.find((p) => p.uuid === pageMatch[1]);
		const updatedAt =
			state.updatedAtOnRecheck[pageMatch[1]] || page.updatedAt;
		return Promise.resolve({ data: { ...page, updatedAt } });
	}
	if (pageMatch && method === 'PATCH') {
		if (state.patchRejects.has(pageMatch[1])) {
			return Promise.reject(
				`https://api.raisely.com/v3/pages/${pageMatch[1]}?private=1 (400) failed with message: Bad Request`
			);
		}
		return Promise.resolve({ data: {} });
	}
	return Promise.reject(`unexpected api call ${method} ${opts.path}`);
}

const patches = () => state.apiCalls.filter((c) => c.method === 'PATCH');
const output = () => out.join('\n');

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raisely-publish-'));
	vi.spyOn(process, 'cwd').mockReturnValue(tmp);
	out = [];
	err = [];
	vi.spyOn(console, 'log').mockImplementation((...a) =>
		out.push(a.join(' '))
	);
	vi.spyOn(console, 'error').mockImplementation((...a) =>
		err.push(a.join(' '))
	);
	state = {
		insideWorkTree: true,
		dirty: new Set(),
		behind: 0,
		commitDates: {},
		live: [],
		updatedAtOnRecheck: {},
		patchRejects: new Set(),
		apiCalls: [],
		gitCalls: [],
	};
	mocks.api.mockReset().mockImplementation(apiImpl);
	mocks.spawnSync.mockReset().mockImplementation(gitImpl);
	mocks.prompt.mockReset().mockResolvedValue({ confirm: false });
	mocks.loadConfig.mockReset().mockResolvedValue({ campaigns: [CAMPAIGN] });
	ttyBackup.stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
	ttyBackup.stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
	setTTY(false);
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of ['stdin', 'stdout']) {
		if (ttyBackup[key]) {
			Object.defineProperty(process[key], 'isTTY', ttyBackup[key]);
		} else {
			delete process[key].isTTY;
		}
	}
	process.exitCode = undefined;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** Live about + contact; local about has a title change. */
function setupAboutCopyChange() {
	const about = livePage('about');
	const contact = livePage('contact');
	state.live = [about, contact];
	writePage('about', fileFor(about, { title: 'About us, rewritten' }));
	writePage('contact', fileFor(contact));
	return { about, contact };
}

/** Current digest for the given local/live pairs. */
function digestFor(pairs) {
	return reportDigest(
		pairs.map(([local, live]) => ({
			uuid: live.uuid,
			liveUpdatedAt: live.updatedAt,
			...diffPage(local, live),
		}))
	);
}

function assertPayloadsMinimal() {
	for (const call of patches()) {
		const keys = Object.keys(call.json.data);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(PAYLOAD_FIELDS).toContain(key);
	}
}

// ---------------------------------------------------------------------------
// AC-4 safety refusals
// ---------------------------------------------------------------------------

describe('AC-4 safety refusals (exit 2, nothing PATCHed)', () => {
	test('AC-4 duplicate uuid across two in-scope files', async () => {
		const { about } = setupAboutCopyChange();
		writePage('legacy', fileFor(about, { name: 'legacy' }));

		const code = await runPublish([], { confirm: 'whatever' });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(DUPLICATE_TEXT);
		expect(output()).toContain('campaigns/race/pages/about.json');
		expect(output()).toContain('campaigns/race/pages/legacy.json');
	});

	test('AC-4 duplicate uuid blocks when only one of the two files is in scope', async () => {
		const { about } = setupAboutCopyChange();
		writePage('legacy', fileFor(about, { name: 'legacy' }));

		const code = await runPublish(['about'], { dryRun: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(DUPLICATE_TEXT);
	});

	test('AC-4 duplicate uuid outside scope does not block', async () => {
		const { about } = setupAboutCopyChange();
		writePage('legacy', fileFor(about, { name: 'legacy' }));

		const code = await runPublish(['contact'], { dryRun: true });

		expect(code).toBe(0);
	});

	test('AC-4 uncommitted in-scope page file', async () => {
		setupAboutCopyChange();
		state.dirty.add('campaigns/race/pages/about.json');

		const code = await runPublish([], { confirm: 'whatever' });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(UNCOMMITTED_TEXT);
		expect(output()).toContain('campaigns/race/pages/about.json');
		// refused before the snapshot
		expect(state.apiCalls).toHaveLength(0);
	});

	test('AC-4 uncommitted file outside scope does not block', async () => {
		setupAboutCopyChange();
		state.dirty.add('campaigns/race/pages/contact.json');

		const code = await runPublish(['about'], { dryRun: true });

		expect(code).toBe(0);
	});

	test('AC-4 not inside a git work tree', async () => {
		setupAboutCopyChange();
		state.insideWorkTree = false;

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toMatch(/not inside a git repository/);
	});

	test('AC-4 non-TTY run without --confirm', async () => {
		const { about } = setupAboutCopyChange();
		const digest = digestFor([
			[fileFor(about, { title: 'About us, rewritten' }), about],
		]);

		const code = await runPublish([], {});

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(`Digest: ${digest}`);
		expect(output()).toContain(CONFIRM_HINT);
		expect(mocks.prompt).not.toHaveBeenCalled();
	});

	test('AC-4 non-TTY when only stdout is a TTY still refuses', async () => {
		setupAboutCopyChange();
		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			configurable: true,
			writable: true,
		});

		const code = await runPublish([], {});

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(mocks.prompt).not.toHaveBeenCalled();
	});

	test('AC-4 non-TTY run with a wrong digest', async () => {
		const { about } = setupAboutCopyChange();
		const digest = digestFor([
			[fileFor(about, { title: 'About us, rewritten' }), about],
		]);

		const code = await runPublish([], { confirm: '000000000000' });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(digest);
		expect(output()).toMatch(/does not match the current digest/);
		expect(output()).toMatch(/live site or your page files changed/);
	});

	test('AC-4 wrong digest after live moved (stale --confirm)', async () => {
		const { about } = setupAboutCopyChange();
		const oldDigest = digestFor([
			[fileFor(about, { title: 'About us, rewritten' }), about],
		]);
		about.updatedAt = '2026-10-02T00:00:00.000Z';

		const code = await runPublish([], { confirm: oldDigest });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
	});

	test('AC-4 any blocked change in scope', async () => {
		const about = livePage('about');
		const contact = livePage('contact');
		state.live = [about, contact];
		writePage('about', fileFor(about, { title: 'New title' }));
		writePage('contact', fileFor(contact, { status: 'DRAFT' }));

		const code = await runPublish([], { confirm: 'anything' });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toMatch(/BLOCKED/);
		expect(output()).toMatch(/Nothing was published/);
	});

	test('AC-4 any blocked change in scope, interactive TTY never prompts', async () => {
		const contact = livePage('contact');
		state.live = [contact];
		writePage('contact', fileFor(contact, { path: '/elsewhere' }));
		setTTY(true);
		mocks.prompt.mockResolvedValue({ confirm: true });

		const code = await runPublish([], {});

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(mocks.prompt).not.toHaveBeenCalled();
	});

	test('AC-4 dry-run with blockers exits 2', async () => {
		const contact = livePage('contact');
		state.live = [contact];
		writePage('contact', fileFor(contact, { protected: true }));

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
	});

	test('AC-4 unknown page name', async () => {
		setupAboutCopyChange();

		const code = await runPublish(['about', 'nope', 'missing.json'], {
			confirm: 'anything',
		});

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain('nope');
		expect(output()).toContain('missing.json');
		expect(state.apiCalls).toHaveLength(0);
	});

	test('AC-4 unparseable in-scope page file', async () => {
		setupAboutCopyChange();
		writePage('broken', '{ not json');

		const code = await runPublish(['broken'], { dryRun: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
		expect(output()).toMatch(/not valid JSON/);
	});

	test('AC-4 unparseable page outside scope is skipped', async () => {
		setupAboutCopyChange();
		writePage('broken', '{ not json');

		const code = await runPublish(['about'], { dryRun: true });

		expect(code).toBe(0);
	});

	test('AC-4 a page blocked outside the pages... scope does not stop an in-scope copy change', async () => {
		const about = livePage('about');
		const contact = livePage('contact');
		state.live = [about, contact];
		const localAbout = fileFor(about, { title: 'About us, rewritten' });
		writePage('about', localAbout);
		writePage('contact', fileFor(contact, { status: 'DRAFT' }));
		const digest = digestFor([[localAbout, about]]);

		const code = await runPublish(['about.json'], { confirm: digest });

		expect(code).toBe(0);
		expect(patches()).toHaveLength(1);
		expect(patches()[0].path).toBe('/pages/uuid-about?private=1');
		expect(patches()[0].json).toEqual({
			data: { title: 'About us, rewritten' },
		});
		assertPayloadsMinimal();
		expect(output()).not.toMatch(/BLOCKED/);
		expect(output()).toContain(DONE_TEXT);
	});

	test('AC-4 there is no force flag: --force/--yes are ignored and still refuse in non-TTY', async () => {
		setupAboutCopyChange();

		const code = await runPublish([], { force: true, yes: true, f: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC-5 TOCTOU and failures
// ---------------------------------------------------------------------------

describe('AC-5 TOCTOU and failures', () => {
	function setupTwoCopyChanges() {
		const about = livePage('about');
		const contact = livePage('contact');
		state.live = [about, contact];
		const localAbout = fileFor(about, { title: 'About, new' });
		const localContact = fileFor(contact, {
			body: body('contact text, new'),
		});
		writePage('about', localAbout);
		writePage('contact', localContact);
		return digestFor([
			[localAbout, about],
			[localContact, contact],
		]);
	}

	test('AC-5 pre-PATCH GET with a different updatedAt skips that page and exits 1', async () => {
		const digest = setupTwoCopyChanges();
		state.updatedAtOnRecheck['uuid-about'] = '2026-10-05T01:00:00.000Z';

		const code = await runPublish([], { confirm: digest });

		expect(code).toBe(1);
		expect(patches().map((c) => c.path)).toEqual([
			'/pages/uuid-contact?private=1',
		]);
		expect(output()).toContain(
			`✗ campaigns/race/pages/about.json: ${TOCTOU_TEXT}`
		);
		expect(output()).toContain('✓ campaigns/race/pages/contact.json');
		expect(output()).not.toContain(DONE_TEXT);
		assertPayloadsMinimal();
	});

	test('AC-5 the TOCTOU GET happens immediately before each PATCH, sequentially', async () => {
		const digest = setupTwoCopyChanges();

		const code = await runPublish([], { confirm: digest });

		expect(code).toBe(0);
		const writes = state.apiCalls
			.filter((c) => c.path.startsWith('/pages/'))
			.map((c) => `${c.method} ${c.path}`);
		expect(writes).toEqual([
			'GET /pages/uuid-about?private=1',
			'PATCH /pages/uuid-about?private=1',
			'GET /pages/uuid-contact?private=1',
			'PATCH /pages/uuid-contact?private=1',
		]);
		expect(patches()[1].json).toEqual({
			data: { body: body('contact text, new') },
		});
		assertPayloadsMinimal();
		expect(output()).toContain(DONE_TEXT);
	});

	test('AC-5 one of two PATCHes rejects: the other still runs, ✓/✗ listed, exit 1', async () => {
		const digest = setupTwoCopyChanges();
		state.patchRejects.add('uuid-about');

		const code = await runPublish([], { confirm: digest });

		expect(code).toBe(1);
		expect(patches().map((c) => c.path)).toEqual([
			'/pages/uuid-about?private=1',
			'/pages/uuid-contact?private=1',
		]);
		expect(output()).toMatch(
			/✗ campaigns\/race\/pages\/about\.json: .*\(400\) failed with message: Bad Request/
		);
		expect(output()).toContain('✓ campaigns/race/pages/contact.json');
		expect(output()).not.toContain(DONE_TEXT);
		assertPayloadsMinimal();
	});

	test('AC-5 snapshot API failure exits 1 without PATCHing', async () => {
		setupAboutCopyChange();
		mocks.api.mockImplementation(() =>
			Promise.reject('https://api.raisely.com/v3/campaigns (403) failed')
		);

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(1);
		expect(output()).toMatch(/Could not load the live pages: .*403/);
	});
});

// ---------------------------------------------------------------------------
// AC-6 REVERT
// ---------------------------------------------------------------------------

describe('AC-6 REVERT', () => {
	function setupRevert() {
		const about = livePage('about', {
			updatedAt: '2026-10-03T09:00:00.000Z',
		});
		const contact = livePage('contact');
		state.live = [about, contact];
		writePage('about', fileFor(about, { title: 'About, new' }));
		writePage('contact', fileFor(contact, { title: 'Contact, new' }));
		state.commitDates['campaigns/race/pages/about.json'] =
			'2026-10-02T09:00:00+02:00';
		state.commitDates['campaigns/race/pages/contact.json'] =
			'2026-10-02T09:00:00+02:00';
	}

	test('AC-6 live updatedAt newer than the last commit → revert: true in --json', async () => {
		setupRevert();

		const code = await runPublish([], { dryRun: true, json: true });

		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		const report = JSON.parse(out[0]);
		const about = report.pages.find((p) => p.uuid === 'uuid-about');
		const contact = report.pages.find((p) => p.uuid === 'uuid-contact');
		expect(about.revert).toBe(true);
		expect(contact.revert).toBe(false);
		expect(report.digest).toMatch(/^[0-9a-f]{12}$/);
		expect(about.liveUpdatedAt).toBe('2026-10-03T09:00:00.000Z');
		expect(patches()).toHaveLength(0);
		expect(state.gitCalls).toContain(
			'log -1 --format=%cI -- campaigns/race/pages/about.json'
		);
	});

	test('AC-6 interactive: per-page REVERT confirm defaults to No and declining skips the PATCH', async () => {
		setupRevert();
		setTTY(true);
		mocks.prompt
			.mockResolvedValueOnce({ confirm: true }) // global
			.mockResolvedValueOnce({ confirm: false }); // REVERT about

		const code = await runPublish([], {});

		expect(code).toBe(0);
		expect(mocks.prompt).toHaveBeenCalledTimes(2);
		const [globalQ] = mocks.prompt.mock.calls[0][0];
		const [revertQ] = mocks.prompt.mock.calls[1][0];
		expect(globalQ.type).toBe('confirm');
		expect(globalQ.default).toBe(false);
		expect(globalQ.message).toBe('Publish 2 page(s) to the live site?');
		expect(revertQ.type).toBe('confirm');
		expect(revertQ.default).toBe(false);
		expect(revertQ.message).toContain('about.json');
		expect(patches().map((c) => c.path)).toEqual([
			'/pages/uuid-contact?private=1',
		]);
		expect(output()).toContain('REVERT');
		assertPayloadsMinimal();
	});

	test('AC-6 interactive: accepting the REVERT confirm publishes the page', async () => {
		setupRevert();
		setTTY(true);
		mocks.prompt.mockResolvedValue({ confirm: true });

		const code = await runPublish([], {});

		expect(code).toBe(0);
		expect(patches()).toHaveLength(2);
	});

	test('AC-6 interactive: declining the global confirm writes nothing', async () => {
		setupRevert();
		setTTY(true);
		mocks.prompt.mockResolvedValueOnce({ confirm: false });

		const code = await runPublish([], {});

		expect(code).toBe(0);
		expect(mocks.prompt).toHaveBeenCalledTimes(1);
		expect(patches()).toHaveLength(0);
		expect(output()).toMatch(/Nothing was published/);
	});

	test('AC-6 isRevert compares instants across timezones', () => {
		// 09:30Z is later than 10:00+02:00 (= 08:00Z)
		expect(
			isRevert('2026-10-02T09:30:00.000Z', '2026-10-02T10:00:00+02:00')
		).toBe(true);
		// 07:30Z is earlier than 08:00Z
		expect(
			isRevert('2026-10-02T07:30:00.000Z', '2026-10-02T10:00:00+02:00')
		).toBe(false);
		expect(
			isRevert('2026-10-02T08:00:00.000Z', '2026-10-02T10:00:00+02:00')
		).toBe(false);
		// unknown commit date: conservative
		expect(isRevert('2026-10-02T08:00:00.000Z', '')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Other behaviour (§3.1-§3.3, §3.7)
// ---------------------------------------------------------------------------

describe('publish command behaviour', () => {
	test('nothing to publish exits 0 without prompting', async () => {
		const about = livePage('about');
		state.live = [about];
		writePage('about', fileFor(about));
		setTTY(true);

		const code = await runPublish([], {});

		expect(code).toBe(0);
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(output()).toMatch(/Nothing to publish/);
	});

	test('dry-run never writes and exits 0', async () => {
		const { about } = setupAboutCopyChange();
		const digest = digestFor([
			[fileFor(about, { title: 'About us, rewritten' }), about],
		]);

		const code = await runPublish([], { dryRun: true, confirm: digest });

		expect(code).toBe(0);
		expect(patches()).toHaveLength(0);
		expect(output()).toContain(`Digest: ${digest}`);
	});

	test('snapshot uses one list call per campaign', async () => {
		setupAboutCopyChange();
		mocks.loadConfig.mockResolvedValue({
			campaigns: [CAMPAIGN, 'campaign-uuid-2'],
		});

		await runPublish([], { dryRun: true });

		expect(state.apiCalls.map((c) => c.path)).toEqual([
			`/campaigns/${CAMPAIGN}/pages?private=1&includeBody=1&limit=999`,
			'/campaigns/campaign-uuid-2/pages?private=1&includeBody=1&limit=999',
		]);
	});

	test('in-scope page with no live match is a warning and is skipped', async () => {
		setupAboutCopyChange();
		writePage('ghost', fileFor(livePage('ghost'), { title: 'x' }));

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(0);
		expect(output()).toMatch(
			/Skipping campaigns\/race\/pages\/ghost\.json: no live page/
		);
	});

	test('files with no uuid or a foreign campaignUuid are skipped', async () => {
		setupAboutCopyChange();
		writePage('nouuid', { title: 'x' });
		writePage(
			'foreign',
			fileFor(livePage('foreign'), {
				campaignUuid: 'other',
				status: 'DRAFT',
			})
		);

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(0);
	});

	test('behind upstream prints a warning only', async () => {
		setupAboutCopyChange();
		state.behind = 3;

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(0);
		expect(output()).toMatch(/3 commit\(s\) behind; run git pull/);
		const fetchCall = mocks.spawnSync.mock.calls.find(
			([, args]) => args[0] === 'fetch'
		);
		expect(fetchCall[1]).toEqual(['fetch', '--quiet']);
		expect(fetchCall[2].timeout).toBe(10000);
	});

	test('--json without --dry-run is refused', async () => {
		setupAboutCopyChange();

		const code = await runPublish([], { json: true });

		expect(code).toBe(2);
		expect(patches()).toHaveLength(0);
	});

	test('--json keeps stdout pure JSON', async () => {
		setupAboutCopyChange();
		state.behind = 1;

		const code = await runPublish([], { dryRun: true, json: true });

		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		expect(() => JSON.parse(out[0])).not.toThrow();
		expect(err.join('\n')).toMatch(/behind/);
	});

	test('default export sets process.exitCode', async () => {
		setupAboutCopyChange();

		const code = await publish([], {});

		expect(code).toBe(2);
		expect(process.exitCode).toBe(2);
	});

	test('refuses on a legacy layout before doing anything', async () => {
		fs.mkdirSync(path.join(tmp, 'pages'), { recursive: true });
		setupAboutCopyChange();

		const code = await runPublish([], { dryRun: true });

		expect(code).toBe(2);
		expect(output()).toMatch(/Cannot run `raisely publish`/);
		expect(state.apiCalls).toHaveLength(0);
		expect(state.gitCalls).toHaveLength(0);
	});
});

describe('AC-3 publishPage helper (defence in depth)', () => {
	test('AC-3 publishPage PATCHes only the given payload', async () => {
		await publishPage('uuid-x', { title: 'T', body: [] });
		expect(state.apiCalls).toEqual([
			{
				method: 'PATCH',
				path: '/pages/uuid-x?private=1',
				json: { data: { title: 'T', body: [] } },
			},
		]);
	});

	test.each([
		'status',
		'path',
		'protected',
		'condition',
		'provider',
		'name',
		'internalTitle',
		'image',
		'public',
	])('AC-3 publishPage refuses a payload containing %s', async (field) => {
		await expect(
			publishPage('uuid-x', { title: 'T', [field]: 'x' })
		).rejects.toThrow(field);
		expect(patches()).toHaveLength(0);
	});
});
