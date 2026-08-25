// Loads the catalog and one dataset bundle, runs it through the schema adapter,
// indexes it, and owns every write (review events).

import { api, state } from './util.js';
import { adapterFor, knownSchemas } from './adapters/index.js';

export const store = {
  catalog: null,
  datasetId: null,
  raw: null,
  adapter: null,
  summary: null,
  compounds: [],
  reactions: [],
  alignments: [],
  evidence: [],
  routeGraph: { nodes: [], edges: [] },
  reviewItems: [],
  issues: [],
  validations: [],
  alignmentCandidates: [],
  events: [],
  reviewState: {},
  byUid: new Map(),
  unsupported: null,
};

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(store));
}

export async function loadCatalog() {
  store.catalog = await api('/api/v1/catalog');
  return store.catalog;
}

export async function loadHealth() {
  try {
    const health = await api('/api/v1/health');
    state.rdkit = Boolean(health.rdkit?.available);
    return health;
  } catch (_) {
    return { status: 'error', rdkit: { available: false } };
  }
}

export function datasetEntries() {
  return store.catalog?.datasets || [];
}

export async function loadDataset(datasetId) {
  const entries = datasetEntries();
  const entry = entries.find((d) => d.dataset_id === datasetId) || entries[0];
  if (!entry) throw new Error('catalog has no datasets');

  const payload = await api(`/api/v1/datasets/${encodeURIComponent(entry.dataset_id)}`);
  const adapter = adapterFor(payload.schema_version);

  store.datasetId = entry.dataset_id;
  store.raw = payload;
  store.adapter = adapter;
  store.unsupported = adapter ? null : { schemaVersion: payload.schema_version, known: knownSchemas() };
  localStorage.setItem('review-dataset', entry.dataset_id);

  if (!adapter) {
    store.compounds = [];
    store.reactions = [];
    store.alignments = [];
    store.reviewItems = [];
    emit();
    return store;
  }

  store.summary = adapter.loadSummary(payload);
  store.compounds = adapter.loadCompounds(payload);
  store.reactions = adapter.loadReactions(payload);
  store.alignments = adapter.loadAlignments(payload);
  store.evidence = adapter.loadEvidence(payload);
  store.routeGraph = adapter.loadRouteGraph(payload);
  store.reviewItems = adapter.loadReviewItems(payload);
  store.issues = adapter.loadIssues ? adapter.loadIssues(payload) : [];
  store.validations = adapter.loadValidations ? adapter.loadValidations(payload) : [];
  store.alignmentCandidates = adapter.loadAlignmentCandidates ? adapter.loadAlignmentCandidates(payload) : [];
  store.reviewState = payload.review_state || {};

  store.byUid = new Map();
  for (const collection of [store.compounds, store.reactions, store.alignments]) {
    for (const item of collection) store.byUid.set(item.uid, item);
  }

  await loadEvents();
  emit();
  return store;
}

export async function loadEvents() {
  if (!store.datasetId) return;
  const payload = await api(`/api/v1/datasets/${encodeURIComponent(store.datasetId)}/review-events`);
  store.events = payload.events || [];
  store.reviewState = payload.current || {};
  emit();
}

/* --------------------------------------------------------------- lookups */

export const compound = (uid) => store.compounds.find((c) => c.uid === uid) || null;
export const reaction = (uid) => store.reactions.find((r) => r.uid === uid) || null;
export const alignment = (uid) => store.alignments.find((a) => a.uid === uid) || null;
export const reviewItem = (uid) => store.reviewItems.find((i) => i.uid === uid) || null;

export function label(uid) {
  const view = store.byUid.get(uid);
  if (!view) return uid;
  return view.label || uid;
}

export function alignmentsFor(reactionUid) {
  return store.alignments.filter((a) => a.reactionUid === reactionUid);
}

export function candidatesFor(reactionUid) {
  return store.alignmentCandidates.filter((c) => c.reactionUid === reactionUid);
}

export function validationsFor(target) {
  return store.validations.filter((v) => v.target === target);
}

export function issuesFor(uid) {
  return store.issues.filter((i) => (i.entities || []).includes(uid));
}

/* ---------------------------------------------------------------- review */

export const adhocUid = (kind, uid) => `ADHOC:${kind}:${uid}`;

export function decisionFor(itemUid) {
  return store.reviewState[itemUid] || null;
}

export function eventsFor(itemUid) {
  return store.events.filter((e) => e.review_item_uid === itemUid);
}

/**
 * Queue progress counts flagged problems; coverage counts every entity a human
 * has actually signed off on. Both matter: this dataset has 5 queue items but
 * 51 reviewable entities.
 */
export function progress() {
  const queueItems = store.reviewItems.map((i) => i.uid);
  const decidedQueue = queueItems.filter((uid) => store.reviewState[uid]).length;
  const touched = new Set();
  for (const [itemUid, entry] of Object.entries(store.reviewState)) {
    if (!entry) continue;
    if (itemUid.startsWith('ADHOC:')) touched.add(itemUid.split(':')[2]);
    else {
      const item = reviewItem(itemUid);
      if (item?.entityUid) touched.add(item.entityUid);
    }
  }
  const total = store.summary?.entityTotal
    || (store.compounds.length + store.reactions.length + store.alignments.length);
  return {
    queueDecided: decidedQueue,
    queueTotal: queueItems.length,
    coverageDecided: touched.size,
    coverageTotal: total,
  };
}

export async function submitDecision({ itemUid, decision, correctedValue = null, comment = null }) {
  const headers = {
    'Idempotency-Key': crypto.randomUUID(),
    'If-Match': store.raw?.revision || '',
  };
  if (state.reviewer) headers['X-Reviewer-Id'] = state.reviewer;
  const body = {
    review_item_uid: itemUid,
    decision,
    corrected_value: correctedValue,
    comment,
    reviewer_id: state.reviewer || undefined,
  };
  const result = await api(`/api/v1/datasets/${encodeURIComponent(store.datasetId)}/review-events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  await loadEvents();
  return result;
}

export async function verifySource(alignmentUid) {
  return api(`/api/v1/datasets/${encodeURIComponent(store.datasetId)}/alignments/${alignmentUid}/verify-source`);
}

export async function evidenceDetail(evidenceId) {
  return api(`/api/v1/datasets/${encodeURIComponent(store.datasetId)}/evidence/${encodeURIComponent(evidenceId)}`);
}

export function assetUrl(name) {
  return store.summary?.assets?.[name] || store.raw?.assets?.[name] || null;
}
