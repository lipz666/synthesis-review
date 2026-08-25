// Adapter: tse.dataset.v1 -> ViewModels.
//
// This is the ONLY file allowed to know the raw field names. Views consume the
// ViewModel and nothing else, so a new extraction schema means a new adapter
// here, not a rewrite of every page.

const RELATION_LABELS = {
  direct_reaction_description: '直接描述该反应',
  experimental_summary: '实验总结',
  external_preparation: '外部制备',
  mechanism: '机理讨论',
  failed_attempt: '失败尝试',
  general_procedure: '通用操作',
};

const CONSISTENCY_LABELS = {
  consistent: '与 scheme 一致',
  partial: '部分一致',
  inconsistent: '与 scheme 冲突',
  not_stated: '原文未说明',
};

const ISSUE_LABELS = {
  ocsr_failed: 'OCSR 读取失败',
  atom_balance_warning: '原子守恒告警',
  external_boundary: '外部起始物边界',
  procedure_not_found: '缺少实验步骤',
};

const STATUS_MAP = {
  validated: 'ok',
  parsed_with_warnings: 'warn',
  unresolved: 'unresolved',
};

const kindOfUid = (uid, index) => {
  if (!uid) return null;
  if (index.compound.has(uid)) return 'compound';
  if (index.reaction.has(uid)) return 'reaction';
  if (index.alignment.has(uid)) return 'alignment';
  if (index.visual.has(uid)) return 'visual';
  return null;
};

function buildIndex(dataset) {
  const visual = new Map();
  for (const compound of dataset.compounds || []) {
    for (const candidate of compound.candidates || []) {
      if (candidate.visual_id) visual.set(candidate.visual_id, compound.compound_uid);
    }
    for (const mention of compound.mentions || []) {
      if (mention.visual_id) visual.set(mention.visual_id, compound.compound_uid);
    }
  }
  return {
    compound: new Set((dataset.compounds || []).map((c) => c.compound_uid)),
    reaction: new Set((dataset.reactions || []).map((r) => r.reaction_uid)),
    alignment: new Set((dataset.alignments || []).map((a) => a.alignment_uid)),
    visual,
  };
}

function quantity(node) {
  // `yield` and `temperature` are objects, not scalars: {value, raw_text, ...}.
  // The reviewer needs both -- "56%" and "56% yield over 2 steps" are not the
  // same claim, and a two-step yield read as a single step is a classic error.
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object') return { value: node, rawText: null, normalization: null };
  return {
    value: node.value ?? null,
    rawText: node.raw_text ?? null,
    normalization: node.normalization_status ?? null,
    confidence: node.confidence ?? null,
  };
}

function compoundView(compound, index, dataset, evidenceById) {
  const identity = compound.identity || {};
  const candidates = (compound.candidates || []).map((candidate) => ({
    visualId: candidate.visual_id,
    smiles: candidate.smiles,
    model: candidate.model,
    modelVersion: candidate.model_version,
    variant: candidate.crop_variant,
    confidence: candidate.confidence,
    parsable: candidate.rdkit_parsable,
    warnings: candidate.warnings || [],
    cropUrl: candidate.image_path || null,
    selectionScore: candidate.selection_score,
  }));
  const reactions = { asReactant: [], asProduct: [] };
  for (const reaction of dataset.reactions || []) {
    if ((reaction.reactants || []).includes(compound.compound_uid)) reactions.asReactant.push(reaction.reaction_uid);
    if ((reaction.products || []).includes(compound.compound_uid)) reactions.asProduct.push(reaction.reaction_uid);
  }
  // A compound whose OCSR failed has no candidates and no evidence_ids, but its
  // mentions still point at the crop and the page box. Falling back to those is
  // what keeps the worst case -- the structure nobody could read -- reviewable.
  const mentionEvidenceIds = (compound.mentions || []).map((m) => m.evidence_id).filter(Boolean);
  const evidenceIds = [...new Set([...(compound.evidence_ids || []), ...mentionEvidenceIds])];
  const cropFromCandidates = candidates.find((c) => c.cropUrl)?.cropUrl || null;
  const cropFromEvidence = evidenceIds
    .map((id) => evidenceById.get(id))
    .find((record) => record && record.evidence_type === 'molecule_image' && record.image_path)?.image_path || null;

  return {
    kind: 'compound',
    uid: compound.compound_uid,
    label: (compound.labels || [])[0] || (compound.names || [])[0] || compound.compound_uid,
    labels: compound.labels || [],
    names: compound.names || [],
    status: STATUS_MAP[compound.structure_status] || 'warn',
    statusRaw: compound.structure_status,
    confidence: compound.confidence,
    isTarget: Boolean(compound.is_target) || dataset.run?.target_compound_uid === compound.compound_uid,
    smiles: {
      raw: compound.raw_smiles,
      canonical: identity.canonical_smiles,
      isomeric: identity.isomeric_smiles,
    },
    identity: {
      formula: identity.formula,
      exactMass: identity.exact_mass,
      inchiKey: identity.inchi_key,
      heavyAtoms: identity.heavy_atom_count,
      stereocenters: identity.num_stereocenters,
      unspecifiedStereocenters: identity.num_unspecified_stereocenters,
    },
    cropUrl: cropFromCandidates || cropFromEvidence,
    candidates,
    mentions: (compound.mentions || []).map((m) => ({
      page: m.page, label: m.label, evidenceId: m.evidence_id, visualId: m.visual_id, documentId: m.document_id,
    })),
    evidenceIds,
    conflicts: compound.conflicts || [],
    provenance: compound.provenance || {},
    reactions,
    route: `#/compound/${compound.compound_uid}`,
  };
}

function reactionView(reaction, dataset) {
  const validations = (dataset.validations || []).filter((v) => v.target === reaction.reaction_uid);
  const alignments = (dataset.alignments || [])
    .filter((a) => a.reaction_uid === reaction.reaction_uid)
    .map((a) => a.alignment_uid);
  return {
    kind: 'reaction',
    uid: reaction.reaction_uid,
    label: reaction.visual_reaction_id || reaction.reaction_uid,
    stepIndex: reaction.step_index,
    schemeId: reaction.scheme_id,
    reactants: reaction.reactants || [],
    products: reaction.products || [],
    agents: reaction.agents || [],
    structuralReagents: reaction.structural_reagents || [],
    conditionsRaw: reaction.conditions_raw,
    temperature: quantity(reaction.temperature),
    time: quantity(reaction.time),
    yield: quantity(reaction.yield),
    yieldType: reaction.yield_type,
    reactionSmiles: reaction.reaction_smiles,
    status: reaction.validation_status,
    confidence: reaction.confidence,
    evidenceIds: reaction.evidence_ids || [],
    alignmentUids: alignments,
    validations: validations.map((v) => ({
      check: v.check, passed: v.passed, severity: v.severity, detail: v.detail, metrics: v.metrics || {},
    })),
    provenance: reaction.provenance || {},
    route: `#/reaction/${reaction.reaction_uid}`,
  };
}

function alignmentView(alignment, verifications) {
  const verification = (verifications || {})[alignment.alignment_uid] || {};
  return {
    kind: 'alignment',
    uid: alignment.alignment_uid,
    reactionUid: alignment.reaction_uid,
    evidenceId: alignment.evidence_id,
    passageId: alignment.passage_id,
    documentId: alignment.document_id,
    page: alignment.page,
    charStart: alignment.char_start,
    charEnd: alignment.char_end,
    text: alignment.text,
    relation: alignment.relation,
    relationLabel: RELATION_LABELS[alignment.relation] || alignment.relation,
    supportsRouteStep: alignment.supports_route_step,
    mentions: {
      reactants: alignment.reactant_mentions || [],
      products: alignment.product_mentions || [],
      conditions: alignment.condition_mentions || [],
      yield: alignment.yield_mentioned,
    },
    coreferences: alignment.coreferences || {},
    consistency: alignment.consistency,
    consistencyLabel: CONSISTENCY_LABELS[alignment.consistency] || alignment.consistency,
    scores: {
      retrieval: alignment.retrieval_score,
      semantic: alignment.semantic_confidence,
      combined: alignment.combined_confidence,
    },
    // The model's own claim, kept separate from the server's re-check.
    claimedVerified: Boolean(alignment.source_verified),
    verified: Boolean(verification.verified),
    verifyReason: verification.reason || null,
    reviewStatus: alignment.review_status,
    route: `#/alignment/${alignment.alignment_uid}`,
  };
}

function reviewItemView(item, index) {
  const entityUid = item.entity_uid;
  let kind = kindOfUid(entityUid, index);
  let resolvedUid = entityUid;
  if (kind === 'visual') {
    // The queue mixes entity kinds: CMP_*, RXN_*, the dataset id, and YOLO box
    // ids like M014. Resolve the box back to its compound so the UI has one
    // notion of "the thing being reviewed".
    resolvedUid = index.visual.get(entityUid);
    kind = 'compound';
  }
  const routes = {
    compound: `#/compound/${resolvedUid}`,
    reaction: `#/reaction/${resolvedUid}`,
    alignment: `#/alignment/${resolvedUid}`,
  };
  return {
    uid: item.review_item_uid,
    type: item.item_type,
    typeLabel: ISSUE_LABELS[item.issue_type] || item.item_type,
    entityUid: resolvedUid,
    entityLabel: entityUid,
    entityKind: kind || 'dataset',
    priority: item.priority || 'low',
    status: item.status || 'pending',
    reason: item.reason,
    issueUid: item.issue_uid,
    alignmentUid: item.alignment_uid,
    evidenceIds: item.evidence_ids || [],
    currentValue: item.current_value,
    candidateValues: item.candidate_values || [],
    targetRoute: routes[kind] || null,
    review: item.review || null,
  };
}

export default {
  schemaVersion: 'tse.dataset.v1',
  label: 'TSE dataset v1',

  loadSummary(payload) {
    const dataset = payload.dataset;
    const paper = dataset.paper || {};
    const run = dataset.run || {};
    const graph = dataset.route_graph || {};
    const map = dataset.document_map || {};
    return {
      datasetId: payload.dataset_id,
      revision: payload.revision,
      schemaVersion: payload.schema_version,
      title: paper.title,
      doi: paper.doi,
      year: paper.year,
      journal: paper.journal,
      pipelineState: run.pipeline_state,
      targetUid: run.target_compound_uid,
      targetName: map.target_molecule?.name,
      strategy: map.strategy_summary,
      counts: payload.catalog?.counts || {},
      entityTotal: payload.catalog?.entity_total || 0,
      routeStats: {
        longestLinearSequence: graph.longest_linear_sequence,
        components: graph.disconnected_components,
        targetReachable: graph.target_reachable,
      },
      documents: (paper.documents || []).map((doc) => ({
        documentId: doc.document_id,
        type: doc.type,
        pageCount: doc.page_count,
        sourceAvailable: !doc._private_source,
      })),
      assets: payload.assets || {},
      pages: payload.pages || [],
    };
  },

  loadCompounds(payload) {
    const index = buildIndex(payload.dataset);
    const evidenceById = new Map((payload.dataset.evidence || []).map((e) => [e.evidence_id, e]));
    return (payload.dataset.compounds || []).map((c) => compoundView(c, index, payload.dataset, evidenceById));
  },

  loadReactions(payload) {
    return (payload.dataset.reactions || []).map((r) => reactionView(r, payload.dataset));
  },

  loadAlignments(payload) {
    return (payload.dataset.alignments || []).map((a) => alignmentView(a, payload.verifications));
  },

  loadEvidence(payload) {
    return (payload.dataset.evidence || []).map((e) => ({
      id: e.evidence_id,
      type: e.evidence_type,
      documentId: e.document_id,
      page: e.page,
      schemeId: e.scheme_id,
      imageUrl: e.image_path,
      text: e.text,
      hasBox: Boolean(e.bbox),
      coordSpace: e.bbox?.coord_space || null,
      method: e.extraction_method,
    }));
  },

  loadRouteGraph(payload) {
    const graph = payload.dataset.route_graph || {};
    return {
      nodes: (graph.nodes || []).map((n) => ({
        id: n.node_id, type: n.node_type, label: n.label, status: n.status, isTarget: n.is_target,
      })),
      edges: (graph.edges || []).map((e) => ({ source: e.source, target: e.target, type: e.edge_type })),
      targetId: graph.target_node_id,
      longestLinearSequence: graph.longest_linear_sequence,
      components: graph.disconnected_components,
      targetReachable: graph.target_reachable,
    };
  },

  loadReviewItems(payload) {
    const index = buildIndex(payload.dataset);
    const items = payload.review_queue?.items || [];
    const issues = new Map((payload.dataset.issues || []).map((i) => [i.issue_uid, i]));
    return items.map((item) => {
      const issue = issues.get(item.issue_uid) || {};
      return reviewItemView({ ...item, issue_type: issue.issue_type }, index);
    });
  },

  loadIssues(payload) {
    return (payload.dataset.issues || []).map((issue) => ({
      uid: issue.issue_uid,
      type: issue.issue_type,
      typeLabel: ISSUE_LABELS[issue.issue_type] || issue.issue_type,
      severity: issue.severity,
      entities: issue.entities || [],
      description: issue.description,
      status: issue.status,
      evidenceIds: issue.evidence_ids || [],
    }));
  },

  loadValidations(payload) {
    return (payload.dataset.validations || []).map((v) => ({
      check: v.check,
      target: v.target,
      passed: v.passed,
      severity: v.severity,
      detail: v.detail,
      metrics: v.metrics || {},
    }));
  },

  loadAlignmentCandidates(payload) {
    return (payload.alignment_candidates || []).map((c) => ({
      passageId: c.passage_id,
      reactionUid: c.reaction_uid,
      page: c.page,
      charStart: c.char_start,
      charEnd: c.char_end,
      text: c.text,
      retrievalScore: c.retrieval_score,
      matchedLabels: c.matched_labels || [],
    }));
  },
};
