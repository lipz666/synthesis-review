// Route map, quality panel, review history, and the unsupported-schema screen.

import {
  h, card, chip, pageHead, empty, sectionTitle, link, timeAgo, callout,
} from '../util.js';
import { store, progress } from '../store.js';
import { routeMap, routeFallback } from '../routemap.js';
import { decisionLabel, decisionKind } from '../review.js';

/* ----------------------------------------------------------------- route */

export function renderRoute(main) {
  const graph = store.routeGraph;
  main.append(pageHead('路线',
    `${graph.nodes.length} 个节点 · 最长线性序列 ${graph.longestLinearSequence ?? '—'} · 连通分量 ${graph.components ?? '—'}`
    + `${graph.targetReachable ? ' · 目标可达' : ' · 目标不可达'}`));

  const box = card(sectionTitle('交互路线图',
    h('span', { class: 'small muted', text: '点击节点进入审核；收敛支线按最长路径分层' })));
  try {
    box.append(routeMap(graph));
  } catch (error) {
    box.append(callout(`布局失败，已切换到静态路线图：${error.message}`, 'warn'));
    const fallback = routeFallback();
    if (fallback) box.append(fallback);
  }
  main.append(box);

  const fallback = routeFallback();
  if (fallback) {
    main.append(card(sectionTitle('离线路线图（降级视图）'), fallback));
  }
}

/* --------------------------------------------------------------- quality */

export function renderQuality(main) {
  const failed = store.validations.filter((v) => !v.passed);
  const blocking = failed.filter((v) => v.severity === 'blocking');

  main.append(pageHead('质量',
    `${store.validations.length} 项确定性校验 · ${failed.length} 项未通过 · ${store.issues.length} 个已知问题`));

  if (blocking.length) {
    main.append(callout(`有 ${blocking.length} 项阻断级校验未通过，数据不可发布。`, 'bad'));
  }

  main.append(card(
    sectionTitle('确定性校验'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '检查'), h('th', {}, '对象'), h('th', {}, '结果'),
          h('th', {}, '级别'), h('th', {}, '指标'), h('th', {}, '说明'))),
        h('tbody', {}, ...store.validations.map((v) => h('tr', { class: v.passed ? '' : 'row-bad' },
          h('td', { class: 'mono' }, v.check),
          h('td', { class: 'mono small' }, v.target === '-' ? '整体' : linkForTarget(v.target)),
          h('td', {}, v.passed ? chip('通过', 'ok') : chip('未通过', v.severity === 'blocking' ? 'bad' : 'warn')),
          h('td', {}, chip(v.severity)),
          h('td', { class: 'small mono' }, Object.entries(v.metrics)
            .map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value.toFixed(3)) : value}`)
            .join(' · ') || '—'),
          h('td', { class: 'small muted' }, v.detail || '—')))))),
  ));

  main.append(card(
    sectionTitle('已知问题'),
    store.issues.length
      ? h('div', { class: 'stack' }, ...store.issues.map(issueCard))
      : empty('没有记录问题')));
}

function issueCard(issue) {
  const item = store.reviewItems.find((i) => i.issueUid === issue.uid);
  return h('div', { class: `issue-card ${issue.severity}` },
    h('div', { class: 'spread' },
      h('div', { class: 'row' },
        chip(issue.typeLabel, issue.severity === 'high' ? 'bad' : issue.severity === 'medium' ? 'warn' : ''),
        chip(issue.uid),
        chip(issue.status)),
      item ? h('a', { class: 'btn btn-ghost btn-sm', href: `#/queue/${item.uid}` }, '去审核') : null),
    h('div', { class: 'small', text: issue.description }),
    issue.entities.length
      ? h('div', { class: 'row' }, ...issue.entities.map((uid) => h('span', { class: 'chip mono' }, uid)))
      : null);
}

function linkForTarget(target) {
  if (!target) return '—';
  if (target.startsWith('RXN')) return link(`#/reaction/${target}`, target);
  if (target.startsWith('CMP')) return link(`#/compound/${target}`, target);
  return target;
}

/* --------------------------------------------------------------- history */

export function renderHistory(main) {
  const stats = progress();
  main.append(pageHead('审核历史',
    `${store.events.length} 条事件 · 已决策 ${Object.keys(store.reviewState).length} 项 · 覆盖 ${stats.coverageDecided}/${stats.coverageTotal}`,
    h('a', {
      class: 'btn btn-ghost btn-sm',
      href: `/api/v1/datasets/${encodeURIComponent(store.datasetId)}/review-events/export.jsonl`,
    }, '导出 JSONL')));

  if (!store.events.length) {
    main.append(card(empty('还没有审核事件。事件只追加，不会覆盖抽取结果。')));
    return;
  }

  const grouped = new Map();
  for (const event of store.events) {
    if (!grouped.has(event.review_item_uid)) grouped.set(event.review_item_uid, []);
    grouped.get(event.review_item_uid).push(event);
  }

  main.append(card(
    sectionTitle('按审核项'),
    h('div', { class: 'stack' }, ...[...grouped.entries()].map(([itemUid, events]) => {
      const last = events[events.length - 1];
      return h('div', { class: 'history-item' },
        h('div', { class: 'spread' },
          h('div', { class: 'row' },
            h('strong', { class: 'mono small', text: itemUid }),
            chip(decisionLabel(last.decision), decisionKind(last.decision)),
            events.length > 1 ? chip(`${events.length} 次决定`) : null),
          entityLink(last)),
        h('div', { class: 'timeline' }, ...events.map(eventRow)));
    }))));
}

function eventRow(event) {
  return h('div', { class: 'timeline-row' },
    h('span', { class: `dot dot-${decisionKind(event.decision) || 'muted'}` }),
    h('div', {},
      h('div', { class: 'row' },
        h('strong', { class: 'small', text: decisionLabel(event.decision) }),
        h('span', { class: 'small muted', text: `${event.reviewer_id} · ${timeAgo(event.reviewed_at)}` }),
        chip(`rev ${String(event.dataset_revision || '').slice(0, 8)}`)),
      event.corrected_value
        ? h('pre', { class: 'code small', text: JSON.stringify(event.corrected_value, null, 1) })
        : null,
      event.comment ? h('div', { class: 'small', text: `备注：${event.comment}` }) : null,
      h('div', { class: 'small mono muted', text: event.review_event_uid })));
}

function entityLink(event) {
  const uid = event.entity_uid;
  if (!uid) return null;
  if (uid.startsWith('CMP')) return link(`#/compound/${uid}`, uid);
  if (uid.startsWith('RXN')) return link(`#/reaction/${uid}`, uid);
  if (uid.startsWith('ALIGN')) return link(`#/alignment/${uid}`, uid);
  return h('span', { class: 'small mono muted', text: uid });
}

/* ----------------------------------------------------------- unsupported */

export function renderUnsupported(main) {
  const info = store.unsupported;
  main.append(
    pageHead('不支持的数据格式', '前端不会猜测未知 schema 的字段含义。'),
    card(
      callout(`数据集声明的 schema_version 是 ${info.schemaVersion}，当前没有对应的 adapter。`, 'bad'),
      h('p', { class: 'prose' }, '已支持的格式：'),
      h('div', { class: 'row' }, ...info.known.map((name) => chip(name, 'accent'))),
      h('p', { class: 'prose' },
        '要支持新格式，在 static/js/adapters/ 下新增一个 adapter 并注册到 index.js；页面代码不需要改动。')));
}
