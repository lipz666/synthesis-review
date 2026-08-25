// Entity panels shared by the detail pages and the review workbench, so a
// compound looks and behaves the same wherever it is being judged.

import {
  h, chip, card, structure, smilesBlock, statusChip, confidenceChip, fmt, empty,
  imageWithFallback, sectionTitle, link, svgIcon, ICONS,
} from '../util.js';
import { evidenceChips, evidenceChip, highlightedPassage, openEvidence } from '../evidence.js';
import {
  store, compound, reaction, alignment, alignmentsFor, candidatesFor, validationsFor,
  issuesFor, adhocUid,
} from '../store.js';
import { reviewBar } from '../review.js';

/* -------------------------------------------------------------- compound */

export function compoundPanel(view, { withReview = true } = {}) {
  if (!view) return empty('找不到这个化合物');
  const identity = view.identity || {};
  const unspecified = identity.unspecifiedStereocenters;

  const compare = h('div', { class: 'compare' },
    h('div', { class: 'compare-col' },
      h('h4', { text: '论文里的样子（OCSR 输入裁剪）' }),
      h('div', { class: 'frame' },
        view.cropUrl ? imageWithFallback(view.cropUrl, view.label) : empty('没有裁剪图')),
      h('div', { class: 'row' },
        ...view.mentions.map((m) => chip(`${m.visualId || '—'} · p${m.page}`)),
        view.evidenceIds.length ? h('button', {
          class: 'chip chip-btn',
          onclick: () => openEvidence(view.evidenceIds[0]),
        }, svgIcon(ICONS.image, 12), '在页面上定位') : null)),
    h('div', { class: 'compare-col' },
      h('h4', { text: '模型读出来的（RDKit 渲染）' }),
      h('div', { class: 'frame' }, structure(view, { width: 300, height: 210, crop: false })),
      h('div', { class: 'row' },
        statusChip(view.statusRaw),
        confidenceChip(view.confidence),
        identity.formula ? chip(identity.formula) : null,
        identity.exactMass ? chip(String(identity.exactMass)) : null)));

  const warnings = [];
  if (unspecified) {
    warnings.push(h('div', { class: 'callout warn' },
      `立体中心 ${identity.stereocenters ?? '?'} 个，其中 ${unspecified} 个未指定。请对照左图确认楔形键。`));
  }
  if (view.statusRaw === 'unresolved') {
    warnings.push(h('div', { class: 'callout bad' },
      'RDKit 无法解析这个结构。请对照裁剪图填写更正后的 SMILES；原始读数会保留在事件记录里。'));
  }
  for (const issue of issuesFor(view.uid)) {
    warnings.push(h('div', { class: `callout ${issue.severity === 'high' ? 'bad' : issue.severity === 'medium' ? 'warn' : ''}` },
      `${issue.typeLabel}：${issue.description}`));
  }

  const smiles = h('div', { class: 'stack' },
    smilesBlock('raw（被选中的原始读数）', view.smiles.raw),
    smilesBlock('canonical（RDKit 规范化）', view.smiles.canonical),
    view.smiles.isomeric && view.smiles.isomeric !== view.smiles.canonical
      ? smilesBlock('isomeric', view.smiles.isomeric) : null,
    identity.inchiKey ? h('div', { class: 'small mono muted', text: `InChIKey ${identity.inchiKey}` }) : null);

  const candidates = view.candidates.length
    ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, ''), h('th', {}, '视觉框'), h('th', {}, '模型'), h('th', {}, '裁剪变体'),
        h('th', { class: 'num' }, '置信'), h('th', {}, '可解析'), h('th', {}, '警告'))),
      h('tbody', {}, ...view.candidates.map((candidate, index) => h('tr', {},
        h('td', {}, index === 0 ? chip('已选', 'accent') : ''),
        h('td', { class: 'mono' }, candidate.visualId || '—'),
        h('td', {}, candidate.model || '—'),
        h('td', {}, candidate.variant || '—'),
        h('td', { class: 'num' }, candidate.confidence != null ? candidate.confidence.toFixed(2) : '—'),
        h('td', {}, candidate.parsable ? chip('是', 'ok') : chip('否', 'bad')),
        h('td', { class: 'small muted' }, (candidate.warnings || []).join('；') || '—')))))
    : empty('没有 OCSR 候选');

  const related = h('div', { class: 'related' },
    relatedBlock('作为反应物', view.reactions.asReactant.map((uid) => reactionChip(uid))),
    relatedBlock('作为产物', view.reactions.asProduct.map((uid) => reactionChip(uid))),
    relatedBlock('证据', [evidenceChips(view.evidenceIds)]));

  const nodes = [compare, ...warnings, h('hr', { class: 'divider' }), smiles,
    h('hr', { class: 'divider' }),
    sectionTitle('OCSR 候选', h('span', { class: 'small muted', text: '选中候选＝记录一条 corrected 事件，原候选不删除' })),
    candidates,
    h('hr', { class: 'divider' }), related];

  if (withReview) {
    nodes.push(reviewBar(adhocUid('compound', view.uid), {
      labels: { accepted: '结构正确', rejected: '结构错误', corrected: '改写 SMILES', deferred: '拿不准' },
      correction: { type: 'smiles', value: view.smiles.raw || '', placeholder: '按裁剪图重写的 SMILES' },
    }));
  }
  return h('div', { class: 'stack' }, ...nodes);
}

/* -------------------------------------------------------------- reaction */

export function reactionPanel(view, { withReview = true } = {}) {
  if (!view) return empty('找不到这个反应');

  const equation = h('div', { class: 'equation' },
    h('div', { class: 'equation-side' },
      ...joinPlus(view.reactants.map((uid) => moleculeChipCard(uid)))),
    h('div', { class: 'equation-arrow' },
      h('div', { class: 'conditions', text: fmt(view.conditionsRaw, '条件未记录') }),
      h('div', { class: 'arrow-line' }, svgIcon(ICONS.arrow, 26)),
      h('div', { class: 'yield-line' }, yieldChip(view))),
    h('div', { class: 'equation-side' },
      ...joinPlus(view.products.map((uid) => moleculeChipCard(uid)))));

  const facts = h('div', { class: 'metrics' },
    metricCell('步序', view.stepIndex != null ? `#${view.stepIndex + 1}` : '—'),
    metricCell('温度', view.temperature?.value ?? '未给出', view.temperature?.rawText),
    metricCell('时间', view.time?.value ?? '未给出', view.time?.rawText),
    metricCell('产率', view.yield?.value != null ? `${view.yield.value}%` : '未给出', view.yield?.rawText),
    metricCell('产率类型', view.yieldType === 'two_step' ? '两步合计' : fmt(view.yieldType, '—')),
    metricCell('校验', view.status || '—'));

  const validations = view.validations.length
    ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, '检查'), h('th', {}, '结果'), h('th', {}, '指标'), h('th', {}, '说明'))),
      h('tbody', {}, ...view.validations.map((v) => h('tr', {},
        h('td', { class: 'mono' }, v.check),
        h('td', {}, v.passed ? chip('通过', 'ok') : chip('未通过', v.severity === 'blocking' ? 'bad' : 'warn')),
        h('td', { class: 'small mono' }, Object.entries(v.metrics)
          .map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value.toFixed(3)) : value}`)
          .join(' · ') || '—'),
        h('td', { class: 'small muted' }, v.detail || '—')))))
    : empty('没有针对该反应的确定性校验');

  const mapperNote = view.validations.some((v) => v.metrics?.mapper === 'none')
    ? h('div', { class: 'callout' },
      'rxnmapper 未安装：以上只有守恒度指标，不是原子映射结论，不要当成机理级证据。')
    : null;

  const links = alignmentsFor(view.uid);
  const alignmentList = links.length
    ? h('div', { class: 'stack' }, ...links.map((item) => h('div', { class: 'mini-passage' },
      h('div', { class: 'row' },
        chip(item.relationLabel, 'info'),
        item.verified ? chip('已回查原文', 'ok') : chip('未回查', 'warn'),
        chip(`p${item.page}`),
        link(item.route, '打开对齐审核 →')),
      h('div', { class: 'small', text: truncate(item.text, 220) }))))
    : empty('没有关联到原文段落');

  const nodes = [
    equation, facts,
    view.reactionSmiles ? h('div', {}, smilesBlock('reaction SMILES（导出用，不作为参与者依据）', view.reactionSmiles)) : null,
    h('hr', { class: 'divider' }),
    sectionTitle('确定性校验'), validations, mapperNote,
    h('hr', { class: 'divider' }),
    sectionTitle('原文对齐'), alignmentList,
    h('hr', { class: 'divider' }),
    sectionTitle('证据'), evidenceChips(view.evidenceIds),
  ];

  if (withReview) {
    nodes.push(reviewBar(adhocUid('reaction', view.uid), {
      labels: { accepted: '反应正确', rejected: '反应错误', corrected: '更正条件/产率', deferred: '拿不准' },
      correction: {
        type: 'fields',
        fields: [
          { key: 'conditions_raw', label: '条件', value: view.conditionsRaw || '' },
          { key: 'temperature', label: '温度', value: view.temperature?.value ?? '' },
          { key: 'time', label: '时间', value: view.time?.value ?? '' },
          { key: 'yield', label: '产率 %', value: view.yield?.value ?? '' },
        ],
      },
    }));
  }
  return h('div', { class: 'stack' }, ...nodes);
}

/* ------------------------------------------------------------- alignment */

export function alignmentPanel(view, { withReview = true } = {}) {
  if (!view) return empty('找不到这条对齐');
  const rxn = reaction(view.reactionUid);

  const left = h('div', { class: 'align-col' },
    h('h4', { text: '反应（来自 Scheme）' }),
    rxn ? h('div', { class: 'stack' },
      h('div', { class: 'row' },
        ...rxn.reactants.map((uid) => chip(labelOf(uid))),
        svgIcon(ICONS.arrow, 16),
        ...rxn.products.map((uid) => chip(labelOf(uid), 'accent'))),
      h('div', { class: 'conditions small', text: fmt(rxn.conditionsRaw, '条件未记录') }),
      link(rxn.route, '打开反应审核 →'),
    ) : empty('反应不存在'));

  const right = h('div', { class: 'align-col' },
    h('h4', { text: '论文原文' }),
    h('div', { class: 'row' },
      chip(view.relationLabel, 'info'),
      chip(view.consistencyLabel, view.consistency === 'consistent' ? 'ok' : view.consistency === 'partial' ? 'warn' : ''),
      view.verified
        ? chip(`已回查原文 p${view.page} [${view.charStart},${view.charEnd})`, 'ok')
        : chip(`未能回查（${view.verifyReason || '未知'}）`, 'warn'),
      view.claimedVerified && !view.verified ? chip('模型自称已核对', 'bad') : null),
    highlightedPassage(view.text, view.mentions),
    h('div', { class: 'row' },
      h('span', { class: 'small muted', text: '高亮：' }),
      h('span', { class: 'legend react', text: '反应物' }),
      h('span', { class: 'legend prod', text: '产物' }),
      h('span', { class: 'legend cond', text: '条件' })),
    scoreBars(view.scores),
    view.evidenceId ? h('div', { class: 'row' }, evidenceChip(view.evidenceId)) : null);

  const nodes = [h('div', { class: 'align-grid' }, left, right)];

  if (withReview) {
    nodes.push(reviewBar(adhocUid('alignment', view.uid), {
      labels: { accepted: '对齐正确', rejected: '对齐错误', corrected: '改选段落', deferred: '拿不准' },
      correction: { type: 'passage', options: candidatesFor(view.reactionUid) },
    }));
  }
  return h('div', { class: 'stack' }, ...nodes);
}

/* ----------------------------------------------------------------- bits */

function metricCell(label, value, note) {
  return h('div', { class: 'metric' },
    h('div', { class: 'metric-label', text: label }),
    h('div', { class: 'metric-value small-value', text: String(value) }),
    note ? h('div', { class: 'metric-note', text: note }) : null);
}

function yieldChip(view) {
  if (view.yield?.value == null) return chip('未给出产率');
  const label = view.yieldType === 'two_step' ? `${view.yield.value}% · 两步` : `${view.yield.value}%`;
  const node = chip(label, 'ok');
  if (view.yield.rawText) node.title = view.yield.rawText;
  return node;
}

function moleculeChipCard(uid) {
  const view = compound(uid);
  if (!view) return h('div', { class: 'mol-mini' }, h('div', { class: 'mono small', text: uid }));
  return h('a', { class: 'mol-mini', href: view.route, title: view.smiles.raw || '' },
    structure(view, { width: 150, height: 110 }),
    h('div', { class: 'row' },
      h('strong', { class: 'small', text: view.label }),
      view.statusRaw === 'unresolved' ? chip('未解析', 'bad') : null));
}

function joinPlus(nodes) {
  const out = [];
  nodes.forEach((node, index) => {
    if (index) out.push(h('span', { class: 'plus', text: '+' }));
    out.push(node);
  });
  return out.length ? out : [h('span', { class: 'small muted', text: '未记录参与者' })];
}

function reactionChip(uid) {
  const view = reaction(uid);
  return h('a', { class: 'chip chip-btn', href: `#/reaction/${uid}` },
    view ? `${uid}${view.yield?.value != null ? ` · ${view.yield.value}%` : ''}` : uid);
}

function relatedBlock(title, nodes) {
  return h('div', {},
    h('div', { class: 'eyebrow', text: title }),
    nodes.length ? h('div', { class: 'row' }, ...nodes) : h('span', { class: 'small muted', text: '无' }));
}

function scoreBars(scores) {
  const rows = [
    ['检索分', scores.retrieval, 10],
    ['语义置信', scores.semantic, 1],
    ['综合置信', scores.combined, 1],
  ];
  return h('div', { class: 'bars' }, ...rows.map(([label, value, max]) => h('div', { class: 'bar-row' },
    h('span', { class: 'small muted', text: label }),
    h('span', { class: 'bar-track' },
      h('span', { class: 'bar-fill', style: { width: `${Math.min(100, ((value ?? 0) / max) * 100)}%` } })),
    h('span', { class: 'small mono', text: value == null ? '—' : String(value) }))));
}

function labelOf(uid) {
  const view = compound(uid);
  return view ? view.label : uid;
}

function truncate(text, length) {
  const value = String(text || '');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function entityPanel(kind, uid, options) {
  if (kind === 'compound') return compoundPanel(compound(uid), options);
  if (kind === 'reaction') return reactionPanel(reaction(uid), options);
  if (kind === 'alignment') return alignmentPanel(alignment(uid), options);
  return null;
}

export { card };
