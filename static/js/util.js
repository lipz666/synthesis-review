// Shared helpers: DOM construction, API access, chips, molecule depiction, toasts.
// No framework, no build step, no external requests.

export const state = {
  theme: localStorage.getItem('review-theme') || 'light',
  reviewer: localStorage.getItem('review-reviewer') || '',
  rdkit: true,
};

/* ------------------------------------------------------------------ DOM */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(6)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function svgIcon(path, size = 16) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.innerHTML = path;
  return el;
}

export const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 16 4-5 3 3.5 2-2.5 3 4"/>',
  arrow: '<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>',
  check: '<path d="m5 13 4 4 10-10"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
  pencil: '<path d="M4 20h4l10-10-4-4L4 16z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  external: '<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};

/* ------------------------------------------------------------------ API */

export async function api(path, options = {}) {
  // options first: spreading it last would overwrite the merged headers with
  // options.headers and drop the Content-Type, which turns a POST body into
  // text/plain and makes the API reject it.
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let body = null;
    try {
      body = await response.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || body);
    } catch (_) { /* keep the status */ }
    const error = new Error(detail);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return response.json();
}

/* ------------------------------------------------------------ molecules */

export function molURL(smiles, width = 300, height = 200, stereo = true) {
  const params = new URLSearchParams({
    smiles, w: String(width), h: String(height), theme: state.theme, stereo: stereo ? '1' : '0',
  });
  return `/api/v1/render.svg?${params}`;
}

/**
 * Structure depiction with the three-step fallback the review workflow needs:
 * RDKit drawing -> the OCSR crop the model actually read -> raw SMILES text.
 * A compound whose SMILES will not parse is exactly the case a reviewer must
 * see, so this must never throw or render blank.
 */
export function structure(view, { width = 260, height = 180, crop = true } = {}) {
  const smiles = view && (view.smiles?.isomeric || view.smiles?.canonical || view.smiles?.raw);
  if (smiles && state.rdkit) {
    const img = h('img', {
      class: 'mol-img', src: molURL(smiles, width, height), alt: view.label || smiles,
      loading: 'lazy', dataset: { smiles, w: String(width), hh: String(height) },
    });
    return h('div', { class: 'mol-frame' }, img);
  }
  const cropUrl = crop && view && view.cropUrl;
  if (cropUrl) {
    return h('div', { class: 'mol-frame' },
      imageWithFallback(cropUrl, view.label || ''),
      h('div', { class: 'mol-frame-note', text: state.rdkit ? '无法渲染，显示原图裁剪' : 'RDKit 不可用，显示原图裁剪' }));
  }
  return h('div', { class: 'mol-frame empty' },
    h('div', { class: 'fail' },
      h('div', { class: 'fail-mark', text: '✕' }),
      h('div', { text: smiles ? 'SMILES 无法解析' : '没有结构' }),
      smiles ? h('div', { class: 'smiles', text: smiles }) : null));
}

export function refreshMolecules() {
  $$('.mol-img').forEach((img) => {
    const { smiles, w, hh } = img.dataset;
    if (smiles) img.src = molURL(smiles, Number(w) || 300, Number(hh) || 200);
  });
}

export function imageWithFallback(url, alt = '', className = '') {
  const img = h('img', { src: url, alt, loading: 'lazy', class: className });
  img.addEventListener('error', () => {
    const placeholder = h('div', { class: 'img-missing' },
      h('div', { text: '图片缺失' }),
      h('div', { class: 'small mono', text: url.split('/').slice(-2).join('/') }));
    img.replaceWith(placeholder);
  });
  return img;
}

/* ------------------------------------------------------------ primitives */

export function chip(text, kind = '', attrs = {}) {
  return h('span', { class: `chip ${kind ? `chip-${kind}` : ''}`.trim(), ...attrs }, text);
}

export function metric(label, value, { note = null, kind = '' } = {}) {
  return h('div', { class: `metric ${kind}`.trim() },
    h('div', { class: 'metric-label', text: label }),
    h('div', { class: 'metric-value' }, value),
    note ? h('div', { class: 'metric-note', text: note }) : null);
}

export function callout(text, kind = 'info') {
  return h('div', { class: `callout ${kind}` }, text);
}

export function smilesBlock(label, value, { copy = true } = {}) {
  if (!value) return null;
  return h('div', { class: 'smiles-row' },
    label ? h('div', { class: 'small muted', text: label }) : null,
    h('div', { class: 'row nowrap' },
      h('div', { class: 'smiles', text: value }),
      copy ? h('button', {
        class: 'btn btn-ghost btn-sm', title: '复制',
        onclick: () => copyText(value),
      }, svgIcon(ICONS.copy, 13)) : null));
}

export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制');
  } catch (_) {
    toast('复制失败，请手动选择', 'bad');
  }
}

export function confidenceChip(value) {
  if (value === null || value === undefined) return chip('置信未知');
  const pct = value <= 1 ? value : value / 100;
  const kind = pct >= 0.85 ? 'ok' : pct >= 0.6 ? 'warn' : 'bad';
  return chip(`置信 ${pct.toFixed(2)}`, kind);
}

export function statusChip(status) {
  const map = {
    ok: ['ok', '结构已校验'], validated: ['ok', '结构已校验'],
    warn: ['warn', '解析有警告'], parsed_with_warnings: ['warn', '解析有警告'],
    unresolved: ['bad', '未解析'],
    passed: ['ok', '校验通过'], warning: ['warn', '校验告警'], not_run: ['', '未校验'],
    pending: ['warn', '待审'], accepted: ['ok', '已接受'], rejected: ['bad', '已拒绝'],
    corrected: ['info', '已更正'], deferred: ['', '已延后'],
  };
  const [kind, label] = map[status] || ['', String(status ?? '未知')];
  return chip(label, kind);
}

export function fmt(value, fallback = '未给出') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

export function pct(value) {
  if (value === null || value === undefined) return '—';
  return `${(value <= 1 ? value * 100 : value).toFixed(0)}%`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return new Date(iso).toLocaleString();
}

/* ---------------------------------------------------------------- toast */

export function toast(message, kind = 'ok', timeout = 2600) {
  const host = $('#toast-host');
  if (!host) return;
  const node = h('div', { class: `toast toast-${kind}`, text: message });
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, timeout);
}

/* --------------------------------------------------------------- drawer */

let drawerCloser = null;

export function openDrawer(title, content, { wide = false } = {}) {
  const host = $('#drawer-host');
  const body = $('#drawer-body');
  const drawer = $('#drawer');
  drawer.classList.toggle('wide', wide);
  clear(body);
  body.append(h('div', { class: 'drawer-title', text: title }), content);
  host.hidden = false;
  document.body.style.overflow = 'hidden';
  drawerCloser = () => closeDrawer();
}

export function closeDrawer() {
  const host = $('#drawer-host');
  if (!host || host.hidden) return;
  host.hidden = true;
  document.body.style.overflow = '';
  drawerCloser = null;
}

export function drawerOpen() {
  return drawerCloser !== null;
}

/* -------------------------------------------------------------- markdown */

/** Small hand-written renderer: headings, lists, tables, code, emphasis. */
export function markdown(source) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (text) => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  const lines = String(source || '').split(/\r?\n/);
  let list = null;
  let code = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      out.push(code ? '</code></pre>' : '<pre class="code"><code>');
      code = !code;
      continue;
    }
    if (code) { out.push(escape(line) + '\n'); continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (item || ordered) {
      const tag = item ? 'ul' : 'ol';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((item || ordered)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (heading) { out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`); continue; }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1);
      if (cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) continue;
      out.push(`<tr>${cells.map((cell) => `<td>${inline(cell.trim())}</td>`).join('')}</tr>`);
      continue;
    }
    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  let html = out.join('\n');
  html = html.replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g, (match) => `<table class="table md-table"><tbody>${match}</tbody></table>`);
  return html;
}

/* --------------------------------------------------------------- layout */

export function pageHead(title, subtitle, actions = null) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'spread' },
      h('div', {},
        h('h1', { class: 'page-title' }, title),
        subtitle ? h('p', { class: 'page-sub' }, subtitle) : null),
      actions));
}

export function card(...children) {
  return h('div', { class: 'card' }, ...children);
}

export function sectionTitle(text, right = null) {
  return h('div', { class: 'spread section-head' },
    h('h3', { class: 'section-title', text }), right);
}

export function empty(message) {
  return h('div', { class: 'empty-state', text: message });
}

export function link(href, ...children) {
  return h('a', { class: 'ilink', href }, ...children);
}
