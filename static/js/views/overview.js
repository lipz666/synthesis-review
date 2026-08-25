// Dataset overview: what this paper is, how big the extraction is, how far the
// review has got, and the target structure.

import {
  h, card, metric, chip, pageHead, sectionTitle, structure, markdown, empty, link,
} from '../util.js';
import { store, progress, compound, assetUrl } from '../store.js';

export async function renderOverview(main) {
  const summary = store.summary;
  const counts = summary.counts || {};
  const stats = progress();
  const target = compound(summary.targetUid);

  const head = pageHead(
    summary.title || summary.datasetId,
    [
      summary.doi ? `DOI ${summary.doi}` : null,
      summary.year,
      summary.schemaVersion,
      `rev ${summary.revision}`,
      summary.pipelineState,
    ].filter(Boolean).join(' · '),
  );

  const metrics = card(h('div', { class: 'metrics' },
    metric('化合物', counts.compounds ?? store.compounds.length),
    metric('反应', counts.reactions ?? store.reactions.length),
    metric('原文对齐', counts.alignments ?? store.alignments.length),
    metric('证据', counts.evidence ?? store.evidence.length),
    metric('待处理问题', counts.issues ?? store.issues.length, { kind: counts.issues ? 'bad' : '' }),
    metric('校验通过', h('span', {}, `${store.validations.filter((v) => v.passed).length}`,
      h('small', { text: `/${store.validations.length}` }))),
    metric('最长线性序列', summary.routeStats.longestLinearSequence ?? '—'),
    metric('目标可达', summary.routeStats.targetReachable ? '✓' : '✗',
      { kind: summary.routeStats.targetReachable ? 'good' : 'bad' }),
  ));

  const progressCard = card(
    sectionTitle('审核进度'),
    progressRow('待办', stats.queueDecided, stats.queueTotal,
      '来自 review_queue.json 的问题项'),
    progressRow('覆盖率', stats.coverageDecided, stats.coverageTotal,
      '所有结构 / 反应 / 对齐中，已被人工签署过的比例'),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      ...priorityChips()),
    h('div', { class: 'hint' },
      '队列只收录被检测出问题的条目；其余实体也可以在各自页面上直接记录决定（即席审核项）。'),
  );

  const targetCard = card(
    sectionTitle('目标分子'),
    target
      ? h('div', {},
        structure(target, { width: 300, height: 220 }),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('strong', { text: target.label }),
          target.identity.formula ? chip(target.identity.formula) : null),
        h('div', { class: 'small muted mono', text: `${target.uid} · ${target.identity.inchiKey || ''}` }),
        h('div', { style: { marginTop: '8px' } }, link(target.route, '打开化合物审核 →')))
      : empty('数据里没有标出目标化合物'),
  );

  const strategy = summary.strategy
    ? card(sectionTitle('策略摘要'), h('p', { class: 'prose', text: summary.strategy }))
    : null;

  const documents = card(
    sectionTitle('文档与下载'),
    h('div', { class: 'row' },
      ...summary.documents.map((doc) => chip(`${doc.documentId} · ${doc.pageCount} 页`)),
      summary.documents.some((d) => !d.sourceAvailable)
        ? chip('原始 PDF 未公开', 'warn') : null),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      ...downloads()),
  );

  main.append(head, metrics,
    h('div', { class: 'grid-2' }, h('div', { class: 'stack' }, progressCard, strategy), targetCard),
    documents);

  const summaryUrl = assetUrl('extraction_summary');
  if (summaryUrl) {
    const box = card(sectionTitle('抽取摘要 extraction_summary.md'), h('div', { class: 'prose', text: '载入中…' }));
    main.append(box);
    try {
      const response = await fetch(summaryUrl);
      const text = await response.text();
      box.lastChild.innerHTML = markdown(text);
    } catch (_) {
      box.lastChild.textContent = '摘要读取失败';
    }
  }
}

function progressRow(label, done, total, hint) {
  const ratio = total ? done / total : 0;
  return h('div', { class: 'progress-block' },
    h('div', { class: 'progress-row' },
      h('span', { class: 'muted', text: label }),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${ratio * 100}%` } })),
      h('span', { class: 'mono', text: `${done} / ${total}` })),
    h('div', { class: 'small muted', text: hint }));
}

function priorityChips() {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const item of store.reviewItems) counts[item.priority] = (counts[item.priority] || 0) + 1;
  return [
    chip(`high ${counts.high || 0}`, counts.high ? 'bad' : ''),
    chip(`medium ${counts.medium || 0}`, counts.medium ? 'warn' : ''),
    chip(`low ${counts.low || 0}`),
  ];
}

function downloads() {
  const assets = store.raw?.assets || {};
  const names = {
    dataset: 'dataset.json',
    review_queue: 'review_queue.json',
    reactions_csv: 'reactions.csv',
    reaction_smiles_csv: 'reaction_smiles.csv',
    database_rows: 'database_rows.json',
    route_svg: 'route.svg',
  };
  const links = Object.entries(names)
    .filter(([key]) => assets[key])
    .map(([key, label]) => h('a', { class: 'chip chip-btn', href: assets[key], download: '' }, label));
  links.push(h('a', {
    class: 'chip chip-btn',
    href: `/api/v1/datasets/${encodeURIComponent(store.datasetId)}/review-events/export.jsonl`,
  }, '审核事件 .jsonl'));
  return links;
}
