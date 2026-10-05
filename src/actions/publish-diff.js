/**
 * Pure diff engine for `raisely publish` (no I/O).
 *
 * Compares a local page file against its live API object, classifies every
 * difference as copy (publishable) or blocked, builds the minimal PATCH
 * payload, computes the confirmation digest and renders the preview.
 *
 * See plans/2026-10-05-raisely-publish/SPEC.md §3.4, §3.5, §3.7.
 */
import crypto from 'crypto';
import { Chalk } from 'chalk';

/** Fields `syncPages` writes to a page file (src/actions/sync.js). */
export const SYNC_FIELDS = [
	'uuid',
	'path',
	'title',
	'internalTitle',
	'name',
	'status',
	'body',
	'provider',
	'condition',
	'image',
	'metaDescription',
	'socialTitle',
	'socialDescription',
	'protected',
	'campaignUuid',
];

/** Top-level fields that are copy and may be published. */
export const COPY_FIELDS = [
	'title',
	'metaDescription',
	'socialTitle',
	'socialDescription',
];

/** Top-level fields where any difference blocks the run. */
export const BLOCKED_FIELDS = [
	'path',
	'internalTitle',
	'name',
	'status',
	'provider',
	'condition',
	'image',
	'protected',
];

/** The only keys a publish PATCH `data` may ever contain (ADR-4). */
export const PAYLOAD_FIELDS = ['body', ...COPY_FIELDS];

/** Fields compared between local and live (sync fields minus identity). */
export const COMPARE_FIELDS = SYNC_FIELDS.filter(
	(f) => f !== 'uuid' && f !== 'campaignUuid'
);

const FIELD_LABELS = {
	title: 'Title',
	metaDescription: 'Meta description',
	socialTitle: 'Social title',
	socialDescription: 'Social description',
	path: 'Page URL path',
	internalTitle: 'Internal title',
	name: 'Page name',
	status: 'Publish status',
	provider: 'Provider',
	condition: 'Visibility condition',
	image: 'Page image',
	protected: 'Password protection',
	body: 'Page body',
};

const TEXT_BLOCK_TYPES = new Set([
	'paragraph',
	'heading',
	'list_item',
	'ul_list',
	'ol_list',
]);

const COPY_FIELD_TYPES = new Set(['text', 'textarea']);

/** §3.4 D rule 4: field names / leaf keys that are never copy. */
export const NON_COPY_NAME_RE =
	/(link|url|href|src|image|img|slug|path|email|icon|video|color|colour|class|id)$/i;

/** §3.4 D rule 5: values that look like a reference rather than copy. */
export const REFERENCE_VALUE_RE = /^(https?:|mailto:|tel:|\/|#|www\.)/i;
// Also references: executable/inline URL schemes and relative paths.
// The scheme is matched only when the colon follows the word directly AND is
// followed by a non-space char (`javascript:alert(1)`, `data:text/html,x`), so
// prose like "Data: 2026 results" or "Note: ..." stays copy.
// Relative paths: leading `./` or `../`.
export const REFERENCE_SCHEME_RE = /^(javascript|data|vbscript|blob):\S/i;
export const RELATIVE_PATH_RE = /^\.\.?\//;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

// ---------------------------------------------------------------------------
// Canonical JSON / equality
// ---------------------------------------------------------------------------

function sortKeysDeep(value) {
	if (Array.isArray(value)) {
		return value.map((v) => (v === undefined ? null : sortKeysDeep(v)));
	}
	if (value && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			out[key] = sortKeysDeep(value[key]);
		}
		return out;
	}
	return value;
}

/**
 * JSON with object keys sorted recursively (key order never matters).
 * `undefined` is treated as `null` at the top level and dropped inside
 * objects, matching JSON.stringify semantics.
 */
export function canonicalJson(value) {
	return JSON.stringify(sortKeysDeep(value === undefined ? null : value));
}

function deepEqual(a, b) {
	return canonicalJson(a) === canonicalJson(b);
}

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sha256Hex(text) {
	return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

/**
 * Reduce a page (local file or live API object) to the fields compared by
 * publish: the `syncPages` fields minus `uuid`/`campaignUuid`. Everything else
 * (`hash`, `public`, `html`, `tags`, `private`, ...) is dropped. Missing fields
 * become `null`. Values are deep copies.
 */
export function normalisePage(page) {
	const out = {};
	for (const field of COMPARE_FIELDS) {
		const v = page ? page[field] : undefined;
		out[field] = v === undefined ? null : clone(v);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function humaniseWord(name) {
	return String(name)
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([a-zA-Z])([0-9])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.trim();
}

function singular(words) {
	if (/[^s]s$/.test(words)) return words.slice(0, -1);
	return words;
}

function capitalise(s) {
	return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Humanise a component field path: ['feedItems', 1, 'heading'] ->
 * "Feed item 2 heading"; ['heading'] -> "Heading".
 */
export function humaniseFieldPath(parts) {
	const words = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (typeof part === 'number') {
			if (words.length) {
				words[words.length - 1] = singular(words[words.length - 1]);
			}
			words.push(String(part + 1));
		} else {
			words.push(humaniseWord(part));
		}
	}
	return capitalise(words.join(' '));
}

function componentName(node) {
	const cc = node && node.data ? node.data.customComponent : undefined;
	if (cc && typeof cc === 'object') {
		return String(cc.name || cc.uuid || cc.id || 'unknown');
	}
	return cc === undefined || cc === null ? 'unknown' : String(cc);
}

function cellLabel(rowIndex, cellIndex, cellCount) {
	const row = `Row ${rowIndex + 1}`;
	return cellCount > 1 ? `${row}, column ${cellIndex + 1}` : row;
}

function blockTypeLabel(type) {
	return String(type).replace(/_/g, ' ');
}

function showValue(v) {
	if (v === null || v === undefined) return 'empty';
	if (typeof v === 'string') return v === '' ? 'empty' : JSON.stringify(v);
	const s = JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

// ---------------------------------------------------------------------------
// Component prop rules (§3.4 D)
// ---------------------------------------------------------------------------

function isStringish(v) {
	return v === null || v === undefined || typeof v === 'string';
}

/** §3.4 D rule 5. */
export function looksLikeReference(v) {
	if (v === null || v === undefined) return false;
	if (typeof v === 'number' || typeof v === 'boolean') return true;
	if (typeof v !== 'string') return false;
	const s = v.trim();
	if (s === '') return false;
	if (REFERENCE_VALUE_RE.test(s)) return true;
	if (REFERENCE_SCHEME_RE.test(s)) return true;
	if (RELATIVE_PATH_RE.test(s)) return true;
	if (UUID_RE.test(s)) return true;
	if (NUMBER_RE.test(s)) return true;
	if (/^(true|false)$/i.test(s)) return true;
	return false;
}

/**
 * Compare one editable field's `.value` (live `before`, local `after`).
 * Returns { changes: [{parts, before, after}], blocked: [{parts, reason}] }.
 */
function diffEditableValue(fieldName, fieldType, before, after) {
	const changes = [];
	const blocked = [];
	if (deepEqual(before, after)) return { changes, blocked };

	if (fieldType !== undefined && fieldType !== null) {
		if (!COPY_FIELD_TYPES.has(fieldType)) {
			blocked.push({
				parts: [fieldName],
				reason: `this is a "${fieldType}" field, not text; only text fields can be published`,
			});
			return { changes, blocked };
		}
	}
	if (NON_COPY_NAME_RE.test(fieldName)) {
		blocked.push({
			parts: [fieldName],
			reason: `"${fieldName}" holds a link, image or setting, not copy`,
		});
		return { changes, blocked };
	}

	const walk = (b, a, parts, leafKey) => {
		if (deepEqual(b, a)) return;
		if (isStringish(b) && isStringish(a)) {
			if (leafKey !== undefined && NON_COPY_NAME_RE.test(leafKey)) {
				blocked.push({
					parts,
					reason: `"${leafKey}" holds a link, image or setting, not copy`,
				});
				return;
			}
			if (looksLikeReference(b) || looksLikeReference(a)) {
				blocked.push({
					parts,
					reason: `value looks like a link, id or setting (${showValue(b)} → ${showValue(a)}), not copy`,
				});
				return;
			}
			changes.push({
				parts,
				before: b === undefined ? null : b,
				after: a === undefined ? null : a,
			});
			return;
		}
		if (Array.isArray(b) && Array.isArray(a)) {
			if (b.length !== a.length) {
				blocked.push({
					parts,
					reason: `items were added or removed (live has ${b.length}, yours has ${a.length})`,
				});
				return;
			}
			for (let i = 0; i < b.length; i++) {
				walk(b[i], a[i], [...parts, i], leafKey);
			}
			return;
		}
		if (isPlainObject(b) && isPlainObject(a)) {
			const kb = Object.keys(b).sort();
			const ka = Object.keys(a).sort();
			if (!deepEqual(kb, ka)) {
				blocked.push({
					parts,
					reason: 'item fields were added or removed',
				});
				return;
			}
			for (const k of kb) {
				walk(b[k], a[k], [...parts, k], k);
			}
			return;
		}
		blocked.push({
			parts,
			reason: `value is not text (${showValue(b)} → ${showValue(a)})`,
		});
	};
	walk(before, after, [fieldName], undefined);
	return { changes, blocked };
}

/**
 * Compare two custom-component nodes at the same skeleton position.
 * Returns { changes, blocked } with location strings filled in.
 */
function diffComponent(liveNode, localNode, where) {
	const changes = [];
	const blocked = [];
	const name = componentName(localNode);
	const loc = (parts) =>
		`${where} · ${humaniseFieldPath(parts)} (component: ${name})`;

	if (componentName(liveNode) !== componentName(localNode)) {
		blocked.push({
			location: `${where} · component`,
			reason: `component swapped (${componentName(liveNode)} → ${componentName(localNode)})`,
		});
		return { changes, blocked };
	}

	const strip = (node) => {
		const c = clone(node);
		if (c.data) delete c.data.editable;
		return c;
	};
	if (!deepEqual(strip(liveNode), strip(localNode))) {
		blocked.push({
			location: `${where} · component: ${name}`,
			reason: 'component settings changed (identity, layout or structure)',
		});
	}

	const eLive = (liveNode.data && liveNode.data.editable) || {};
	const eLocal = (localNode.data && localNode.data.editable) || {};
	if (!isPlainObject(eLive) || !isPlainObject(eLocal)) {
		if (!deepEqual(eLive, eLocal)) {
			blocked.push({
				location: `${where} · component: ${name}`,
				reason: 'component fields changed shape',
			});
		}
		return { changes, blocked };
	}
	const keysLive = Object.keys(eLive);
	const keysLocal = Object.keys(eLocal);
	for (const k of keysLive) {
		if (!(k in eLocal)) {
			blocked.push({
				location: loc([k]),
				reason: 'field removed from component',
			});
		}
	}
	for (const k of keysLocal) {
		if (!(k in eLive)) {
			blocked.push({
				location: loc([k]),
				reason: 'field added to component',
			});
		}
	}
	for (const k of keysLive.sort()) {
		if (!(k in eLocal)) continue;
		const fLive = eLive[k];
		const fLocal = eLocal[k];
		if (!isPlainObject(fLive) || !isPlainObject(fLocal)) {
			if (!deepEqual(fLive, fLocal)) {
				blocked.push({
					location: loc([k]),
					reason: 'field definition changed',
				});
			}
			continue;
		}
		const { value: vLive, ...restLive } = fLive;
		const { value: vLocal, ...restLocal } = fLocal;
		if (!deepEqual(restLive, restLocal)) {
			const keys = new Set([
				...Object.keys(restLive),
				...Object.keys(restLocal),
			]);
			const differing = [...keys]
				.filter((x) => !deepEqual(restLive[x], restLocal[x]))
				.sort();
			blocked.push({
				location: loc([k]),
				reason: `field settings changed (${differing.join(', ')}); only the value can be published`,
			});
			continue;
		}
		const r = diffEditableValue(k, fLive.type, vLive, vLocal);
		for (const c of r.changes) {
			changes.push({
				location: loc(c.parts),
				before: c.before,
				after: c.after,
				kind: 'text',
			});
		}
		for (const b of r.blocked) {
			blocked.push({ location: loc(b.parts), reason: b.reason });
		}
	}
	return { changes, blocked };
}

// ---------------------------------------------------------------------------
// Slate skeleton rule (§3.4 C)
// ---------------------------------------------------------------------------

/**
 * Ordered list of non-text nodes (depth-first) in a Slate node tree.
 * Entries reference the original nodes; comparison decides what counts.
 * - text blocks (paragraph, heading, list_item, ul_list, ol_list): skipped,
 *   children walked.
 * - text nodes: skipped (copy).
 * - link inlines: entry, children walked (link text is copy).
 * - everything else (custom-component, image, html, dynamic-field, unknown):
 *   entry holding the whole node; not walked further.
 */
export function slateSkeleton(node) {
	const out = [];
	const visit = (n) => {
		if (!n || typeof n !== 'object') {
			out.push({ kind: 'other', node: n });
			return;
		}
		if (n.object === 'text' || n.object === 'leaf') return;
		if (n.object === 'block' && TEXT_BLOCK_TYPES.has(n.type)) {
			(n.nodes || []).forEach(visit);
			return;
		}
		if (n.object === 'inline' && n.type === 'link') {
			out.push({ kind: 'link', node: n });
			(n.nodes || []).forEach(visit);
			return;
		}
		if (n.type === 'custom-component') {
			out.push({ kind: 'component', node: n });
			return;
		}
		out.push({ kind: 'other', node: n });
	};
	(node && Array.isArray(node.nodes) ? node.nodes : []).forEach(visit);
	return out;
}

function describeSkeletonEntry(e) {
	const n = e.node;
	if (e.kind === 'component') return `component ${componentName(n)}`;
	if (e.kind === 'link') {
		const href = n && n.data ? n.data.href : undefined;
		return href ? `link to ${href}` : 'link';
	}
	if (n && n.type === 'image') return 'image';
	if (n && n.type === 'html') return 'HTML block';
	if (n && n.type === 'dynamic-field') return 'dynamic field';
	return n && n.type ? `"${n.type}" element` : 'element';
}

function linkSkeleton(n) {
	return { object: n.object, type: n.type, data: n.data };
}

/** Text of a Slate subtree, concatenating leaves in order. */
function nodeText(n) {
	if (!n || typeof n !== 'object') return '';
	if (n.object === 'text') {
		if (Array.isArray(n.leaves)) {
			return n.leaves.map((l) => (l && l.text) || '').join('');
		}
		return typeof n.text === 'string' ? n.text : '';
	}
	return (n.nodes || []).map(nodeText).join('');
}

function hasTextBlockDescendant(n) {
	return (n.nodes || []).some(
		(c) =>
			c &&
			c.object === 'block' &&
			(TEXT_BLOCK_TYPES.has(c.type) || hasTextBlockDescendant(c))
	);
}

/** The innermost text blocks of a Slate document, in order. */
function textUnits(doc) {
	const out = [];
	const visit = (n) => {
		if (!n || typeof n !== 'object' || n.object !== 'block') return;
		if (TEXT_BLOCK_TYPES.has(n.type)) {
			if (!hasTextBlockDescendant(n)) {
				out.push({
					type: n.type,
					text: nodeText(n),
					key: canonicalJson(n),
				});
				return;
			}
		} else if (n.type === 'custom-component') {
			return;
		}
		(n.nodes || []).forEach(visit);
	};
	(doc && Array.isArray(doc.nodes) ? doc.nodes : []).forEach(visit);
	return out;
}

/** LCS alignment over unit keys; returns ops list. */
function alignUnits(before, after) {
	const n = before.length;
	const m = after.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] =
				before[i].key === after[j].key
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && before[i].key === after[j].key) {
			ops.push({ op: 'same' });
			i++;
			j++;
		} else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
			ops.push({ op: 'add', unit: after[j] });
			j++;
		} else {
			ops.push({ op: 'del', unit: before[i] });
			i++;
		}
	}
	return ops;
}

/** Copy changes between two Slate docs whose skeletons already match. */
function slateTextChanges(liveDoc, localDoc, where) {
	const ops = alignUnits(textUnits(liveDoc), textUnits(localDoc));
	const changes = [];
	let dels = [];
	let adds = [];
	const flush = () => {
		const pairs = Math.min(dels.length, adds.length);
		for (let k = 0; k < pairs; k++) {
			const d = dels[k];
			const a = adds[k];
			const formatting = d.text === a.text;
			const label =
				d.type === a.type
					? blockTypeLabel(a.type)
					: `${blockTypeLabel(d.type)} → ${blockTypeLabel(a.type)}`;
			changes.push({
				location: `${where} · ${label}`,
				before: d.text,
				after: a.text,
				kind: formatting ? 'formatting' : 'text',
			});
		}
		for (const d of dels.slice(pairs)) {
			changes.push({
				location: `${where} · ${blockTypeLabel(d.type)}`,
				before: d.text,
				after: null,
				kind: 'removed',
			});
		}
		for (const a of adds.slice(pairs)) {
			changes.push({
				location: `${where} · ${blockTypeLabel(a.type)}`,
				before: null,
				after: a.text,
				kind: 'new',
			});
		}
		dels = [];
		adds = [];
	};
	for (const op of ops) {
		if (op.op === 'same') flush();
		else if (op.op === 'del') dels.push(op.unit);
		else adds.push(op.unit);
	}
	flush();
	return changes;
}

function diffSlateDocument(liveDoc, localDoc, where) {
	const changes = [];
	const blocked = [];
	if (deepEqual(liveDoc, localDoc)) return { changes, blocked };

	if (!isPlainObject(liveDoc) || !isPlainObject(localDoc)) {
		blocked.push({
			location: where,
			reason: 'text cell content is missing or malformed',
		});
		return { changes, blocked };
	}
	const { nodes: _n1, ...docRestLive } = liveDoc;
	const { nodes: _n2, ...docRestLocal } = localDoc;
	if (!deepEqual(docRestLive, docRestLocal)) {
		blocked.push({
			location: where,
			reason: 'text cell settings changed',
		});
	}

	const sLive = slateSkeleton(liveDoc);
	const sLocal = slateSkeleton(localDoc);
	if (sLive.length !== sLocal.length) {
		const fmt = (s) => s.map(describeSkeletonEntry).join(', ') || 'none';
		blocked.push({
			location: where,
			reason: `components, images, links or other non-text elements were added or removed (live: ${fmt(sLive)}; yours: ${fmt(sLocal)})`,
		});
		return { changes, blocked };
	}

	for (let i = 0; i < sLive.length; i++) {
		const a = sLive[i];
		const b = sLocal[i];
		const da = describeSkeletonEntry(a);
		const db = describeSkeletonEntry(b);
		if (
			a.kind !== b.kind ||
			(a.node && a.node.type) !== (b.node && b.node.type)
		) {
			blocked.push({
				location: where,
				reason: `non-text elements were reordered, swapped, added or removed (${da} → ${db})`,
			});
			continue;
		}
		if (a.kind === 'link') {
			if (!deepEqual(linkSkeleton(a.node), linkSkeleton(b.node))) {
				const ha = a.node.data && a.node.data.href;
				const hb = b.node.data && b.node.data.href;
				blocked.push({
					location: `${where} · link`,
					reason:
						ha !== hb
							? `link address changed (${showValue(ha)} → ${showValue(hb)})`
							: 'link settings changed',
				});
			}
			continue;
		}
		if (a.kind === 'component') {
			const r = diffComponent(a.node, b.node, where);
			changes.push(...r.changes);
			blocked.push(...r.blocked);
			continue;
		}
		if (!deepEqual(a.node, b.node)) {
			blocked.push({
				location: `${where} · ${da}`,
				reason: `${da} changed`,
			});
		}
	}
	if (blocked.length) return { changes, blocked };

	changes.unshift(...slateTextChanges(liveDoc, localDoc, where));
	return { changes, blocked };
}

// ---------------------------------------------------------------------------
// Body structure (§3.4 B)
// ---------------------------------------------------------------------------

function uuidList(items) {
	return (Array.isArray(items) ? items : []).map((x) =>
		x && typeof x === 'object' ? x.uuid : undefined
	);
}

function diffBody(liveBody, localBody) {
	const changes = [];
	const blocked = [];
	if (deepEqual(liveBody, localBody)) return { changes, blocked };

	if (!Array.isArray(liveBody) || !Array.isArray(localBody)) {
		blocked.push({
			location: 'Page body',
			reason: 'page body is missing or has an unexpected shape',
		});
		return { changes, blocked };
	}
	if (!deepEqual(uuidList(liveBody), uuidList(localBody))) {
		blocked.push({
			location: 'Page body',
			reason: `rows were added, removed or reordered (live has ${liveBody.length} rows, yours has ${localBody.length})`,
		});
		return { changes, blocked };
	}

	for (let r = 0; r < liveBody.length; r++) {
		const rowLive = liveBody[r] || {};
		const rowLocal = localBody[r] || {};
		const rowWhere = `Row ${r + 1}`;
		if (deepEqual(rowLive, rowLocal)) continue;

		if (!deepEqual(rowLive.data, rowLocal.data)) {
			const dl = isPlainObject(rowLive.data) ? rowLive.data : {};
			const dr = isPlainObject(rowLocal.data) ? rowLocal.data : {};
			const keys = [...new Set([...Object.keys(dl), ...Object.keys(dr)])]
				.filter((k) => !deepEqual(dl[k], dr[k]))
				.sort();
			blocked.push({
				location: rowWhere,
				reason: `row layout settings changed${keys.length ? ` (${keys.join(', ')})` : ''}`,
			});
		}
		const { data: _d1, cells: cellsLive, ...otherLive } = rowLive;
		const { data: _d2, cells: cellsLocal, ...otherLocal } = rowLocal;
		if (!deepEqual(otherLive, otherLocal)) {
			blocked.push({
				location: rowWhere,
				reason: 'row settings changed',
			});
		}
		if (!deepEqual(uuidList(cellsLive), uuidList(cellsLocal))) {
			blocked.push({
				location: rowWhere,
				reason: 'columns were added, removed or reordered',
			});
			continue;
		}
		const cl = Array.isArray(cellsLive) ? cellsLive : [];
		const cr = Array.isArray(cellsLocal) ? cellsLocal : [];
		if (
			!deepEqual(
				cellsLive === undefined ? null : cellsLive,
				cellsLocal === undefined ? null : cellsLocal
			) &&
			cl.length === 0 &&
			cr.length === 0
		) {
			blocked.push({
				location: rowWhere,
				reason: 'row columns changed shape',
			});
			continue;
		}
		for (let c = 0; c < cl.length; c++) {
			const cellLive = cl[c] || {};
			const cellLocal = cr[c] || {};
			const where = cellLabel(r, c, cl.length);
			if (deepEqual(cellLive, cellLocal)) continue;
			if (cellLive.type !== cellLocal.type) {
				blocked.push({
					location: where,
					reason: `column type changed (${showValue(cellLive.type)} → ${showValue(cellLocal.type)})`,
				});
				continue;
			}
			if (cellLive.type !== 'slate') {
				blocked.push({
					location: where,
					reason: `"${cellLive.type}" columns can't be published, only text columns`,
				});
				continue;
			}
			const strip = (cell) => {
				const x = clone(cell);
				if (isPlainObject(x.data)) delete x.data.document;
				return x;
			};
			if (!deepEqual(strip(cellLive), strip(cellLocal))) {
				blocked.push({
					location: where,
					reason: 'column settings changed',
				});
				continue;
			}
			const r2 = diffSlateDocument(
				cellLive.data && cellLive.data.document,
				cellLocal.data && cellLocal.data.document,
				where
			);
			if (!r2.blocked.length && !r2.changes.length) {
				// Docs differ but no text block or prop changed (e.g. list type
				// or document-level text). Still copy; make it visible.
				r2.changes.push({
					location: `${where} · formatting`,
					before: null,
					after: null,
					kind: 'formatting',
				});
			}
			changes.push(...r2.changes);
			blocked.push(...r2.blocked);
		}
	}
	return { changes, blocked };
}

// ---------------------------------------------------------------------------
// Classifier (§3.4 A-E)
// ---------------------------------------------------------------------------

/**
 * Classify the difference between a local page file and its live version.
 * @param {object} local parsed local page file
 * @param {object} live live page object from the API (extra keys ignored)
 * @returns {{status: 'unchanged'|'copy'|'blocked',
 *   changes: Array<{location: string, before: string|null, after: string|null, kind: 'text'|'new'|'removed'|'formatting'}>,
 *   blocked: Array<{location: string, reason: string}>}}
 */
export function classifyPage(local, live) {
	const a = normalisePage(live);
	const b = normalisePage(local);
	const changes = [];
	const blocked = [];

	for (const field of BLOCKED_FIELDS) {
		if (!deepEqual(a[field], b[field])) {
			blocked.push({
				location: FIELD_LABELS[field],
				reason: `${FIELD_LABELS[field]} changed (${showValue(a[field])} → ${showValue(b[field])}); only copy can be published`,
			});
		}
	}

	const body = diffBody(a.body, b.body);
	changes.push(...body.changes);
	blocked.push(...body.blocked);

	for (const field of COPY_FIELDS) {
		if (deepEqual(a[field], b[field])) continue;
		if (!isStringish(a[field]) || !isStringish(b[field])) {
			blocked.push({
				location: FIELD_LABELS[field],
				reason: `${FIELD_LABELS[field]} is not text`,
			});
			continue;
		}
		changes.push({
			location: FIELD_LABELS[field],
			before: a[field],
			after: b[field],
			kind: 'text',
		});
	}

	let status = 'unchanged';
	if (blocked.length) status = 'blocked';
	else if (changes.length) status = 'copy';
	return { status, changes, blocked };
}

// ---------------------------------------------------------------------------
// Payload (§3.7, ADR-4)
// ---------------------------------------------------------------------------

/**
 * Minimal PATCH `data`: `body` if it differed, plus whichever of the copy
 * fields differed. Never anything else. Returns `{}` if nothing differs.
 * Values are taken from the local page. Only call for `copy` pages.
 */
export function buildPayload(local, live) {
	const a = normalisePage(live);
	const b = normalisePage(local);
	const data = {};
	if (!deepEqual(a.body, b.body)) data.body = b.body;
	for (const field of COPY_FIELDS) {
		if (!deepEqual(a[field], b[field])) data[field] = b[field];
	}
	for (const key of Object.keys(data)) {
		if (!PAYLOAD_FIELDS.includes(key)) {
			throw new Error(`publish payload may not contain "${key}"`);
		}
	}
	return data;
}

/**
 * Convenience: classify and, for copy pages, build the payload.
 * @returns {{status, changes, blocked, payload: object|null}}
 */
export function diffPage(local, live) {
	const result = classifyPage(local, live);
	return {
		...result,
		payload: result.status === 'copy' ? buildPayload(local, live) : null,
	};
}

// ---------------------------------------------------------------------------
// Digest (§3.7)
// ---------------------------------------------------------------------------

/** sha256 hex of the canonical JSON of a PATCH payload. */
export function payloadSha256(payload) {
	return sha256Hex(canonicalJson(payload));
}

/**
 * Digest binding a confirmation to an exact change set.
 * @param {Array<{uuid: string, liveUpdatedAt: string, payload?: object, payloadSha256?: string}>} entries
 * @returns {string} first 12 hex chars
 */
export function computeDigest(entries) {
	const list = (entries || [])
		.map((e) => ({
			uuid: e.uuid,
			liveUpdatedAt:
				e.liveUpdatedAt === undefined ? null : e.liveUpdatedAt,
			payloadSha256:
				e.payloadSha256 !== undefined
					? e.payloadSha256
					: payloadSha256(e.payload),
		}))
		.sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
	return sha256Hex(canonicalJson(list)).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Preview (§3.5)
// ---------------------------------------------------------------------------

export const TRUNCATE_AT = 140;

function firstDifference(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return n;
}

/** Truncate `s` to at most `max` chars, centred on index `at`, with `…`. */
export function truncateAround(s, at, max = TRUNCATE_AT) {
	if (s.length <= max) return s;
	const w = max - 2;
	let start = Math.max(0, at - Math.floor(w / 2));
	start = Math.min(start, s.length - w);
	const end = start + w;
	return (
		(start > 0 ? '…' : '') +
		s.slice(start, end) +
		(end < s.length ? '…' : '')
	);
}

/** Truncate both sides of a change, centred on their first difference. */
export function truncatePair(before, after, max = TRUNCATE_AT) {
	const b = before === null || before === undefined ? '' : String(before);
	const a = after === null || after === undefined ? '' : String(after);
	const at = firstDifference(b, a);
	return [truncateAround(b, at, max), truncateAround(a, at, max)];
}

function quote(s) {
	return `"${s}"`;
}

function renderChange(change) {
	const [b, a] = truncatePair(change.before, change.after);
	switch (change.kind) {
		case 'new':
			return `  ${change.location}:  (new) ${quote(a)}`;
		case 'removed':
			return `  ${change.location}:  (removed) ${quote(b)}`;
		case 'formatting':
			return change.before === null && change.after === null
				? `  ${change.location}:  (bold/italic, list or heading style changed)`
				: `  ${change.location}:  ${quote(a)}  (formatting only)`;
		default:
			return `  ${change.location}:  ${quote(b)}  →  ${quote(a)}`;
	}
}

export const REVERT_TEXT =
	'This page was changed on the live site after your copy. Publishing will undo those changes unless you expected them.';
export const LANGUAGES_TEXT =
	"Other languages: changed English text will show in English until it's re-translated. Tell Kevin which pages changed.";
export const BLOCKED_TEXT = 'Nothing was published. These changes need Kevin.';

/**
 * Render the human preview.
 * @param {{digest: string|null, pages: Array<{file: string, uuid?: string,
 *   status: 'unchanged'|'copy'|'blocked', liveUpdatedAt?: string,
 *   liveUpdatedBy?: string, changes: Array, blocked: Array, revert?: boolean}>}} report
 * @param {{color?: boolean}} [opts] color defaults to chalk's auto-detection
 * @returns {string}
 */
export function renderPreview(report, opts = {}) {
	const c = new Chalk(opts.color === false ? { level: 0 } : undefined);
	const pages = report.pages || [];
	const blockedPages = pages.filter((p) => p.status === 'blocked');
	const copyPages = pages.filter((p) => p.status === 'copy');
	const lines = [];

	if (blockedPages.length) {
		for (const p of blockedPages) {
			lines.push(c.red.bold(`${p.file}  BLOCKED`));
			for (const b of p.blocked || []) {
				lines.push(c.red(`  ${b.location}: ${b.reason}`));
			}
			lines.push('');
		}
		lines.push(c.red.bold(BLOCKED_TEXT));
		return lines.join('\n');
	}

	if (!copyPages.length) {
		lines.push(
			'Nothing to publish: the live site already matches your page files.'
		);
		return lines.join('\n');
	}

	for (const p of copyPages) {
		const edited = p.liveUpdatedAt
			? `  (live last edited ${String(p.liveUpdatedAt).slice(0, 10)}${p.liveUpdatedBy ? ` by ${p.liveUpdatedBy}` : ''})`
			: '';
		lines.push(c.bold(p.file) + edited);
		if (p.revert) {
			lines.push(c.yellow.bold(`  ⚠ REVERT: ${REVERT_TEXT}`));
		}
		for (const change of p.changes || []) lines.push(renderChange(change));
		lines.push('');
	}
	lines.push(
		`${copyPages.length} page(s) will change. Components and styles are not touched.`
	);
	const textChanged = copyPages.some((p) =>
		(p.changes || []).some((ch) => ch.kind !== 'formatting')
	);
	if (textChanged) lines.push(c.yellow(LANGUAGES_TEXT));
	lines.push(`Digest: ${report.digest}`);
	return lines.join('\n');
}

/**
 * Machine-readable preview for `--json` (§3.5).
 * @returns {{digest: string|null, pages: Array<{file, uuid, status, liveUpdatedAt,
 *   changes: Array<{location, before, after}>, blocked: Array<{location, reason}>, revert: boolean}>}}
 */
export function buildJsonReport(report) {
	return {
		digest: report.digest === undefined ? null : report.digest,
		pages: (report.pages || []).map((p) => ({
			file: p.file,
			uuid: p.uuid === undefined ? null : p.uuid,
			status: p.status,
			liveUpdatedAt:
				p.liveUpdatedAt === undefined ? null : p.liveUpdatedAt,
			changes: (p.changes || []).map((ch) => ({
				location: ch.location,
				before: ch.before === undefined ? null : ch.before,
				after: ch.after === undefined ? null : ch.after,
			})),
			blocked: (p.blocked || []).map((b) => ({
				location: b.location,
				reason: b.reason,
			})),
			revert: !!p.revert,
		})),
	};
}

/**
 * Digest over the copy pages of a report (blocked runs get `null`).
 * @param {Array<{uuid, status, liveUpdatedAt, payload}>} pages
 */
export function reportDigest(pages) {
	if ((pages || []).some((p) => p.status === 'blocked')) return null;
	return computeDigest(
		(pages || [])
			.filter((p) => p.status === 'copy')
			.map((p) => ({
				uuid: p.uuid,
				liveUpdatedAt: p.liveUpdatedAt,
				payload: p.payload,
			}))
	);
}
