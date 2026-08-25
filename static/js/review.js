// The decision bar. One component, used by the queue workbench and by every
// entity page (there as an ad-hoc review item), so a decision always produces
// the same event shape.

import { h, chip, toast, molURL, state, svgIcon, ICONS, timeAgo } from './util.js';
import { submitDecision, decisionFor, eventsFor } from './store.js';

const DECISIONS = [
  { key: 'accepted', label: '接受', hint: 'a', css: 'accept', icon: ICONS.check },
  { key: 'rejected', label: '拒绝', hint: 'x', css: 'reject', icon: ICONS.cross },
  { key: 'corrected', label: '更正', hint: 'c', css: 'correct', icon: ICONS.pencil },
  { key: 'deferred', label: '延后', hint: 'd', css: 'defer', icon: ICONS.clock },
];

/**
 * @param {string} itemUid           queue uid or ADHOC:<kind>:<uid>
 * @param {object} options
 *   labels        {accepted, rejected, corrected, deferred} button overrides
 *   correction    {type:'smiles'|'text'|'passage', value, options:[], placeholder}
 *   onSubmitted   callback after a successful write
 */
export function reviewBar(itemUid, options = {}) {
  const current = decisionFor(itemUid);
  const history = eventsFor(itemUid);
  const local = { decision: null, corrected: null, comment: '' };

  const preview = h('div', { class: 'correction-preview' });
  const editorHost = h('div', { class: 'correction', hidden: true });
  const commentInput = h('input', {
    class: 'input', placeholder: '备注（可选）',
    oninput: (event) => { local.comment = event.target.value; },
  });
  const submitButton = h('button', {
    class: 'btn', disabled: true,
    onclick: () => send(),
  }, '提交');

  const buttons = DECISIONS.map((decision) => h('button', {
    class: `dbtn ${decision.css}`,
    dataset: { decision: decision.key },
    onclick: () => choose(decision.key),
  }, svgIcon(decision.icon, 15), options.labels?.[decision.key] || decision.label,
    h('span', { class: 'kbd', text: decision.hint })));

  function choose(key) {
    local.decision = key;
    buttons.forEach((button) => button.classList.toggle('on', button.dataset.decision === key));
    const needsEditor = key === 'corrected' && options.correction;
    editorHost.hidden = !needsEditor;
    if (needsEditor && !editorHost.dataset.built) {
      editorHost.append(buildEditor(options.correction, local, preview, validate));
      editorHost.dataset.built = '1';
    }
    validate();
  }

  function validate() {
    const ok = Boolean(local.decision)
      && (local.decision !== 'corrected' || !options.correction || local.corrected !== null);
    submitButton.disabled = !ok;
    return ok;
  }

  async function send() {
    if (!validate()) return;
    submitButton.disabled = true;
    try {
      const result = await submitDecision({
        itemUid,
        decision: local.decision,
        correctedValue: local.decision === 'corrected' ? local.corrected : null,
        comment: local.comment || null,
      });
      toast(result.duplicate ? '该决定已记录过' : '已记录审核事件');
      if (options.onSubmitted) options.onSubmitted(result);
    } catch (error) {
      if (error.status === 409) {
        toast('数据集已重新抽取，请刷新后重审', 'bad', 6000);
      } else {
        toast(`提交失败：${error.message}`, 'bad', 6000);
      }
      submitButton.disabled = false;
    }
  }

  const node = h('div', { class: 'review-bar', dataset: { item: itemUid } },
    current ? h('div', { class: 'review-current' },
      chip(decisionLabel(current.decision), decisionKind(current.decision)),
      h('span', { class: 'small muted', text: `${current.reviewer_id} · ${timeAgo(current.reviewed_at)}${history.length > 1 ? ` · 共 ${history.length} 次` : ''}` }),
    ) : null,
    h('div', { class: 'decisions' }, ...buttons),
    editorHost,
    preview,
    h('div', { class: 'spread' },
      commentInput,
      submitButton),
    h('div', { class: 'small muted', text: `${itemUid} · 审核人 ${state.reviewer || '未署名'}（事件只追加，不覆盖抽取结果）` }));

  node.chooseDecision = choose;
  node.submit = send;
  return node;
}

function buildEditor(spec, local, preview, validate) {
  if (spec.type === 'smiles') {
    const input = h('input', {
      class: 'input mono', value: spec.value || '', placeholder: spec.placeholder || '更正后的 SMILES',
    });
    const status = h('div', { class: 'small' });
    const allowUnparsable = h('label', { class: 'checkline' },
      h('input', { type: 'checkbox', onchange: () => check() }),
      h('span', { text: '确实无法用 SMILES 表达' }));

    let timer = null;
    function check() {
      const value = input.value.trim();
      const override = allowUnparsable.querySelector('input').checked;
      preview.replaceChildren();
      if (!value) {
        local.corrected = override ? { smiles: null, unrepresentable: true } : null;
        status.textContent = override ? '将记录为「无法用 SMILES 表达」' : '';
        status.className = 'small muted';
        validate();
        return;
      }
      if (!state.rdkit) {
        local.corrected = { smiles: value, verified: false };
        status.textContent = 'RDKit 不可用，无法预校验；仍会记录你填的串';
        status.className = 'small warn-text';
        validate();
        return;
      }
      // The server-rendered depiction doubles as the parse check: a placeholder
      // comes back for anything RDKit refuses.
      const image = new Image();
      image.className = 'mol-preview';
      image.src = molURL(value, 260, 170);
      fetch(`/api/v1/molecule?smiles=${encodeURIComponent(value)}`)
        .then((response) => response.json())
        .then((props) => {
          if (props.valid) {
            status.textContent = `可解析 · ${props.formula} · ${props.mw} · 立体中心 ${props.stereocenters}`;
            status.className = 'small ok-text';
            local.corrected = { smiles: value, canonical: props.canonical, inchi_key: props.inchi_key };
            preview.replaceChildren(image);
          } else {
            status.textContent = 'RDKit 无法解析这个 SMILES';
            status.className = 'small bad-text';
            local.corrected = override ? { smiles: value, unparsable: true } : null;
          }
          validate();
        })
        .catch(() => {
          status.textContent = '校验请求失败';
          status.className = 'small bad-text';
          local.corrected = null;
          validate();
        });
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(check, 260);
    });
    if (spec.value) check();
    return h('div', { class: 'stack' },
      h('div', { class: 'eyebrow', text: '更正值 · SMILES（实时解析校验）' }),
      input, status, allowUnparsable);
  }

  if (spec.type === 'passage') {
    const list = h('div', { class: 'passage-options' });
    (spec.options || []).forEach((option) => {
      const button = h('button', {
        class: 'passage-option',
        onclick: () => {
          list.querySelectorAll('.passage-option').forEach((node) => node.classList.remove('on'));
          button.classList.add('on');
          local.corrected = {
            passage_id: option.passageId, page: option.page,
            char_start: option.charStart, char_end: option.charEnd, text: option.text,
          };
          validate();
        },
      },
        h('div', { class: 'row' },
          chip(`p${option.page}`),
          chip(`检索分 ${option.retrievalScore ?? '—'}`),
          ...(option.matchedLabels || []).map((l) => chip(l, 'accent'))),
        h('div', { class: 'small', text: option.text }));
      list.append(button);
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'eyebrow', text: '改选原文段落' }),
      list.children.length ? list : h('div', { class: 'small muted', text: '没有候选段落' }));
  }

  if (spec.type === 'fields') {
    const values = {};
    const inputs = (spec.fields || []).map((field) => {
      const input = h('input', {
        class: 'input', value: field.value ?? '', placeholder: field.placeholder || '',
        oninput: (event) => {
          values[field.key] = event.target.value;
          local.corrected = Object.fromEntries(
            Object.entries(values).filter(([, value]) => value !== '' && value !== undefined));
          if (!Object.keys(local.corrected).length) local.corrected = null;
          validate();
        },
      });
      return h('label', { class: 'field' }, h('span', { text: field.label }), input);
    });
    return h('div', { class: 'stack' },
      h('div', { class: 'eyebrow', text: '更正值' }),
      h('div', { class: 'field-grid' }, ...inputs));
  }

  const area = h('textarea', {
    class: 'input', rows: 3, placeholder: spec.placeholder || '更正说明',
    oninput: (event) => {
      local.corrected = event.target.value ? { text: event.target.value } : null;
      validate();
    },
  });
  return h('div', { class: 'stack' }, h('div', { class: 'eyebrow', text: '更正值' }), area);
}

export function decisionLabel(decision) {
  return { accepted: '已接受', rejected: '已拒绝', corrected: '已更正', deferred: '已延后' }[decision] || decision;
}

export function decisionKind(decision) {
  return { accepted: 'ok', rejected: 'bad', corrected: 'info', deferred: '' }[decision] ?? '';
}

export function decisionBadge(itemUid) {
  const current = decisionFor(itemUid);
  if (!current) return null;
  return chip(decisionLabel(current.decision), decisionKind(current.decision));
}
