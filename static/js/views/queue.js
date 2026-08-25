// The review workbench: queue on the left, the thing being judged in the
// middle, its evidence on the right. Nothing here should require a page change
// before a reviewer can decide.

import {
  h, card, chip, pageHead, empty, structure, imageWithFallback, smilesBlock, fmt, svgIcon, ICONS,
} from '../util.js';
import { store, reviewItem, compound, reaction, alignment, candidatesFor, decisionFor } from '../store.js';
import { reviewBar, decisionLabel, decisionKind } from '../review.js';
import { evidencePanel } from '../evidence.js';
import { evidenceDetail } from '../store.js';
import { compoundPanel, reactionPanel, alignmentPanel } from './panels.js';

const filters = { priority: 'all', status: 'all' };
let activeUid = null;
let barNode = null;

export function renderQueue(main, params) {
  const items = visibleItems();
  activeUid = params?.itemUid || activeUid;
  if (!items.find((item) => item.uid === activeUid)) activeUid = items[0]?.uid || null;

  const listColumn = h('div', { class: 'queue' });
  const panelColumn = h('div', { class: 'stack' });
  const evidenceColumn = h('div', { class: 'stack evidence-col' });

  main.append(
    pageHead('审核队列',
      `${store.reviewItems.length} 项 · 快捷键 j/k 切换 · a 接受 · x 拒绝 · c 更正 · d 延后 · e 放大证据 · Enter 提交`),
    h('div', { class: 'work' }, listColumn, panelColumn, evidenceColumn));

  function paint() {
    listColumn.replaceChildren(filterBar(paint), ...queueRows(paint));
    panelColumn.replaceChildren(...detailNodes());
    evidenceColumn.replaceChildren();
    renderEvidence(evidenceColumn);
  }

  function queueRows(repaint) {
    const rows = visibleItems();
    if (!rows.length) return [empty('没有符合筛选条件的审核项')];
    return rows.map((item) => {
      const decided = decisionFor(item.uid);
      return h('div', {
        class: `queue-item ${item.uid === activeUid ? 'on' : ''}`.trim(),
        onclick: () => { activeUid = item.uid; window.location.hash = `#/queue/${item.uid}`; repaint(); },
      },
        h('span', { class: `qbar ${item.priority}` }),
        h('div', {},
          h('div', { class: 'qtitle' },
            h('span', { text: item.entityLabel || item.entityUid || '数据集级' }),
            chip(item.priority, item.priority === 'high' ? 'bad' : item.priority === 'medium' ? 'warn' : '')),
          h('div', { class: 'qreason', text: item.reason || '' }),
          h('div', { class: 'qmeta' },
            item.typeLabel ? chip(item.typeLabel) : null,
            decided ? chip(decisionLabel(decided.decision), decisionKind(decided.decision)) : chip('待审', 'warn'))));
    });
  }

  function detailNodes() {
    const item = reviewItem(activeUid);
    if (!item) return [card(empty('队列为空'))];
    const entity = entityFor(item);

    const header = h('div', { class: 'spread panel-head' },
      h('div', {},
        h('div', { class: 'eyebrow', text: `${item.issueUid || item.uid} · ${item.typeLabel || item.type}` }),
        h('h2', { class: 'panel-title', text: titleFor(item, entity) }),
        h('div', { class: 'small mono muted', text: [item.entityUid, item.entityKind].filter(Boolean).join(' · ') })),
      h('div', { class: 'row' },
        item.targetRoute ? h('a', { class: 'btn btn-ghost btn-sm', href: item.targetRoute }, '打开完整页面') : null));

    const reason = item.reason ? h('div', { class: 'callout warn' }, item.reason) : null;

    barNode = reviewBar(item.uid, {
      correction: correctionFor(item, entity),
      onSubmitted: () => { advance(); paint(); },
    });

    return [card(header, reason, entityBody(item, entity), h('hr', { class: 'divider' }), barNode)];
  }

  async function renderEvidence(column) {
    const item = reviewItem(activeUid);
    if (!item) return;
    const entity = entityFor(item);
    const ids = new Set([...(item.evidenceIds || []), ...((entity && entity.evidenceIds) || [])]);
    if (entity?.evidenceId) ids.add(entity.evidenceId);
    if (!ids.size) {
      column.append(card(empty('这个审核项没有直接关联的证据')));
      return;
    }
    for (const id of [...ids].slice(0, 3)) {
      const box = card(h('div', { class: 'small muted', text: `载入 ${id}…` }));
      column.append(box);
      try {
        const detail = await evidenceDetail(id);
        box.replaceChildren(evidencePanel(detail));
      } catch (error) {
        box.replaceChildren(empty(`证据 ${id} 载入失败`));
      }
    }
  }

  function advance() {
    const rows = visibleItems();
    const index = rows.findIndex((item) => item.uid === activeUid);
    const next = rows.slice(index + 1).find((item) => !decisionFor(item.uid));
    if (next) {
      activeUid = next.uid;
      window.location.hash = `#/queue/${next.uid}`;
    }
  }

  paint();
  main.__hotkeys = (key) => hotkey(key, paint);
}

function hotkey(key, repaint) {
  const rows = visibleItems();
  const index = rows.findIndex((item) => item.uid === activeUid);
  if (key === 'j' || key === 'k') {
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))];
    if (next) {
      activeUid = next.uid;
      window.location.hash = `#/queue/${next.uid}`;
      repaint();
    }
    return true;
  }
  const decisions = { a: 'accepted', x: 'rejected', c: 'corrected', d: 'deferred' };
  if (decisions[key] && barNode) {
    barNode.chooseDecision(decisions[key]);
    return true;
  }
  if (key === 'Enter' && barNode) {
    barNode.submit();
    return true;
  }
  return false;
}

function visibleItems() {
  return store.reviewItems.filter((item) => {
    if (filters.priority !== 'all' && item.priority !== filters.priority) return false;
    if (filters.status === 'pending' && decisionFor(item.uid)) return false;
    if (filters.status === 'done' && !decisionFor(item.uid)) return false;
    return true;
  });
}

function filterBar(repaint) {
  const button = (group, value, label) => h('button', {
    class: `chip chip-btn ${filters[group] === value ? 'on' : ''}`.trim(),
    onclick: () => { filters[group] = value; repaint(); },
  }, label);
  return h('div', { class: 'queue-filters' },
    button('priority', 'all', `全部 ${store.reviewItems.length}`),
    button('priority', 'high', 'high'),
    button('priority', 'medium', 'medium'),
    button('priority', 'low', 'low'),
    button('status', 'pending', '待审'),
    button('status', 'done', '已决'),
    button('status', 'all', '不限'));
}

function entityFor(item) {
  if (item.entityKind === 'compound') return compound(item.entityUid);
  if (item.entityKind === 'reaction') return reaction(item.entityUid);
  if (item.entityKind === 'alignment') return alignment(item.entityUid);
  return null;
}

function titleFor(item, entity) {
  if (entity) return `${entity.label}${item.entityKind === 'compound' ? ' 的结构' : ''}`;
  return item.entityUid === store.datasetId ? '数据集级问题' : item.entityUid || item.uid;
}

/** The middle column: the entity itself, minus its own review bar. */
function entityBody(item, entity) {
  if (item.entityKind === 'compound' && entity) return compoundPanel(entity, { withReview: false });
  if (item.entityKind === 'reaction' && entity) return reactionPanel(entity, { withReview: false });
  if (item.entityKind === 'alignment' && entity) return alignmentPanel(entity, { withReview: false });
  return h('div', { class: 'stack' },
    h('div', { class: 'callout' }, '这条问题不指向单个实体，请结合下面的信息判断。'),
    h('div', { class: 'small mono muted', text: item.entityUid || '' }));
}

function correctionFor(item, entity) {
  if (item.entityKind === 'compound') {
    return { type: 'smiles', value: entity?.smiles?.raw || '', placeholder: '按裁剪图重写的 SMILES' };
  }
  if (item.entityKind === 'reaction') {
    return {
      type: 'fields',
      fields: [
        { key: 'conditions_raw', label: '条件', value: entity?.conditionsRaw || '' },
        { key: 'yield', label: '产率 %', value: entity?.yield?.value ?? '' },
        { key: 'note', label: '说明', value: '' },
      ],
    };
  }
  if (item.entityKind === 'alignment') {
    return { type: 'passage', options: candidatesFor(entity?.reactionUid) };
  }
  return { type: 'text', placeholder: '更正说明' };
}
