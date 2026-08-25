// Evidence viewer: page image with box overlay, scheme crop, molecule crop,
// paper text with highlights. Used inline (a panel) and in the drawer.
//
// The server hands back box positions as fractions of the base image, so this
// file never converts dpi or pixels -- it only turns fractions into percent.

import { h, chip, openDrawer, imageWithFallback, svgIcon, ICONS, empty } from './util.js';
import { evidenceDetail, store } from './store.js';

const TYPE_LABEL = {
  scheme_image: 'Scheme 图',
  molecule_image: '分子裁剪',
  page_text: '原文段落',
};

export function evidenceChip(evidenceId, extra = '') {
  return h('button', {
    class: 'chip chip-btn', title: '查看证据',
    onclick: () => openEvidence(evidenceId),
  }, svgIcon(ICONS.image, 12), `${evidenceId}${extra}`);
}

export async function openEvidence(evidenceId) {
  const host = h('div', { class: 'evidence-loading', text: '载入证据…' });
  openDrawer(evidenceId, host, { wide: true });
  try {
    const detail = await evidenceDetail(evidenceId);
    host.replaceWith(evidencePanel(detail, { large: true }));
  } catch (error) {
    host.replaceWith(empty(`无法载入证据：${error.message}`));
  }
}

/** Render one resolved evidence record (the /evidence/{id} response). */
export function evidencePanel(detail, { large = false } = {}) {
  const record = detail.evidence || {};
  const nodes = [];

  nodes.push(h('div', { class: 'row' },
    chip(TYPE_LABEL[record.evidence_type] || record.evidence_type, 'accent'),
    record.page ? chip(`p${record.page}`) : null,
    record.scheme_id ? chip(record.scheme_id) : null,
    detail.coord_space ? chip(detail.coord_space) : null,
    record.extraction_method ? chip(record.extraction_method) : null));

  if (detail.crop_url) {
    nodes.push(h('div', { class: 'evidence-crop' }, imageWithFallback(detail.crop_url, record.evidence_id)));
  }

  if (detail.base && detail.base.url) {
    const host = h('div', {});
    const paint = (base) => host.replaceChildren(overlay(base, detail.fractions, {
      label: record.evidence_id,
      extra: large ? detail.detections : null,
      highlight: record.evidence_id,
    }));
    paint(detail.base);
    const renders = detail.renders || [];
    if (renders.length > 1) {
      nodes.push(h('div', { class: 'row' },
        h('span', { class: 'small muted', text: '底图分辨率' }),
        ...renders.map((render) => h('button', {
          class: `chip chip-btn ${render.dpi === detail.base.dpi ? 'on' : ''}`.trim(),
          onclick: (event) => {
            event.currentTarget.parentNode.querySelectorAll('.chip-btn').forEach((chipNode) => chipNode.classList.remove('on'));
            event.currentTarget.classList.add('on');
            paint({ kind: 'page', ...render });
          },
        }, `${render.dpi} dpi`))));
    }
    nodes.push(host);
  }

  if (record.text) {
    nodes.push(h('div', { class: 'passage' }, record.text));
  }

  if (detail.note) {
    nodes.push(h('div', { class: 'small muted', text: detail.note }));
  }

  if (detail.scheme && detail.scheme.overlay_url) {
    nodes.push(h('details', { class: 'foldout' },
      h('summary', { text: '带检测编号的 Scheme 叠图' }),
      imageWithFallback(detail.scheme.overlay_url, 'moldet overlay', 'full-img')));
  }

  return h('div', { class: `evidence-panel${large ? ' large' : ''}` }, ...nodes);
}

/**
 * Base image plus absolutely positioned boxes.
 * Everything is percent-based, so zooming or reflowing cannot desync the boxes.
 */
export function overlay(base, fractions, { label = '', extra = null, highlight = null } = {}) {
  const image = imageWithFallback(base.url, label);
  const layer = h('div', { class: 'bbox-layer' });
  const wrap = h('div', { class: 'page-wrap' }, image, layer);

  if (fractions) layer.append(box(fractions, label, 'pick'));

  if (Array.isArray(extra)) {
    for (const detection of extra) {
      if (highlight && detection.detection_id && label.includes(detection.detection_id)) continue;
      layer.append(box(detection.fractions, detection.detection_id, 'faint'));
    }
  }

  const zoom = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
  const apply = () => {
    wrap.style.setProperty('--zoom', String(zoom.scale));
    wrap.firstChild.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    layer.style.transform = wrap.firstChild.style.transform;
  };
  wrap.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && zoom.scale === 1) return; // let the page scroll
    event.preventDefault();
    const next = Math.min(8, Math.max(0.5, zoom.scale * (event.deltaY < 0 ? 1.15 : 0.87)));
    zoom.scale = next;
    apply();
  }, { passive: false });
  wrap.addEventListener('pointerdown', (event) => {
    if (zoom.scale === 1) return;
    zoom.dragging = true;
    zoom.lastX = event.clientX;
    zoom.lastY = event.clientY;
    wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener('pointermove', (event) => {
    if (!zoom.dragging) return;
    zoom.x += event.clientX - zoom.lastX;
    zoom.y += event.clientY - zoom.lastY;
    zoom.lastX = event.clientX;
    zoom.lastY = event.clientY;
    apply();
  });
  wrap.addEventListener('pointerup', () => { zoom.dragging = false; });
  wrap.addEventListener('dblclick', () => {
    zoom.scale = 1; zoom.x = 0; zoom.y = 0;
    apply();
  });

  return h('div', { class: 'overlay-block' },
    wrap,
    h('div', { class: 'row small muted' },
      h('span', { text: `${base.kind === 'page' ? '页面图' : 'Scheme 图'} ${base.dpi ? `${base.dpi} dpi` : ''} · ${base.width_px}×${base.height_px} px` }),
      h('span', { class: 'muted', text: '滚轮缩放（或 Ctrl+滚轮）· 拖拽平移 · 双击复位' })));
}

function box(fractions, label, kind) {
  if (!fractions) return null;
  const node = h('div', {
    class: `bbox ${kind}`,
    style: {
      left: `${fractions.left * 100}%`,
      top: `${fractions.top * 100}%`,
      width: `${fractions.width * 100}%`,
      height: `${fractions.height * 100}%`,
    },
  });
  if (label && kind !== 'faint') node.append(h('span', { class: 'bbox-label', text: label }));
  return node;
}

/** Highlight the mentions an alignment claims, inside the paper text. */
export function highlightedPassage(text, mentions = {}) {
  const spans = [];
  const push = (list, kind) => (list || []).forEach((term) => {
    if (term && String(term).trim()) spans.push({ term: String(term).trim(), kind });
  });
  push(mentions.reactants, 'react');
  push(mentions.products, 'prod');
  push(mentions.conditions, 'cond');

  if (!spans.length) return h('div', { class: 'passage' }, text || '');

  const escaped = spans
    .sort((a, b) => b.term.length - a.term.length)
    .map((span) => ({ ...span, pattern: span.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }));
  const regex = new RegExp(`(${escaped.map((s) => s.pattern).join('|')})`, 'g');

  const node = h('div', { class: 'passage' });
  let index = 0;
  for (const match of String(text || '').matchAll(regex)) {
    if (match.index > index) node.append(String(text).slice(index, match.index));
    const found = escaped.find((s) => s.term === match[0]);
    node.append(h('mark', { class: found ? found.kind : '' }, match[0]));
    index = match.index + match[0].length;
  }
  node.append(String(text || '').slice(index));
  return node;
}

/** All evidence ids attached to an entity, as clickable chips. */
export function evidenceChips(ids = []) {
  if (!ids.length) return h('span', { class: 'small muted', text: '无关联证据' });
  return h('div', { class: 'row' }, ...ids.map((id) => evidenceChip(id)));
}

export function evidenceById(id) {
  return store.evidence.find((e) => e.id === id) || null;
}
