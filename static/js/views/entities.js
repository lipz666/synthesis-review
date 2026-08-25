// List + detail pages for compounds, reactions and alignments.

import {
  h, card, chip, pageHead, empty, structure, imageWithFallback, statusChip,
  confidenceChip, fmt, sectionTitle, link, svgIcon, ICONS,
} from '../util.js';
import { store, compound, reaction, alignment, alignmentsFor } from '../store.js';
import { compoundPanel, reactionPanel, alignmentPanel } from './panels.js';
import { decisionBadge } from '../review.js';

const STATUS_ORDER = { unresolved: 0, warn: 1, ok: 2 };

/* ------------------------------------------------------------- compounds */

export function renderCompounds(main) {
  const sorted = [...store.compounds].sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || a.uid.localeCompare(b.uid));

  main.append(
    pageHead('化合物', `${store.compounds.length} 个 · 默认按结构状态排序（未解析 → 有警告 → 已校验）`),
    h('div', { class: 'list' }, ...sorted.map(compoundRow)));
}

function compoundRow(view) {
  return h('a', { class: 'list-row', href: view.route },
    h('div', { class: 'list-thumb' },
      view.cropUrl ? imageWithFallback(view.cropUrl, view.label) : h('span', { class: 'small muted', text: '无裁剪' })),
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' },
        h('strong', { text: view.label }),
        view.isTarget ? chip('目标', 'accent') : null,
        statusChip(view.statusRaw),
        confidenceChip(view.confidence),
        decisionBadge(`ADHOC:compound:${view.uid}`)),
      h('div', { class: 'list-smiles mono', text: view.smiles.raw || '（没有 SMILES）' }),
      h('div', { class: 'list-meta' },
        chip(view.uid),
        view.identity.formula ? chip(view.identity.formula) : null,
        chip(`反应 ${view.reactions.asReactant.length + view.reactions.asProduct.length}`),
        view.identity.unspecifiedStereocenters ? chip(`未指定立体 ${view.identity.unspecifiedStereocenters}`, 'warn') : null)));
}

export function renderCompound(main, { uid }) {
  const view = compound(uid);
  if (!view) return void main.append(empty(`没有这个化合物：${uid}`));
  main.append(
    pageHead(`化合物 ${view.label}`,
      `${view.uid} · ${view.statusRaw} · 置信 ${view.confidence ?? '—'}`,
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/compounds' }, '返回列表')),
    card(compoundPanel(view)));
}

/* ------------------------------------------------------------- reactions */

export function renderReactions(main) {
  const sorted = [...store.reactions].sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
  main.append(
    pageHead('反应', `${store.reactions.length} 步 · 参与者来自 reaction_participants，不解析 reaction SMILES`),
    h('div', { class: 'list' }, ...sorted.map(reactionRow)));
}

function reactionRow(view) {
  return h('a', { class: 'list-row', href: view.route },
    h('div', { class: 'list-thumb small mono' }, view.stepIndex != null ? `#${view.stepIndex + 1}` : '—'),
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' },
        h('strong', { text: `${view.reactants.map(labelOf).join(' + ')} → ${view.products.map(labelOf).join(' + ')}` }),
        statusChip(view.status),
        view.yield?.value != null
          ? chip(`${view.yield.value}%${view.yieldType === 'two_step' ? ' · 两步' : ''}`, 'ok')
          : chip('无产率'),
        decisionBadge(`ADHOC:reaction:${view.uid}`)),
      h('div', { class: 'list-smiles', text: (view.conditionsRaw || '条件未记录').replace(/\s*\n\s*/g, ' · ') }),
      h('div', { class: 'list-meta' },
        chip(view.uid),
        chip(`对齐 ${view.alignmentUids.length}`),
        ...view.validations.filter((v) => !v.passed).map((v) => chip(v.check, 'warn')))));
}

export function renderReaction(main, { uid }) {
  const view = reaction(uid);
  if (!view) return void main.append(empty(`没有这个反应：${uid}`));
  main.append(
    pageHead(`反应 ${view.label}`, `${view.uid} · ${view.schemeId || ''} · ${view.status}`,
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/reactions' }, '返回列表')),
    card(reactionPanel(view)));
}

/* ------------------------------------------------------------ alignments */

export function renderAlignments(main) {
  const verified = store.alignments.filter((a) => a.verified).length;
  main.append(
    pageHead('原文对齐',
      `${store.alignments.length} 条 · 服务端回查通过 ${verified} 条（source_verified 只是模型自称，不作为显示依据）`),
    h('div', { class: 'list' }, ...store.alignments.map(alignmentRow)));
}

function alignmentRow(view) {
  return h('a', { class: 'list-row', href: view.route },
    h('div', { class: 'list-thumb small mono' }, `p${view.page}`),
    h('div', { class: 'list-main' },
      h('div', { class: 'list-title' },
        h('strong', { text: view.reactionUid }),
        chip(view.relationLabel, 'info'),
        chip(view.consistencyLabel, view.consistency === 'consistent' ? 'ok' : view.consistency === 'partial' ? 'warn' : ''),
        view.verified ? chip('已回查原文', 'ok') : chip('未回查', 'warn'),
        decisionBadge(`ADHOC:alignment:${view.uid}`)),
      h('div', { class: 'list-smiles', text: view.text || '' }),
      h('div', { class: 'list-meta' },
        chip(view.uid),
        chip(`综合置信 ${view.scores.combined ?? '—'}`))));
}

export function renderAlignment(main, { uid }) {
  const view = alignment(uid);
  if (!view) return void main.append(empty(`没有这条对齐：${uid}`));
  main.append(
    pageHead('原文对齐审核', `${view.uid} · ${view.reactionUid} · p${view.page} [${view.charStart},${view.charEnd})`,
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/alignments' }, '返回列表')),
    card(alignmentPanel(view)));
}

function labelOf(uid) {
  const view = compound(uid);
  return view ? view.label : uid;
}
