// Layered DAG for the synthetic route.
//
// The route is convergent -- two branches merge at the ester -- so a CSS tree
// cannot draw it. Nodes are real DOM cards (clickable, status-coloured) laid
// out in longest-path layers; edges are drawn on an SVG layer after the cards
// have their final geometry. Structure images load asynchronously, so the edge
// pass reruns on every image load and on resize, otherwise lines point at the
// place a card used to be.

import { h, structure, chip, imageWithFallback } from './util.js';
import { store, compound, reaction } from './store.js';

export function routeMap(graph, { onSelect = null } = {}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map();
  const outgoing = new Map();
  for (const node of graph.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    outgoing.get(edge.source).push(edge.target);
    incoming.get(edge.target).push(edge.source);
  }

  const layer = longestPathLayers(graph.nodes.map((n) => n.id), incoming, outgoing);
  const rows = new Map();
  for (const [id, depth] of layer) {
    if (!rows.has(depth)) rows.set(depth, []);
    rows.get(depth).push(id);
  }

  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgeLayer.setAttribute('class', 'dag-edges');
  const canvas = h('div', { class: 'dag' }, edgeLayer);
  const elements = new Map();

  for (const depth of [...rows.keys()].sort((a, b) => a - b)) {
    const row = h('div', { class: 'dag-row' });
    for (const id of rows.get(depth)) {
      const node = nodes.get(id);
      const element = nodeCard(node, onSelect);
      elements.set(id, element);
      row.append(element);
    }
    canvas.append(row);
  }

  const draw = () => drawEdges(edgeLayer, canvas, elements, graph.edges);
  requestAnimationFrame(draw);
  canvas.querySelectorAll('img').forEach((img) => img.addEventListener('load', draw));
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    canvas.__observer = observer;
  }
  window.addEventListener('resize', draw);

  return h('div', { class: 'dag-scroll' }, canvas);
}

function longestPathLayers(ids, incoming, outgoing) {
  const depth = new Map(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, incoming.get(id).length]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) <= 0 && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  // A cycle would leave nodes unvisited; park them on a final row rather than
  // dropping them silently.
  const maxDepth = Math.max(0, ...depth.values());
  for (const id of ids) if (!seen.has(id)) depth.set(id, maxDepth + 1);
  return depth;
}

function nodeCard(node, onSelect) {
  if (node.type === 'reaction') {
    const view = reaction(node.id);
    const yieldValue = view?.yield?.value;
    return h('div', {
      class: `dag-node reaction ${view?.status === 'warning' ? 'warn' : ''}`.trim(),
      dataset: { id: node.id },
      onclick: () => (onSelect ? onSelect(node) : (window.location.hash = `#/reaction/${node.id}`)),
      title: view?.conditionsRaw || node.label,
    },
      h('div', { class: 'dag-rxn-label', text: node.label || node.id }),
      h('div', { class: 'dag-cond', text: firstLine(view?.conditionsRaw) || '条件未记录' }),
      h('div', { class: 'row' },
        yieldValue != null ? chip(`${yieldValue}%`, 'ok') : chip('无产率'),
        view?.status === 'warning' ? chip('校验告警', 'warn') : null));
  }

  const view = compound(node.id);
  const status = node.status === 'unresolved' ? 'unresolved' : view?.status;
  return h('div', {
    class: `dag-node compound ${status === 'unresolved' ? 'bad' : status === 'warn' ? 'warn' : ''}`.trim(),
    dataset: { id: node.id },
    onclick: () => (onSelect ? onSelect(node) : (window.location.hash = `#/compound/${node.id}`)),
  },
    h('div', { class: 'dag-head' },
      h('strong', { text: node.label || node.id }),
      node.isTarget ? chip('目标', 'accent') : null),
    view
      ? (view.cropUrl && status === 'unresolved'
        ? h('div', { class: 'mol-frame' }, imageWithFallback(view.cropUrl, view.label))
        : structure(view, { width: 150, height: 110 }))
      : h('div', { class: 'mol-frame empty' }, '—'),
    h('div', { class: 'dag-uid mono', text: node.id }));
}

function firstLine(text) {
  if (!text) return '';
  const line = String(text).split(/\r?\n/).filter(Boolean)[0] || '';
  return line.length > 42 ? `${line.slice(0, 41)}…` : line;
}

function drawEdges(svg, canvas, elements, edges) {
  const bounds = canvas.getBoundingClientRect();
  svg.setAttribute('width', String(canvas.scrollWidth));
  svg.setAttribute('height', String(canvas.scrollHeight));
  svg.setAttribute('viewBox', `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);
  svg.replaceChildren(marker());

  for (const edge of edges) {
    const from = elements.get(edge.source);
    const to = elements.get(edge.target);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.left - bounds.left + a.width / 2;
    const y1 = a.top - bounds.top + a.height;
    const x2 = b.left - bounds.left + b.width / 2;
    const y2 = b.top - bounds.top;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mid = (y1 + y2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2 - 6}`);
    path.setAttribute('class', 'dag-edge');
    path.setAttribute('marker-end', 'url(#dag-arrow)');
    svg.append(path);
  }
}

function marker() {
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'dag-arrow');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M0,0 L0,6 L6,3 z');
  path.setAttribute('class', 'dag-arrow-head');
  marker.append(path);
  defs.append(marker);
  return defs;
}

export function routeFallback() {
  const url = store.raw?.assets?.route_svg;
  if (!url) return null;
  return h('div', { class: 'route-fallback' },
    h('div', { class: 'small muted', text: '离线路线图 report/route.svg' }),
    h('div', { class: 'route-svg-box' }, imageWithFallback(url, 'route.svg', 'full-img')));
}
