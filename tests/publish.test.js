import { describe, expect, test } from 'vitest';

import {
	BLOCKED_FIELDS,
	BLOCKED_TEXT,
	COPY_FIELDS,
	LANGUAGES_TEXT,
	REVERT_TEXT,
	buildJsonReport,
	buildPayload,
	canonicalJson,
	classifyPage,
	computeDigest,
	diffPage,
	humaniseFieldPath,
	normalisePage,
	renderPreview,
	reportDigest,
	slateSkeleton,
	truncatePair,
} from '../src/actions/publish-diff.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures, shaped like the prod data described in SPEC §2.
// ---------------------------------------------------------------------------

const leaf = (text, marks = []) => ({
	object: 'leaf',
	text,
	marks: marks.map((type) => ({ object: 'mark', type, data: {} })),
});
const textNode = (...leaves) => ({ object: 'text', leaves });
const emptyText = () => textNode(leaf(''));
const block = (type, nodes, data = {}) => ({
	object: 'block',
	type,
	data,
	nodes,
});
const para = (text) => block('paragraph', [textNode(leaf(text))]);
const heading = (text) =>
	block('heading', [textNode(leaf(text))], { level: 2 });
const link = (href, text) => ({
	object: 'inline',
	type: 'link',
	data: { href },
	nodes: [textNode(leaf(text))],
});
const image = (src) =>
	block('image', [emptyText()], {
		editable: {
			align: { value: 'center' },
			src: { value: src },
			alt: { value: '' },
			width: { value: 545 },
		},
	});
const component = (name, editable) =>
	block('custom-component', [emptyText()], {
		customComponent: name,
		editable,
	});
const feedComponent = () =>
	component('RaiselyFeed', {
		heading: { value: 'How it works' },
		headingSize: { value: 'h4' },
		feedItems: {
			value: [
				{
					heading: 'Choose your cause',
					description: '',
					image: 'https://raisely-images.imgix.net/a.jpg',
					button: 'Choose cause',
					link: '#select-fund',
				},
				{
					heading: 'Set your goal',
					description: '',
					image: 'https://raisely-images.imgix.net/b.jpg',
					button: 'Set goal',
					link: '#choose-goal',
				},
			],
		},
		cause1Link: { value: '/causes/one', label: 'Cause 1 link' },
		ctaText: { value: 'Learn more' },
		hero: {
			value: 'https://raisely-images.imgix.net/hero.jpg',
			type: 'image',
			label: 'Hero image',
		},
		intro: {
			value: 'Welcome',
			type: 'textarea',
			label: 'Intro',
			help: 'Short intro',
			default: 'Hello',
		},
	});
const slateCell = (uuid, nodes) => ({
	uuid,
	type: 'slate',
	data: {
		object: 'value',
		document: { object: 'document', data: {}, nodes },
	},
});
const row = (uuid, cells, data = {}) => ({
	uuid,
	data: { spacing: 'medium', background: 'white', ...data },
	cells,
});

function basePage() {
	return {
		uuid: 'page-uuid-1',
		path: 'about',
		title: 'About us',
		internalTitle: 'About',
		name: 'about',
		status: 'published',
		body: [
			row('row-1', [
				slateCell('cell-1', [
					heading('Race for something bigger'),
					para('First paragraph.'),
					para('Second paragraph.'),
				]),
			]),
			row('row-2', [
				slateCell('cell-2', [
					block('paragraph', [
						textNode(leaf('Read more ')),
						link('https://highimpactathletes.org/', 'here'),
						textNode(leaf('.')),
					]),
					image('https://raisely-images.imgix.net/about.jpg'),
				]),
			]),
			row('row-3', [
				slateCell('cell-3', [feedComponent(), para('After feed.')]),
			]),
			row('row-4', [
				slateCell('cell-4', [
					component('HeroBanner', { heading: { value: 'Hi' } }),
				]),
				{ uuid: 'cell-5', type: 'html', data: { html: '<p>raw</p>' } },
			]),
		],
		provider: 'raisely',
		condition: null,
		image: null,
		metaDescription: 'About the race',
		socialTitle: null,
		socialDescription: 'Share this',
		protected: false,
		campaignUuid: 'campaign-uuid-1',
	};
}

/** A live API object: same data plus fields publish must ignore. */
function livePage() {
	return {
		...basePage(),
		hash: 'eyJhbGciOi.live-jwt.sig',
		public: { foo: 'bar' },
		html: '<p>rendered</p>',
		tags: [],
		private: {},
		updatedAt: '2026-09-30T10:00:00.000Z',
		lockVersion: 0,
	};
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Recursively reverse key order to prove order-independence. */
function reverseKeys(v) {
	if (Array.isArray(v)) return v.map(reverseKeys);
	if (v && typeof v === 'object') {
		const out = {};
		for (const k of Object.keys(v).reverse()) out[k] = reverseKeys(v[k]);
		return out;
	}
	return v;
}

/** Local file copy with an edit applied. */
function edit(fn) {
	const page = clone(basePage());
	fn(page);
	return page;
}

const doc = (page, r, c = 0) => page.body[r].cells[c].data.document;
const feed = (page) => doc(page, 2).nodes[0].data.editable;

const PAYLOAD_FORBIDDEN = [
	'status',
	'path',
	'protected',
	'condition',
	'provider',
	'name',
	'internalTitle',
	'image',
];
const allPayloads = [];
function expectCopy(local, live = livePage()) {
	const r = diffPage(local, live);
	expect(r.blocked).toEqual([]);
	expect(r.status).toBe('copy');
	allPayloads.push(r.payload);
	return r;
}
function expectBlocked(local, live = livePage()) {
	const r = diffPage(local, live);
	expect(r.status).toBe('blocked');
	expect(r.blocked.length).toBeGreaterThan(0);
	expect(r.payload).toBeNull();
	for (const b of r.blocked) {
		expect(typeof b.location).toBe('string');
		expect(typeof b.reason).toBe('string');
	}
	return r;
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// AC-2: classifier coverage (one test per numbered item)
// ---------------------------------------------------------------------------

describe('AC-2 classifier', () => {
	test('AC-2.1 identical local/live -> unchanged, including reordered keys', () => {
		expect(classifyPage(basePage(), livePage()).status).toBe('unchanged');
		const r = classifyPage(reverseKeys(basePage()), livePage());
		expect(r).toEqual({ status: 'unchanged', changes: [], blocked: [] });
		expect(classifyPage(basePage(), reverseKeys(livePage())).status).toBe(
			'unchanged'
		);
	});

	test('AC-2.2 leaf text change -> copy', () => {
		const local = edit((p) => {
			doc(p, 0).nodes[0].nodes[0].leaves[0].text =
				'Every rep raises money for charity';
		});
		const r = expectCopy(local);
		expect(r.changes).toEqual([
			{
				location: 'Row 1 · heading',
				before: 'Race for something bigger',
				after: 'Every rep raises money for charity',
				kind: 'text',
			},
		]);
	});

	test('AC-2.3 a mark added (bold) -> copy', () => {
		const local = edit((p) => {
			doc(p, 0).nodes[1].nodes[0].leaves = [
				leaf('First ', []),
				leaf('paragraph', ['bold']),
				leaf('.', []),
			];
		});
		const r = expectCopy(local);
		expect(r.changes).toHaveLength(1);
		expect(r.changes[0]).toMatchObject({
			location: 'Row 1 · paragraph',
			kind: 'formatting',
			before: 'First paragraph.',
			after: 'First paragraph.',
		});
	});

	test('AC-2.4 new paragraph inserted between two paragraphs, skeleton unchanged -> copy', () => {
		const local = edit((p) => {
			doc(p, 0).nodes.splice(2, 0, para('A brand new middle paragraph.'));
		});
		const r = expectCopy(local);
		expect(r.changes).toEqual([
			{
				location: 'Row 1 · paragraph',
				before: null,
				after: 'A brand new middle paragraph.',
				kind: 'new',
			},
		]);
	});

	test('AC-2.5 link text changed, href unchanged -> copy', () => {
		const local = edit((p) => {
			doc(p, 1).nodes[0].nodes[1].nodes[0].leaves[0].text = 'on our site';
		});
		const r = expectCopy(local);
		expect(r.changes).toEqual([
			{
				location: 'Row 2 · paragraph',
				before: 'Read more here.',
				after: 'Read more on our site.',
				kind: 'text',
			},
		]);
	});

	test('AC-2.6 link href changed -> blocked', () => {
		const local = edit((p) => {
			doc(p, 1).nodes[0].nodes[1].data.href = 'https://evil.example/';
		});
		const r = expectBlocked(local);
		expect(r.blocked[0].location).toBe('Row 2 · link');
		expect(r.blocked[0].reason).toMatch(/link address changed/);
	});

	test('AC-2.7 image block src changed -> blocked', () => {
		const local = edit((p) => {
			doc(p, 1).nodes[1].data.editable.src.value =
				'https://raisely-images.imgix.net/other.jpg';
		});
		const r = expectBlocked(local);
		expect(r.blocked[0].location).toBe('Row 2 · image');
	});

	describe('AC-2.8 custom-component added, removed or reordered -> blocked', () => {
		test('added', () => {
			const local = edit((p) => {
				doc(p, 0).nodes.push(component('Countdown', {}));
			});
			expect(expectBlocked(local).blocked[0].reason).toMatch(
				/added or removed/
			);
		});
		test('removed', () => {
			const local = edit((p) => {
				doc(p, 2).nodes.splice(0, 1);
			});
			expectBlocked(local);
		});
		test('reordered', () => {
			const local = edit((p) => {
				doc(p, 2).nodes.unshift(component('Countdown', {}));
			});
			const live = livePage();
			doc(live, 2).nodes.push(component('Countdown', {}));
			expectBlocked(local, live);
		});
		test('swapped for another component', () => {
			const local = edit((p) => {
				doc(p, 3).nodes[0].data.customComponent = 'OtherBanner';
			});
			expect(expectBlocked(local).blocked[0].reason).toMatch(/swapped/);
		});
	});

	test('AC-2.9 editable.heading.value text -> text -> copy', () => {
		const local = edit((p) => {
			feed(p).heading.value = 'How you help';
		});
		const r = expectCopy(local);
		expect(r.changes).toEqual([
			{
				location: 'Row 3 · Heading (component: RaiselyFeed)',
				before: 'How it works',
				after: 'How you help',
				kind: 'text',
			},
		]);
	});

	test('AC-2.10 editable.feedItems.value[1].heading changed, same length -> copy', () => {
		const local = edit((p) => {
			feed(p).feedItems.value[1].heading = 'Pick your target';
		});
		const r = expectCopy(local);
		expect(r.changes).toEqual([
			{
				location:
					'Row 3 · Feed item 2 heading (component: RaiselyFeed)',
				before: 'Set your goal',
				after: 'Pick your target',
				kind: 'text',
			},
		]);
	});

	test('AC-2.11 repeater array length changed -> blocked', () => {
		const local = edit((p) => {
			feed(p).feedItems.value.push({ ...feed(p).feedItems.value[0] });
		});
		expect(expectBlocked(local).blocked[0].reason).toMatch(
			/added or removed/
		);
	});

	test('AC-2.12 editable.cause1Link.value changed -> blocked (name rule)', () => {
		// Even a plain-text-looking value is blocked by the field name.
		const local = edit((p) => {
			feed(p).cause1Link.value = 'Some words';
		});
		const r = expectBlocked(local);
		expect(r.blocked[0].location).toMatch(/Cause 1 link/);
		expect(r.blocked[0].reason).toMatch(/cause1Link/);
	});

	test('AC-2.12b repeater leaf key matching the name rule -> blocked', () => {
		const local = edit((p) => {
			feed(p).feedItems.value[0].link = 'Somewhere';
		});
		expect(expectBlocked(local).blocked[0].location).toBe(
			'Row 3 · Feed item 1 link (component: RaiselyFeed)'
		);
	});

	describe('AC-2.13 untyped field "Learn more" -> "/donate" -> blocked (value rule)', () => {
		test('"Learn more" -> "/donate"', () => {
			const local = edit((p) => {
				feed(p).ctaText.value = '/donate';
			});
			expect(expectBlocked(local).blocked[0].reason).toMatch(
				/looks like a link/
			);
		});
		test.each([
			'https://x.org',
			'mailto:a@b.c',
			'tel:123',
			'#anchor',
			'www.example.com',
			'2c9d1a4e-1b2c-4d5e-8f90-123456789abc',
			'42',
			'true',
		])('other reference-looking value %s -> blocked', (v) => {
			const local = edit((p) => {
				feed(p).ctaText.value = v;
			});
			expectBlocked(local);
		});
		test.each([
			'javascript:alert(1)',
			'data:text/html,x',
			'vbscript:msgbox(1)',
			'blob:https://x.org/abc',
			'./donate',
			'../donate',
			'JavaScript:void(0)',
		])('scheme/relative-path reference %s -> blocked', (v) => {
			const local = edit((p) => {
				feed(p).ctaText.value = v;
			});
			expectBlocked(local);
		});
		test.each(['Data: 2026 results', 'Note: entries close Friday'])(
			'prose with colon %s stays copy',
			(v) => {
				const local = edit((p) => {
					feed(p).ctaText.value = v;
				});
				expectCopy(local);
			}
		);
		test('reference-looking old value is also blocked', () => {
			const live = livePage();
			feed(live).ctaText.value = '/donate';
			expectBlocked(basePage(), live);
		});
	});

	describe('AC-2.14 editable.x.label/help/default changed -> blocked', () => {
		test.each(['label', 'help', 'default'])('%s', (key) => {
			const local = edit((p) => {
				feed(p).intro[key] = 'Changed admin text';
			});
			const r = expectBlocked(local);
			expect(r.blocked[0].reason).toContain(key);
		});
		test('type/group/options and added/removed fields too', () => {
			expectBlocked(edit((p) => (feed(p).intro.type = 'text')));
			expectBlocked(edit((p) => (feed(p).intro.group = 'Main')));
			expectBlocked(edit((p) => (feed(p).intro.options = ['a'])));
			expectBlocked(edit((p) => (feed(p).extra = { value: 'x' })));
			expectBlocked(edit((p) => delete feed(p).intro));
		});
		test('a typed textarea field value change is still copy', () => {
			const r = expectCopy(
				edit((p) => (feed(p).intro.value = 'Kia ora'))
			);
			expect(r.changes[0].location).toBe(
				'Row 3 · Intro (component: RaiselyFeed)'
			);
		});
	});

	test('AC-2.15 type:"image" field .value changed -> blocked', () => {
		const local = edit((p) => {
			feed(p).hero.value = 'A caption-looking string';
		});
		expect(expectBlocked(local).blocked[0].reason).toMatch(/"image" field/);
	});

	test('AC-2.16 row.data.background changed -> blocked', () => {
		const local = edit((p) => {
			p.body[0].data.background = 'black';
		});
		const r = expectBlocked(local);
		expect(r.blocked[0]).toMatchObject({ location: 'Row 1' });
		expect(r.blocked[0].reason).toMatch(/background/);
	});

	test('AC-2.17 row uuid order changed -> blocked', () => {
		const local = edit((p) => {
			p.body.reverse();
		});
		expect(expectBlocked(local).blocked[0].reason).toMatch(/reordered/);
	});

	describe('AC-2.18 blocked top-level fields', () => {
		const values = {
			status: 'draft',
			path: 'about-us',
			protected: true,
			condition: 'user.isAdmin',
			provider: 'other',
			name: 'about-2',
			internalTitle: 'About (new)',
			image: 'https://raisely-images.imgix.net/x.jpg',
		};
		test.each(BLOCKED_FIELDS)('%s changed -> blocked', (field) => {
			const local = edit((p) => {
				p[field] = values[field];
			});
			const r = expectBlocked(local);
			expect(r.blocked).toHaveLength(1);
		});
		test('blocked even when a copy change is also present', () => {
			const local = edit((p) => {
				p.status = 'draft';
				p.title = 'New title';
			});
			expectBlocked(local);
		});
	});

	describe('AC-2.19 title/metaDescription/socialTitle/socialDescription changed -> copy', () => {
		test.each(COPY_FIELDS)('%s', (field) => {
			const local = edit((p) => {
				p[field] = 'Fresh copy';
			});
			const r = expectCopy(local);
			expect(r.changes).toHaveLength(1);
			expect(r.changes[0].after).toBe('Fresh copy');
		});
		test('null -> string and string -> null are copy', () => {
			expectCopy(edit((p) => (p.socialTitle = 'Now set')));
			expectCopy(edit((p) => (p.socialDescription = null)));
		});
	});

	test('AC-2.20 a non-slate cell changed -> blocked', () => {
		const local = edit((p) => {
			p.body[3].cells[1].data.html = '<p>changed</p>';
		});
		const r = expectBlocked(local);
		expect(r.blocked[0].location).toBe('Row 4, column 2');
	});

	test('AC-2.21 hash and public differences on the live side are ignored', () => {
		const live = livePage();
		live.hash = 'a-completely-different-jwt';
		live.public = { totally: 'different' };
		live.html = '<p>other</p>';
		live.tags = ['x'];
		live.private = { y: 1 };
		expect(classifyPage(basePage(), live).status).toBe('unchanged');
		expect(normalisePage(live)).not.toHaveProperty('hash');
		expect(normalisePage(live)).not.toHaveProperty('public');
		expect(normalisePage(live)).not.toHaveProperty('uuid');
		expect(normalisePage(live)).not.toHaveProperty('campaignUuid');
	});
});

describe('classifier extras', () => {
	test('cell uuid list, cell type and other cell keys are structure', () => {
		expectBlocked(edit((p) => (p.body[0].cells[0].uuid = 'cell-x')));
		expectBlocked(edit((p) => (p.body[0].cells[0].type = 'html')));
		expectBlocked(edit((p) => (p.body[0].cells[0].data.object = 'other')));
		expectBlocked(edit((p) => (p.body[0].cells[0].extra = 1)));
	});

	test('html and dynamic-field nodes are frozen; unknown node types too', () => {
		const withNode = (node) => {
			const page = basePage();
			doc(page, 0).nodes.push(node);
			return page;
		};
		const html = block('html', [emptyText()], { html: '<b>x</b>' });
		const df = {
			object: 'inline',
			type: 'dynamic-field',
			data: { value: '{{user.name}}' },
			nodes: [emptyText()],
		};
		const weird = block('video', [emptyText()], { url: 'a' });
		for (const n of [html, df, weird]) {
			const live = withNode(n);
			const local = clone(live);
			const last = doc(local, 0).nodes.length - 1;
			doc(local, 0).nodes[last].data = { changed: true };
			expectBlocked(local, live);
		}
		const live = withNode(block('paragraph', [textNode(leaf('Hi ')), df]));
		const local = clone(live);
		doc(local, 0).nodes[3].nodes[1].data.value = '{{user.email}}';
		expectBlocked(local, live);
	});

	test('removing a paragraph and splitting/merging text blocks are copy', () => {
		const removed = expectCopy(edit((p) => doc(p, 0).nodes.splice(1, 1)));
		expect(removed.changes).toEqual([
			{
				location: 'Row 1 · paragraph',
				before: 'First paragraph.',
				after: null,
				kind: 'removed',
			},
		]);
		expectCopy(
			edit((p) => {
				doc(p, 0).nodes.splice(
					1,
					2,
					para('First paragraph. Second paragraph.')
				);
			})
		);
	});

	test('heading level (text-block data) is copy formatting', () => {
		const r = expectCopy(
			edit((p) => (doc(p, 0).nodes[0].data = { level: 3 }))
		);
		expect(r.changes[0].kind).toBe('formatting');
	});

	test('removing a link (skeleton change) -> blocked', () => {
		expectBlocked(
			edit((p) => {
				doc(p, 1).nodes[0] = para('Read more here.');
			})
		);
	});

	test('skeleton lists non-text nodes depth-first', () => {
		const kinds = slateSkeleton(doc(basePage(), 1)).map((e) => e.node.type);
		expect(kinds).toEqual(['link', 'image']);
	});

	test('repeater value changing from string to number is blocked', () => {
		expectBlocked(edit((p) => (feed(p).headingSize.value = 4)));
	});

	test('a local file missing a copy field equals a live null', () => {
		const local = basePage();
		delete local.socialTitle;
		expect(classifyPage(local, livePage()).status).toBe('unchanged');
	});
});

// ---------------------------------------------------------------------------
// AC-3: minimal payload
// ---------------------------------------------------------------------------

describe('AC-3 payload is minimal', () => {
	test('AC-3 body-only text change -> payload has exactly the key body', () => {
		const local = edit((p) => {
			doc(p, 0).nodes[1].nodes[0].leaves[0].text = 'Changed.';
		});
		const r = expectCopy(local);
		expect(Object.keys(r.payload)).toEqual(['body']);
		expect(r.payload.body).toEqual(local.body);
	});

	test('AC-3 title-only change -> payload has exactly the key title', () => {
		const r = expectCopy(edit((p) => (p.title = 'About the race')));
		expect(r.payload).toEqual({ title: 'About the race' });
	});

	test('AC-3 body + meta change -> exactly body and metaDescription', () => {
		const r = expectCopy(
			edit((p) => {
				p.metaDescription = 'New meta';
				feed(p).heading.value = 'New heading';
			})
		);
		expect(Object.keys(r.payload).sort()).toEqual([
			'body',
			'metaDescription',
		]);
	});

	test('AC-3 buildPayload never carries blocked fields even when they differ', () => {
		const local = edit((p) => {
			for (const f of PAYLOAD_FORBIDDEN) p[f] = `changed-${f}`;
			p.title = 'T';
		});
		const payload = buildPayload(local, livePage());
		expect(payload).toEqual({ title: 'T' });
		allPayloads.push(payload);
	});

	test('AC-3 no payload in any test contains a forbidden field', () => {
		expect(allPayloads.length).toBeGreaterThan(10);
		for (const payload of allPayloads) {
			for (const f of PAYLOAD_FORBIDDEN) {
				expect(payload).not.toHaveProperty(f);
			}
			for (const key of Object.keys(payload)) {
				expect(['body', ...COPY_FIELDS]).toContain(key);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// AC-7: digest stability
// ---------------------------------------------------------------------------

describe('AC-7 digest', () => {
	const entryFor = (local, live, uuid = 'page-uuid-1') => ({
		uuid,
		liveUpdatedAt: live.updatedAt,
		payload: diffPage(local, live).payload,
	});
	const titleEdit = () => edit((p) => (p.title = 'About the race'));
	const bodyEdit = () =>
		edit((p) => (doc(p, 0).nodes[1].nodes[0].leaves[0].text = 'Changed.'));

	test('AC-7 digest is 12 lowercase hex chars', () => {
		expect(computeDigest([entryFor(titleEdit(), livePage())])).toMatch(
			/^[0-9a-f]{12}$/
		);
	});

	test('AC-7 same inputs give the same digest regardless of key order', () => {
		const a = computeDigest([
			entryFor(bodyEdit(), livePage()),
			entryFor(titleEdit(), livePage(), 'page-uuid-2'),
		]);
		const b = computeDigest([
			entryFor(titleEdit(), livePage(), 'page-uuid-2'),
			entryFor(reverseKeys(bodyEdit()), reverseKeys(livePage())),
		]);
		expect(b).toBe(a);
		expect(
			computeDigest([reverseKeys(entryFor(bodyEdit(), livePage()))])
		).toBe(computeDigest([entryFor(bodyEdit(), livePage())]));
	});

	test('AC-7 changing one character of copy changes the digest', () => {
		const one = edit(
			(p) => (doc(p, 0).nodes[1].nodes[0].leaves[0].text = 'Changed.')
		);
		const two = edit(
			(p) => (doc(p, 0).nodes[1].nodes[0].leaves[0].text = 'Changed!')
		);
		expect(computeDigest([entryFor(two, livePage())])).not.toBe(
			computeDigest([entryFor(one, livePage())])
		);
	});

	test('AC-7 changing the live updatedAt changes the digest', () => {
		const live2 = livePage();
		live2.updatedAt = '2026-09-30T10:00:00.001Z';
		expect(computeDigest([entryFor(titleEdit(), live2)])).not.toBe(
			computeDigest([entryFor(titleEdit(), livePage())])
		);
	});

	test('AC-7 canonicalJson sorts keys deeply', () => {
		expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 2 } })).toBe(
			'{"a":{"c":2,"d":[{"x":2,"y":1}]},"b":1}'
		);
	});

	test('reportDigest covers copy pages only and is null when blocked', () => {
		const copy = {
			uuid: 'u1',
			status: 'copy',
			liveUpdatedAt: 't',
			payload: { title: 'x' },
		};
		const same = {
			uuid: 'u2',
			status: 'unchanged',
			liveUpdatedAt: 't',
			payload: null,
		};
		expect(reportDigest([copy, same])).toBe(
			computeDigest([
				{ uuid: 'u1', liveUpdatedAt: 't', payload: { title: 'x' } },
			])
		);
		expect(reportDigest([copy, { ...same, status: 'blocked' }])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Preview / JSON (§3.5)
// ---------------------------------------------------------------------------

describe('preview rendering', () => {
	const live = livePage();
	const local = edit((p) => {
		doc(p, 0).nodes[0].nodes[0].leaves[0].text =
			'Every rep raises money for charity';
		doc(p, 0).nodes.splice(2, 0, para('Inserted.'));
		feed(p).feedItems.value[0].heading = 'Pick your fund';
		p.metaDescription = 'New meta';
	});
	const d = diffPage(local, live);
	const pages = [
		{
			file: 'about.json',
			uuid: 'page-uuid-1',
			liveUpdatedAt: live.updatedAt,
			...d,
		},
		{
			file: 'faq.json',
			uuid: 'page-uuid-2',
			liveUpdatedAt: live.updatedAt,
			status: 'unchanged',
			changes: [],
			blocked: [],
			payload: null,
		},
	];
	const digest = reportDigest(pages);

	test('renders labels, new blocks, component paths, footer and digest', () => {
		const out = strip(renderPreview({ digest, pages }, { color: false }));
		expect(out).toContain('about.json  (live last edited 2026-09-30)');
		expect(out).toContain(
			'  Row 1 · heading:  "Race for something bigger"  →  "Every rep raises money for charity"'
		);
		expect(out).toContain('  Row 1 · paragraph:  (new) "Inserted."');
		expect(out).toContain(
			'  Row 3 · Feed item 1 heading (component: RaiselyFeed):  "Choose your cause"  →  "Pick your fund"'
		);
		expect(out).toContain(
			'  Meta description:  "About the race"  →  "New meta"'
		);
		expect(out).not.toContain('faq.json');
		expect(out).toContain(
			'1 page(s) will change. Components and styles are not touched.'
		);
		expect(out).toContain(LANGUAGES_TEXT);
		expect(out).toContain(`Digest: ${digest}`);
		expect(out).not.toContain('REVERT');
	});

	test('removed blocks render as (removed)', () => {
		const r = diffPage(
			edit((p) => doc(p, 0).nodes.splice(1, 1)),
			live
		);
		const out = renderPreview(
			{ digest: 'abc', pages: [{ file: 'a.json', ...r }] },
			{ color: false }
		);
		expect(out).toContain(
			'  Row 1 · paragraph:  (removed) "First paragraph."'
		);
	});

	test('REVERT banner shown when page flagged revert', () => {
		const out = strip(
			renderPreview(
				{ digest, pages: [{ ...pages[0], revert: true }] },
				{ color: true }
			)
		);
		expect(out).toContain(`⚠ REVERT: ${REVERT_TEXT}`);
	});

	test('blocked pages show every reason and the refusal line, no digest', () => {
		const blocked = diffPage(
			edit((p) => {
				p.status = 'draft';
				p.path = 'x';
			}),
			live
		);
		const out = strip(
			renderPreview(
				{
					digest: null,
					pages: [{ file: 'about.json', ...blocked }, pages[1]],
				},
				{ color: false }
			)
		);
		expect(out).toContain('about.json  BLOCKED');
		expect(out).toContain(
			'  Publish status: Publish status changed ("published" → "draft")'
		);
		expect(out).toContain('  Page URL path:');
		expect(out).toContain(BLOCKED_TEXT);
		expect(out).not.toContain('Digest:');
	});

	test('nothing to publish', () => {
		expect(
			renderPreview(
				{ digest: reportDigest([pages[1]]), pages: [pages[1]] },
				{ color: false }
			)
		).toMatch(/Nothing to publish/);
	});

	test('140-char truncation centred on the first difference', () => {
		const pre = 'a'.repeat(200);
		const post = 'z'.repeat(200);
		const [b, a] = truncatePair(`${pre}OLD${post}`, `${pre}NEW${post}`);
		expect(b.length).toBeLessThanOrEqual(140);
		expect(a.length).toBeLessThanOrEqual(140);
		expect(b.startsWith('…') && b.endsWith('…')).toBe(true);
		expect(b).toContain('OLD');
		expect(a).toContain('NEW');
		const idx = b.indexOf('OLD');
		expect(Math.abs(idx - 70)).toBeLessThan(5);
		expect(truncatePair('short', 'shirt')).toEqual(['short', 'shirt']);
		const [early] = truncatePair(
			`X${'b'.repeat(300)}`,
			`Y${'b'.repeat(300)}`
		);
		expect(early.startsWith('X')).toBe(true);
		expect(early.endsWith('…')).toBe(true);
	});

	test('--json shape', () => {
		const json = buildJsonReport({
			digest,
			pages: [{ ...pages[0], revert: true }, pages[1]],
		});
		expect(Object.keys(json).sort()).toEqual(['digest', 'pages']);
		expect(json.digest).toBe(digest);
		expect(Object.keys(json.pages[0]).sort()).toEqual(
			[
				'blocked',
				'changes',
				'file',
				'liveUpdatedAt',
				'revert',
				'status',
				'uuid',
			].sort()
		);
		expect(json.pages[0]).toMatchObject({
			file: 'about.json',
			uuid: 'page-uuid-1',
			status: 'copy',
			liveUpdatedAt: live.updatedAt,
			revert: true,
		});
		for (const ch of json.pages[0].changes) {
			expect(Object.keys(ch).sort()).toEqual([
				'after',
				'before',
				'location',
			]);
		}
		expect(json.pages[0].changes).toContainEqual({
			location: 'Row 1 · paragraph',
			before: null,
			after: 'Inserted.',
		});
		expect(json.pages[1].revert).toBe(false);
		expect(JSON.parse(JSON.stringify(json))).toEqual(json);
	});

	test('humaniseFieldPath', () => {
		expect(humaniseFieldPath(['feedItems', 1, 'heading'])).toBe(
			'Feed item 2 heading'
		);
		expect(humaniseFieldPath(['quotes', 0, 'quote'])).toBe('Quote 1 quote');
		expect(humaniseFieldPath(['description'])).toBe('Description');
	});
});
