// Submit new extraction output for review: drop a .zip, or paste dataset JSON.
//
// Every submission is validated first (dry run) and the report is shown before
// anything is installed, so a broken package is caught here rather than by a
// reviewer halfway through a queue.

import {
  h, card, chip, pageHead, sectionTitle, empty, callout, toast, state, api,
} from '../util.js';
import { loadCatalog, loadDataset, store } from '../store.js';

const ui = {
  file: null,
  apiKey: localStorage.getItem('review-ingest-key') || '',
  lastReport: null,
  busy: false,
};

export async function renderSubmit(main) {
  const spec = await api('/api/v1/ingest/spec').catch(() => null);

  main.append(pageHead('提交数据',
    '把一次抽取的结果打包上传，通过校验后立即出现在数据集列表里。相同内容重复提交不会产生副本。'));

  if (spec && !spec.enabled) {
    main.append(callout('这个部署关闭了提交接口（REVIEW_INGEST_ENABLED=0）。', 'bad'));
    return;
  }

  const reportHost = h('div', {});

  main.append(
    uploadCard(reportHost),
    jsonCard(reportHost),
    reportHost,
    specCard(spec));
}

/* ---------------------------------------------------------------- upload */

function uploadCard(reportHost) {
  const status = h('div', { class: 'small muted', text: '未选择文件' });
  const input = h('input', {
    type: 'file', accept: '.zip,application/zip', class: 'input',
    onchange: (event) => pick(event.target.files[0]),
  });

  const drop = h('div', { class: 'dropzone' },
    h('div', { class: 'dropzone-title', text: '把 .zip 数据包拖到这里' }),
    h('div', { class: 'small muted', text: '或者用下面的文件选择框' }),
    status);

  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    pick(event.dataTransfer.files[0]);
  });

  function pick(file) {
    if (!file) return;
    ui.file = file;
    status.textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
    status.className = 'small';
  }

  const datasetId = h('input', { class: 'input', placeholder: '留空则用包内 manifest 或压缩包根目录名' });
  const force = h('input', { type: 'checkbox' });

  const validateButton = h('button', {
    class: 'btn btn-ghost',
    onclick: () => send({ dryRun: true }),
  }, '先校验（不写入）');
  const submitButton = h('button', {
    class: 'btn',
    onclick: () => send({ dryRun: false }),
  }, '校验并导入');

  async function send({ dryRun }) {
    if (!ui.file) return void toast('先选一个 .zip 数据包', 'warn');
    if (ui.busy) return;
    ui.busy = true;
    submitButton.disabled = validateButton.disabled = true;
    reportHost.replaceChildren(card(h('div', { class: 'small muted', text: dryRun ? '校验中…' : '上传并导入中…' })));
    const params = new URLSearchParams();
    if (datasetId.value.trim()) params.set('dataset_id', datasetId.value.trim());
    if (force.checked) params.set('force', 'true');
    if (dryRun) params.set('dry_run', 'true');
    try {
      const response = await fetch(`/api/v1/ingest?${params}`, {
        method: 'POST',
        headers: headers('application/zip'),
        body: ui.file,
      });
      await handle(response, reportHost, dryRun);
    } catch (error) {
      reportHost.replaceChildren(card(callout(`上传失败：${error.message}`, 'bad')));
    } finally {
      ui.busy = false;
      submitButton.disabled = validateButton.disabled = false;
    }
  }

  return card(
    sectionTitle('方式一：上传数据包（推荐）',
      h('span', { class: 'small muted', text: '包含结构图、页面图和 Scheme 裁剪' })),
    drop,
    h('div', { class: 'field-grid', style: { marginTop: '12px' } },
      h('label', { class: 'field' }, h('span', { text: 'zip 文件' }), input),
      h('label', { class: 'field' }, h('span', { text: 'dataset_id（可选）' }), datasetId)),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      validateButton, submitButton,
      h('label', { class: 'checkline' }, force, h('span', { text: '覆盖同一 revision（force）' }))),
    apiKeyRow());
}

/* ------------------------------------------------------------------ json */

function jsonCard(reportHost) {
  const area = h('textarea', {
    class: 'input mono', rows: 8,
    placeholder: '{\n  "dataset_id": "MY_PAPER",\n  "dataset": { "schema_version": "tse.dataset.v1", ... }\n}',
  });
  const run = async (dryRun) => {
    let payload;
    try {
      payload = JSON.parse(area.value);
    } catch (error) {
      return void toast(`JSON 解析失败：${error.message}`, 'bad', 5000);
    }
    reportHost.replaceChildren(card(h('div', { class: 'small muted', text: '提交中…' })));
    try {
      const response = await fetch(`/api/v1/ingest/json${dryRun ? '?dry_run=true' : ''}`, {
        method: 'POST',
        headers: headers('application/json'),
        body: JSON.stringify(payload),
      });
      await handle(response, reportHost, dryRun);
    } catch (error) {
      reportHost.replaceChildren(card(callout(`提交失败：${error.message}`, 'bad')));
    }
  };

  return card(
    sectionTitle('方式二：直接提交 JSON',
      h('span', { class: 'small muted', text: '没有图片，结构只能按 SMILES 渲染' })),
    area,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn btn-ghost', onclick: () => run(true) }, '先校验'),
      h('button', { class: 'btn', onclick: () => run(false) }, '提交')));
}

/* ---------------------------------------------------------------- shared */

function headers(contentType) {
  const out = { 'Content-Type': contentType };
  if (ui.apiKey) out['X-Api-Key'] = ui.apiKey;
  if (state.reviewer) out['X-Submitted-By'] = state.reviewer;
  return out;
}

function apiKeyRow() {
  const input = h('input', {
    class: 'input input-sm', type: 'password', value: ui.apiKey,
    placeholder: '仅当服务端配置了 REVIEW_INGEST_TOKEN 时需要',
    onchange: (event) => {
      ui.apiKey = event.target.value.trim();
      localStorage.setItem('review-ingest-key', ui.apiKey);
    },
  });
  return h('label', { class: 'field', style: { marginTop: '12px' } },
    h('span', { text: 'X-Api-Key（可选）' }), input);
}

async function handle(response, host, dryRun) {
  let body;
  try {
    body = await response.json();
  } catch (_) {
    host.replaceChildren(card(callout(`服务端返回了非 JSON 响应（HTTP ${response.status}）`, 'bad')));
    return;
  }
  // Errors arrive as {detail: {message, errors, ...}}; successes are the report.
  const report = response.ok ? body : { ...(body.detail || {}), ok: false, http: response.status };
  ui.lastReport = report;
  host.replaceChildren(reportCard(report, dryRun, response.ok));

  if (response.ok && report.installed) {
    toast(`已导入 ${report.dataset_id} · rev ${String(report.revision).slice(0, 8)}`);
    await loadCatalog();
  }
}

function reportCard(report, dryRun, ok) {
  const errors = report.errors || [];
  const warnings = report.warnings || [];
  const counts = report.counts || {};
  const verification = report.source_verification || {};

  const headline = !ok
    ? callout(`提交被拒绝：${report.message || '校验未通过'}`, 'bad')
    : report.installed
      ? callout(`已导入 ${report.dataset_id} · revision ${report.revision}`, 'info')
      : dryRun
        ? callout('校验通过，未写入任何内容。确认无误后点「校验并导入」。', 'info')
        : callout(report.message || '这个 revision 已经存在，未重复导入。', 'warn');

  const nodes = [sectionTitle('提交报告'), headline];

  if (Object.keys(counts).length) {
    nodes.push(h('div', { class: 'metrics' },
      ...Object.entries(counts).map(([key, value]) => h('div', { class: 'metric' },
        h('div', { class: 'metric-label', text: key }),
        h('div', { class: 'metric-value', text: String(value) })))));
  }

  if (verification.checked) {
    const failed = verification.checked - verification.verified;
    nodes.push(h('div', { class: 'row' },
      h('span', { class: 'small muted', text: '原文回查' }),
      chip(`${verification.verified}/${verification.checked} 通过`, failed ? 'warn' : 'ok'),
      failed ? h('span', { class: 'small muted', text: `未通过：${(verification.unverified || []).join(', ')}` }) : null));
  }

  if (errors.length) {
    nodes.push(h('div', {},
      h('div', { class: 'eyebrow', text: `错误 ${errors.length}（必须修复）` }),
      h('ul', { class: 'issue-list bad' }, ...errors.map((text) => h('li', { text })))));
  }
  if (warnings.length) {
    nodes.push(h('div', {},
      h('div', { class: 'eyebrow', text: `警告 ${warnings.length}（不阻塞导入）` }),
      h('ul', { class: 'issue-list warn' }, ...warnings.map((text) => h('li', { text })))));
  }
  if ((report.missing_assets || []).length) {
    nodes.push(h('details', { class: 'foldout' },
      h('summary', { text: `缺失的图片 ${report.missing_assets.length}` }),
      h('ul', { class: 'issue-list' }, ...report.missing_assets.map((text) => h('li', { class: 'mono', text })))));
  }

  if (report.installed) {
    nodes.push(h('div', { class: 'row' },
      h('button', {
        class: 'btn',
        onclick: async () => {
          await loadDataset(report.dataset_id);
          window.location.hash = '#/';
        },
      }, '打开这个数据集'),
      h('span', { class: 'small muted', text: `${report.files} 个文件 · ${(report.bytes / 1e6).toFixed(1)} MB` })));
  }

  return card(...nodes);
}

/* ------------------------------------------------------------------ spec */

function specCard(spec) {
  if (!spec) return card(empty('无法读取提交格式说明'));
  const layout = spec.package_layout || {};
  const curl = [
    '# 1. 打包（在抽取流水线那边执行）',
    'python scripts/ingest_workspace.py <workspace> --pack pkg.zip',
    '',
    '# 2. 先校验',
    `curl -X POST "${location.origin}/api/v1/ingest?dataset_id=MY_PAPER&dry_run=true" \\`,
    '  -H "Content-Type: application/zip" \\',
    spec.protected ? '  -H "X-Api-Key: $REVIEW_INGEST_TOKEN" \\' : null,
    '  --data-binary @pkg.zip',
    '',
    '# 3. 导入',
    `curl -X POST "${location.origin}/api/v1/ingest?dataset_id=MY_PAPER" \\`,
    '  -H "Content-Type: application/zip" \\',
    spec.protected ? '  -H "X-Api-Key: $REVIEW_INGEST_TOKEN" \\' : null,
    '  --data-binary @pkg.zip',
  ].filter(Boolean).join('\n');

  return card(
    sectionTitle('提交格式',
      h('div', { class: 'row' },
        chip(spec.format, 'accent'),
        chip(spec.protected ? '需要 X-Api-Key' : '未设置访问令牌', spec.protected ? 'ok' : 'warn'))),
    h('div', { class: 'grid-2', style: { marginTop: 0 } },
      h('div', {},
        h('div', { class: 'eyebrow', text: '压缩包结构' }),
        h('pre', { class: 'code', text: [
          `${(layout.required || [])[0]}          ← 必需`,
          'data/review_queue.json         ← 建议',
          'data/alignment_candidates.json ← 可选',
          'pages/ schemes/ molecule_crops/ moldet/ report/   ← 图片资产',
          'manifest.json                  ← 可选（dataset_id / source）',
        ].join('\n') }),
        h('div', { class: 'small muted', text: layout.note || '' })),
      h('div', {},
        h('div', { class: 'eyebrow', text: '限制' }),
        h('table', { class: 'table' }, h('tbody', {},
          row('单次上传上限', `${((spec.limits?.max_upload_bytes || 0) / 1048576).toFixed(0)} MB`),
          row('解压上限', `${((spec.limits?.max_uncompressed_bytes || 0) / 1073741824).toFixed(1)} GB`),
          row('文件数上限', String(spec.limits?.max_entries ?? '—')),
          row('允许的后缀', (spec.limits?.allowed_suffixes || []).join(' ')),
          row('revision', 'sha256(dataset.json + review_queue.json) 前 16 位'))))),
    h('div', { class: 'eyebrow', style: { marginTop: '12px' }, text: '命令行提交' }),
    h('pre', { class: 'code', text: curl }),
    h('div', { class: 'small muted' },
      '完整字段要求见 docs/SUBMISSION_FORMAT_ZH.md，机器可读版本在 ',
      h('a', { class: 'ilink', href: '/api/v1/ingest/spec', target: '_blank' }, '/api/v1/ingest/spec')));
}

function row(label, value) {
  return h('tr', {}, h('td', { class: 'small muted' }, label), h('td', { class: 'small mono' }, value));
}
