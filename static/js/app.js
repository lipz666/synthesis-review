// Hash router, theme, reviewer identity, global hotkeys.

import { $, h, clear, state, refreshMolecules, toast, closeDrawer, drawerOpen, empty } from './util.js';
import { store, loadCatalog, loadDataset, loadHealth, datasetEntries, progress, onChange } from './store.js';
import { renderOverview } from './views/overview.js';
import { renderQueue } from './views/queue.js';
import { renderCompounds, renderCompound, renderReactions, renderReaction, renderAlignments, renderAlignment } from './views/entities.js';
import { renderRoute, renderQuality, renderHistory, renderUnsupported } from './views/misc.js';

const ROUTES = [
  { pattern: /^#?\/?$/, view: renderOverview, nav: 'overview' },
  { pattern: /^#\/queue(?:\/(.+))?$/, view: renderQueue, nav: 'queue', params: (m) => ({ itemUid: m[1] }) },
  { pattern: /^#\/route$/, view: renderRoute, nav: 'route' },
  { pattern: /^#\/compounds$/, view: renderCompounds, nav: 'compounds' },
  { pattern: /^#\/compound\/(.+)$/, view: renderCompound, nav: 'compounds', params: (m) => ({ uid: m[1] }) },
  { pattern: /^#\/reactions$/, view: renderReactions, nav: 'reactions' },
  { pattern: /^#\/reaction\/(.+)$/, view: renderReaction, nav: 'reactions', params: (m) => ({ uid: m[1] }) },
  { pattern: /^#\/alignments$/, view: renderAlignments, nav: 'alignments' },
  { pattern: /^#\/alignment\/(.+)$/, view: renderAlignment, nav: 'alignments', params: (m) => ({ uid: m[1] }) },
  { pattern: /^#\/quality$/, view: renderQuality, nav: 'quality' },
  { pattern: /^#\/history$/, view: renderHistory, nav: 'history' },
];

let currentMain = null;

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem('review-theme', state.theme);
}

async function route() {
  const main = $('#main');
  currentMain = main;
  clear(main);
  const hash = window.location.hash || '#/';

  if (store.unsupported) {
    renderUnsupported(main);
    return;
  }

  const match = ROUTES.map((entry) => ({ entry, m: hash.match(entry.pattern) })).find((x) => x.m);
  if (!match) {
    main.append(empty(`没有这个页面：${hash}`));
    return;
  }
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === match.entry.nav);
  });
  try {
    await match.entry.view(main, match.entry.params ? match.entry.params(match.m) : {});
  } catch (error) {
    console.error(error);
    main.append(empty(`页面渲染失败：${error.message}`));
  }
  window.scrollTo(0, 0);
}

function buildNav() {
  const counts = store.summary?.counts || {};
  const items = [
    ['overview', '#/', '概览', null, '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3a9 9 0 0 1 9 9"/>'],
    ['queue', '#/queue', '审核队列', store.reviewItems.length, '<path d="M4 6h16M4 12h16M4 18h10"/>'],
    ['route', '#/route', '路线', null, '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.6 7.8 11 15.7M16.4 7.8 13 15.7"/>'],
    ['compounds', '#/compounds', '化合物', counts.compounds ?? store.compounds.length, '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>'],
    ['reactions', '#/reactions', '反应', counts.reactions ?? store.reactions.length, '<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>'],
    ['alignments', '#/alignments', '原文对齐', counts.alignments ?? store.alignments.length, '<path d="M5 4h9l5 5v11H5z"/><path d="M8 13h8M8 17h5"/>'],
    ['quality', '#/quality', '质量', store.issues.length, '<path d="M12 4 3 19h18z"/><path d="M12 10v4M12 16.6v.6"/>'],
    ['history', '#/history', '历史', null, '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'],
  ];
  const nav = $('#nav');
  clear(nav);
  for (const [key, href, label, count, icon] of items) {
    nav.append(h('a', { class: 'nav-item', href, dataset: { nav: key } },
      h('span', { class: 'nav-icon', html: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>` }),
      h('span', { text: label }),
      count ? h('span', { class: 'nav-count', text: String(count) }) : null));
  }
}

function buildStatus(health) {
  const stats = progress();
  const card = $('#status-card');
  clear(card);
  card.append(
    h('div', { class: 'status-row' },
      h('span', { class: 'dot dot-ok' }),
      h('span', { text: `${store.datasetId} · rev ${String(store.raw?.revision || '').slice(0, 8)}` })),
    h('div', { class: 'status-row' },
      h('span', { class: `dot ${health.rdkit?.available ? 'dot-ok' : 'dot-bad'}` }),
      h('span', { text: health.rdkit?.available ? 'RDKit 可用' : 'RDKit 不可用（结构图降级）' })),
    h('div', { class: 'status-row' },
      h('span', { class: `dot ${health.events_writable ? 'dot-ok' : 'dot-bad'}` }),
      h('span', { text: health.events_writable ? `已记录 ${store.events.length} 条事件` : '事件不可写入' })),
    h('div', { class: 'status-row' },
      h('span', { class: 'dot' }),
      h('span', { text: `待办 ${stats.queueDecided}/${stats.queueTotal} · 覆盖 ${stats.coverageDecided}/${stats.coverageTotal}` })));
}

function buildDatasetPicker() {
  const entries = datasetEntries();
  const host = $('#dataset-picker');
  clear(host);
  if (entries.length <= 1) return;
  const select = h('select', {
    class: 'select',
    onchange: async (event) => {
      await loadDataset(event.target.value);
      buildNav();
      route();
    },
  }, ...entries.map((entry) => h('option', {
    value: entry.dataset_id,
    selected: entry.dataset_id === store.datasetId,
  }, entry.title || entry.dataset_id)));
  host.append(select);
}

function reviewerBox() {
  const input = $('#reviewer-input');
  input.value = state.reviewer;
  input.addEventListener('change', () => {
    state.reviewer = input.value.trim();
    localStorage.setItem('review-reviewer', state.reviewer);
    toast(state.reviewer ? `审核人：${state.reviewer}` : '已清除审核人');
  });
}

function hotkeys() {
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
      if (event.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (event.key === 'Escape' && drawerOpen()) { closeDrawer(); return; }
    if (event.key === '?') { showHelp(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (currentMain?.__hotkeys && currentMain.__hotkeys(event.key)) {
      event.preventDefault();
    }
  });
}

function showHelp() {
  toast('j/k 上下项 · a 接受 · x 拒绝 · c 更正 · d 延后 · Enter 提交 · Esc 关闭', 'ok', 6000);
}

async function boot() {
  applyTheme();
  reviewerBox();
  hotkeys();

  $('#theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    refreshMolecules();
  });
  document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', closeDrawer));

  const main = $('#main');
  try {
    const [health] = await Promise.all([loadHealth(), loadCatalog()]);
    const entries = datasetEntries();
    if (!entries.length) {
      clear(main);
      main.append(empty('catalog 里没有数据集。先运行 scripts/ingest_workspace.py 导入一次抽取结果。'));
      return;
    }
    const preferred = localStorage.getItem('review-dataset');
    await loadDataset(entries.find((e) => e.dataset_id === preferred)?.dataset_id || entries[0].dataset_id);
    buildNav();
    buildDatasetPicker();
    buildStatus(health);
    onChange(() => buildStatus(health));
    window.addEventListener('hashchange', route);
    await route();
  } catch (error) {
    console.error(error);
    clear(main);
    main.append(empty(`启动失败：${error.message}`));
  }
}

boot();
