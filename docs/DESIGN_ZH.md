# 合成抽取审核前端：设计方案

> 上游需求见 [FRONTEND_REVIEW_HANDOFF_ZH.md](FRONTEND_REVIEW_HANDOFF_ZH.md)。
> 视觉与工程范式参考 `E:\Retro\web`（RouteLM Studio，见其 `ARCHITECTURE.md`）。
>
> 本文是**设计**，不是实现记录：说明要建哪些文件、每个页面长什么样、数据怎么流、
> 坑在哪里。文中的数字全部来自 2026-08-25 的 `INELEGANOLIDE_MVP_V2` 真实数据。

---

## 0. 一句话结论

做一个**零构建的静态前端 + 单文件 FastAPI 后端**，放在
`E:\OSTE\paper-record-to-eln\review_frontend\`，直接沿用 RouteLM Studio 的
CSS 变量、组件类名和 `h()/api()/molImg()` 工具层；后端只做浏览器做不到的四件事：
**读磁盘、归一化路径、用 RDKit 画结构、追加审核事件**。

**视觉稿**：[review_frontend/mockup.html](review_frontend/mockup.html) 是按本文做的静态视觉稿，
用真实数据和真实裁剪图渲染了 5 个屏（概览 / 审核工作台 / 化合物审核 / 证据查看器 / 路线图）。
直接双击打开即可，图片走相对路径；里面的分子结构图是用 `chemistry` 环境的 RDKit 2026.03.1
真跑出来的 SVG，页面图上的 bbox 也是按 §6.7 的换算规则从真实坐标算出来的。

核心界面隐喻只有一句：**左边是模型说的，右边是论文原文说的，中间那个按钮是人说的。**
页面上任何一处「模型结论」，都必须能在同屏看到它的原始证据（裁剪图 / 页面图 bbox /
原文段落），否则那块 UI 就没有存在价值。

---

## 1. 技术选型与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 前端框架 | **无**。原生 ES modules + 手写 `h()` | 与 RouteLM Studio 一致；改 `.js` 刷新即生效，没有 npm / 构建 / CDN。19 化合物、14 反应的量级远达不到需要框架和虚拟列表的规模 |
| 样式 | 拷贝 `E:\Retro\web\static\css\app.css` 作基线，追加 `review` 段 | 直接得到 light/dark 双主题和 `.card/.chip/.metric/.list-row/.table` 一整套已经调好的组件 |
| 结构渲染 | **服务端 RDKit** → SVG，与 RouteLM 的 `/api/render.svg` 同款 | 不引 JS 化学库；立体标注、配色跟随主题都交给 RDKit。**前提已验证**：`C:\Users\lpz\miniconda3\envs\chemistry` 里 rdkit 2026.03.1 + fastapi 0.136.3 都在（仓库默认的 miniconda base 里**没有** rdkit） |
| 后端 | 单文件 `server.py`（FastAPI + uvicorn） | 与 RouteLM 对称，一个人能通读 |
| 事件存储 | append-only JSONL，一个数据集一个文件 | 满足「不得覆盖 `dataset.json`」；云端换 PostgreSQL 时表结构一一对应 |
| 启动 | `start.ps1`，指定 `chemistry` 环境 | 抄 `E:\Retro\web\start.ps1`，含 `-Lan` 与端口参数 |

**不做**（第一版明确排除）：模型调用、自动改写数据、账号体系与权限矩阵、
PDF.js 内嵌阅读器、离线打包。

---

## 2. 目录与文件清单

```text
E:\OSTE\paper-record-to-eln\review_frontend\
├── catalog.json                 已存在，由 scripts\build_review_catalog.py 生成（只读）
├── server.py            ~700 行 FastAPI：目录/数据/资产/RDKit/审核事件
├── start.ps1             ~60 行 用 chemistry 环境启动，可选 -Lan
├── review_events\               审核事件落盘目录（唯一被写入的地方）
│   └── INELEGANOLIDE_MVP_V2.jsonl
└── static\                      纯静态，无构建
    ├── index.html               外壳：侧边栏、抽屉、toast
    ├── css\
    │   └── app.css              RouteLM 基线 + 审核专用类
    └── js\
        ├── app.js               hash 路由、主题、catalog 引导、快捷键总线
        ├── util.js              h/api/molImg/chip/metric/markdown（自 RouteLM 拷贝）
        ├── store.js             dataset bundle 缓存 + 索引 + 事件本地投影
        ├── evidence.js          证据抽屉：页面图缩放、bbox 叠加、原文高亮
        ├── routemap.js          收敛型路线的分层 DAG 布局
        ├── adapters\
        │   ├── index.js         registry: schema_version → adapter
        │   └── tse_v1.js        tse.dataset.v1 → ViewModel
        └── views\
            ├── overview.js      数据集概览
            ├── queue.js         审核工作台（主战场）
            ├── route.js         路线视图
            ├── compounds.js     化合物列表 + 化合物审核
            ├── reactions.js     反应列表 + 反应审核
            ├── alignments.js    原文对齐审核
            ├── quality.js       校验与问题
            └── history.js       审核历史
```

三个根目录常量（`server.py` 顶部，全部可用环境变量覆盖）：

| 常量 | 默认值 | 是否写入 |
|---|---|---|
| `HERE` | `review_frontend\` | 只写 `review_events\` |
| `REPO_ROOT` | `E:\OSTE\paper-record-to-eln`（`REVIEW_REPOSITORY_ROOT`） | **只读** |
| `CATALOG` | `REPO_ROOT / review_frontend/catalog.json`（`REVIEW_CATALOG_PATH`） | **只读** |

数据集根目录一律从 catalog 的 `repo_relative_workspace` 拼出，
**任何组件、任何 JS 里都不出现 `E:\`**。

---

## 3. 后端设计

### 3.1 分区

| 分区 | 职责 |
|---|---|
| 路径与安全 | `REPO_ROOT` 解析、`dataset_root(id)`、`safe_asset(rel)` |
| 目录 | 读 `catalog.json`，按 mtime 缓存；提供数据集清单与 revision |
| Bundle 装载 | 读 workspace 下的 JSON，做**通用路径归一化**，缓存到内存 |
| RDKit | `render_svg()` / `molecule_props()`（照搬 RouteLM `server.py:110-209`） |
| 原文回查 | `verify_source()`：用 `paper.json` 的页面文本重切片比对 |
| 事件 | append-only JSONL，读时折叠成当前状态 |
| HTTP | `/api/v1/*` + `/review-data/*` 资产 + `/` 静态前端 |

### 3.2 路径归一化：一条通用规则，不依赖 schema

现有 JSON 里散落着 Windows 绝对路径：`compounds[].candidates[].image_path`、
`evidence[].image_path`、`moldet/*/detections.json` 的 `image_path` / `weights_path`、
甚至 `provenance.model_version` 里的 `fixture:E:\...`。

后端装载 bundle 时**递归遍历整个 JSON**，对每个字符串套一条规则：

1. 规范化分隔符（`paper.json` 的 `renders` 用的是 `pages\DOC_MAIN_p0002_450dpi.png`）；
2. 若解析后位于**本数据集 workspace 内** → 改写成
   `/review-data/datasets/{dataset_id}/{相对路径}`；
3. 若位于 workspace 外（如原始 PDF `E:\xwechat_files\...`）→ 置为 `null`，
   并在同级写入 `"_private_source": true`，前端据此显示「源文件未公开」；
4. 其余含盘符的字符串（`model_version` 这类）→ 只保留 basename，前缀换成 `local:`，
   避免把服务器目录结构泄漏给浏览器。

这条规则与字段名无关，所以**换 schema 不用改它**。

### 3.3 资产服务与目录穿越

```text
GET /review-data/datasets/{dataset_id}/{path:path}
```

`(dataset_root / path).resolve()` 必须仍在 `dataset_root.resolve()` 之下
（`Path.is_relative_to`），否则 404；拒绝任何含 `..` 的原始段；只放行白名单后缀
（`.png .jpg .svg .json .md .csv`）。`pages/` 里 450 dpi 的图有 1–2 MB，
加 `Cache-Control: public, max-age=86400`，缓存键里带 revision。

### 3.4 API

| 端点 | 说明 |
|---|---|
| `GET /api/v1/catalog` | 数据集清单、revision、计数、审核摘要 |
| `GET /api/v1/datasets/{id}` | **归一化后的完整 bundle**，响应头带 `ETag: {revision}` |
| `GET /api/v1/datasets/{id}/review-items` | 队列项 + 已折叠的当前状态 |
| `GET /api/v1/datasets/{id}/compounds/{uid}` | 单个化合物（大数据集用） |
| `GET /api/v1/datasets/{id}/reactions/{uid}` | 单个反应 |
| `GET /api/v1/datasets/{id}/evidence/{eid}` | 证据 + 可显示的底图 URL 与像素尺寸 |
| `GET /api/v1/datasets/{id}/evidence/{eid}/verify-source` | 服务端回查原文，见 §3.6 |
| `GET /api/v1/datasets/{id}/review-events` | 全量事件，按时间升序 |
| `POST /api/v1/datasets/{id}/review-events` | 追加事件 |
| `GET /api/v1/render.svg?smiles=&w=&h=&theme=&stereo=` | RDKit 结构图 |
| `GET /api/v1/molecule?smiles=` | RDKit 描述符（详情抽屉用） |
| `GET /api/v1/health` | rdkit 是否可用、catalog mtime、事件文件可写性 |

**为什么 MVP 前端只用前两个**：`dataset.json` 是 184 KB，gzip 后约 40 KB，
一次拉完在浏览器里建索引，比发 60 个小请求快得多，也让跨实体跳转
（化合物 ↔ 反应 ↔ 对齐 ↔ 证据）变成纯内存操作。实体级端点先实现、先留着，
等某个 bundle 超过 **5 MB** 再让 `store.js` 切换到懒加载——阈值写成一个常量。

### 3.5 审核事件：append-only + 折叠

请求体：

```json
{
  "review_item_uid": "REVIEW_ISSUE_ISSUE_S0001",
  "decision": "accepted | rejected | corrected | deferred",
  "corrected_value": null,
  "comment": null
}
```

请求头：`Idempotency-Key`（前端 `crypto.randomUUID()`，重试复用同一个）、
`If-Match: {revision}`。

服务端补齐后写盘（**客户端提供的 uid / 时间戳一律丢弃**）：

```json
{
  "review_event_uid": "REV_01J...",
  "dataset_id": "INELEGANOLIDE_MVP_V2",
  "dataset_revision": "e820d72694c6ed8e",
  "schema_version": "tse.dataset.v1",
  "review_item_uid": "REVIEW_ISSUE_ISSUE_S0001",
  "decision": "corrected",
  "corrected_value": { "smiles": "..." },
  "reviewer_id": "lpz",
  "reviewed_at": "2026-08-25T12:00:00Z",
  "idempotency_key": "…",
  "comment": null,
  "client": "review_frontend/0.1"
}
```

- `If-Match` 与当前 revision 不符 → **409**，前端弹「数据集已更新，请刷新后重审」；
- `Idempotency-Key` 命中已有事件 → **200** 返回原事件，不重复写；
- 写入用 `"a"` 模式 + `flush()` + `os.fsync()`，进程内一把 `threading.Lock`；
- 读取时按 `review_item_uid` 折叠（同 item 取最后一条）得到当前状态，
  **历史全部保留**，`history.js` 直接展示这条时间线。

`reviewer_id` 在 MVP 里取 `localStorage` 填的名字，服务端用
`REVIEW_DEFAULT_REVIEWER` 兜底；这是**已知限制**（§10）。云端换成 OIDC 后
这个字段改由 token 提供，事件格式不变。

### 3.6 原文回查是可以真做的，不是打个勾

`alignments[].char_start/char_end` 与 `paper.json` 里
`documents[0].pages[].text` 的偏移**对得上**（已验证 `ALIGN_0001`：第 2 页
`[1139,1452)` 切出来的文字与 `alignments[].text` 只差换行——存储版把换行压成了空格）。

所以 `verify-source` 这样实现：取页面文本切片 → 两边都做
`re.sub(r"\s+", " ", s).strip()` → 逐字比较，返回
`{"verified": true|false, "page_slice": "...", "stored_text": "..."}`。

**只有服务端比对通过，UI 才允许出现绿色的「已回查原文」徽标**；
`source_verified` 字段本身只是模型自称，不作为显示依据。这是交接文档 §5.4
「模型生成的解释不能伪装成论文原文」那条要求的可执行版本。

---

## 4. 前端数据层

### 4.1 Adapter registry

后端只做与 schema 无关的路径归一化，**字段语义的翻译放在浏览器侧**，
一个 schema 一个文件：

```js
// js/adapters/index.js
const ADAPTERS = { 'tse.dataset.v1': tseV1 };
export function adapterFor(schemaVersion) {
  return ADAPTERS[schemaVersion] || null;   // null → 渲染「不支持的格式」页
}
```

adapter 接口（对应交接文档 §3，用 JSDoc 表达，不引 TS）：

```js
/**
 * @typedef {Object} ReviewDatasetAdapter
 * @property {string} schemaVersion
 * @property {(raw:any)=>DatasetSummary}   loadSummary
 * @property {(raw:any)=>CompoundView[]}   loadCompounds
 * @property {(raw:any)=>ReactionView[]}   loadReactions
 * @property {(raw:any)=>AlignmentView[]}  loadAlignments
 * @property {(raw:any)=>EvidenceView[]}   loadEvidence
 * @property {(raw:any)=>RouteGraphView}   loadRouteGraph
 * @property {(raw:any)=>ReviewItemView[]} loadReviewItems
 */
```

**`views/` 下的任何文件都不许出现原始 JSON 的字段名。**
比如 `structure_status` 只在 `tse_v1.js` 里被读一次，转成
`CompoundView.status: 'ok' | 'warn' | 'unresolved'`。加新格式时只加一个 adapter，
页面一行不改——这是交接文档 §9「adapter 与 UI 分离」的落地方式。

### 4.2 ViewModel（关键字段）

```js
CompoundView   { uid, label, names, status, confidence, isTarget,
                 smiles: { raw, canonical, isomeric },
                 identity: { formula, mass, inchiKey, stereocenters,
                             unspecifiedStereocenters },
                 candidates: [{ visualId, smiles, model, cropUrl, parsable,
                                confidence, warnings }],
                 mentions, evidenceIds,
                 reactionUids: { asReactant: [], asProduct: [] },
                 issueUids, review }

ReactionView   { uid, stepIndex, schemeId, visualId, reactants: [uid],
                 products: [uid], conditionsRaw,
                 temperature: { value, rawText } | null,   // value 是字符串 "60 °C"
                 time: { value, rawText } | null,
                 yield: { value, rawText, normalization } | null,  // value 是数字
                 yieldType, reactionSmiles,
                 status: 'passed' | 'warning' | 'not_run',
                 confidence, evidenceIds, alignmentUids, validations, review }

AlignmentView  { uid, reactionUid, evidenceId, page, charStart, charEnd, text,
                 relation, supportsRouteStep,
                 mentions: { reactants, products, conditions, yield },
                 coreferences, consistency,
                 scores: { retrieval, semantic, combined },
                 sourceVerified, verifiedByServer, reviewStatus }

EvidenceView   { id, type: 'scheme_image' | 'molecule_image' | 'page_text',
                 page, schemeId, imageUrl,
                 box: { x0, y0, x1, y1, space, dpi } | null,
                 text, basePx: { w, h } }

ReviewItemView { uid, type, entityUid, entityKind, priority, status, reason,
                 currentValue, candidateValues, evidenceIds, targetRoute }
```

`ReviewItemView.targetRoute` 是 adapter 算出来的**跳转地址**
（`#/compound/CMP_0001`、`#/reaction/RXN_SCHEME_1_01` …）。队列里的
`entity_uid` 现在混着 `M014`（视觉框 ID）、`CMP_0001`、`RXN_...` 和
`INELEGANOLIDE_MVP_V2`（数据集自身）四种东西——把这个歧义**在 adapter 里消化掉**，
UI 只看 `entityKind`。`M014` 的解析方式：在 `compounds[].candidates[].visual_id`
和 `mentions[].visual_id` 里反查所属 `compound_uid`。

### 4.3 队列只有 5 项，但要审的东西有 51 件

`review_queue.json` 当前只有 5 项（1 high / 2 medium / 2 low），
而实际需要人眼确认的是 **19 个结构 + 14 个反应 + 18 条对齐**。
如果 UI 只让人处理队列里那 5 项，它就不是审核工具，只是个 bug 列表。

设计上把审核项分两类，**共用同一套事件格式**：

| 类别 | uid 形态 | 来源 |
|---|---|---|
| 队列项 | `REVIEW_ISSUE_ISSUE_S0001` | `review_queue.json` |
| 即席项 | `ADHOC:compound:CMP_0003`、`ADHOC:reaction:RXN_SCHEME_1_02`、`ADHOC:alignment:ALIGN_0007` | 前端在任意实体页按需生成 |

后端 `POST review-events` 两种都收：队列项校验必须存在于 `review_queue.json`；
`ADHOC:` 前缀的校验冒号后的实体 uid 在 bundle 里存在即可。
于是「审核进度」有两个指标，概览页两个都显示：

- **待办进度** = 已决策队列项 / 5；
- **覆盖率** = 至少有一条事件的实体 / 51。

---

## 5. 视觉系统

### 5.1 调色板

沿用 RouteLM Studio 的暖纸配色（`--bg:#faf9f5`、`--accent:#c15f3c`；dark 下
`--bg:#1f1e1d`）。它已经解决了「长时间盯屏 + 大量结构图」这件事：白卡片配米色底，
结构图的黑线不会像纯白背景那样刺眼。

在此之上**只新增一组审核语义色**，写进 `:root` 与 `[data-theme="dark"]`：

```css
--decision-accept:  var(--ok);     --decision-reject:  var(--bad);
--decision-correct: var(--info);   --decision-defer:   var(--muted);
--verified: var(--ok);    /* 服务端回查通过 */
--claimed:  var(--warn);  /* 模型自称，未回查 */
```

置信度不用连续色带（人分不出 0.62 和 0.65），统一三档：
`≥0.85 高` / `0.6–0.85 中` / `<0.6 低`，对应 `.chip-ok/.chip-warn/.chip-bad`。
注意当前数据里化合物 confidence 集中在 **0.61–0.65**，全是「中」——所以化合物列表
**默认按 `structure_status` 排序**（`unresolved` → `parsed_with_warnings` →
`validated`），置信度只作次要列，不要指望它有区分度。

### 5.2 复用与新增的组件

| 直接复用 | 新增 |
|---|---|
| `.card .btn .chip .metric .list-row .table .mol-frame .mol-card` | `.review-bar` 决策条（四按钮 + 备注框） |
| `.smiles .mono .stack .spread .divider` | `.compare` 左右对照栅格（裁剪图 vs 渲染图） |
| 抽屉 `.drawer-host`、toast、主题切换 | `.bbox-layer` bbox 叠加层 |
| `minmax(0,1fr)` 防横向溢出的那套约定 | `.passage` 原文段落 + `<mark>` 高亮 |
| | `.queue-item` 队列行（优先级色条 + 状态点） |
| | `.dag` 收敛路线图 |

### 5.3 侧边栏

品牌区改成 `合成抽取审核台 / Synthesis Review`，图标沿用烧瓶 SVG。导航八项：

```text
概览   审核队列(5)   路线   化合物(19)   反应(14)   原文对齐(18)   质量(5)   历史
```

括号里的数字从 catalog 直接来，队列项在有 pending 时显示 accent 圆点。
底部状态卡两行：`数据集 INELEGANOLIDE_MVP_V2 · rev e820d72`、
`RDKit 可用 / 未安装（结构图降级）`。

---

## 6. 页面设计

### 6.1 概览 `#/`

```text
┌─ (+)-Ineleganolide 全合成 ────────────────────────────────────────┐
│ DOI 10.1021/jacs.3c02142 · 2023 · tse.dataset.v1 · rev e820d72   │
├──────────────────────────────────────────────────────────────────┤
│ [化合物 19] [反应 14] [对齐 18] [证据 38] [问题 5] [校验 13/14过] │
│ [最长线性序列 13] [连通分量 1] [目标可达 ✓]                       │
├─ 审核进度 ───────────────────────┬─ 目标分子 ────────────────────┤
│ 待办 0/5   ▓▓░░░░░░░░            │  [RDKit 结构图]               │
│ 覆盖 0/51  ░░░░░░░░░░            │  (+)-ineleganolide (1)        │
│ high 1 · medium 2 · low 2        │  CMP_0019                     │
├─ 策略摘要（document_map）─────────┴───────────────────────────────┤
│ Convergent total synthesis coupling 5 and 6 …                    │
├─ 流水线历史（paper.json.history）─────────────────────────────────┤
│ UPLOADED → PARSED → … → HUMAN_REVIEW                             │
└──────────────────────────────────────────────────────────────────┘
```

底部放 `report/extraction_summary.md`（用 RouteLM 那个手写 `markdown()` 渲染）
和下载区（`reactions.csv` / `reaction_smiles.csv` / `dataset.json`）。
catalog 里有多个数据集时，页顶出现数据集切换下拉。

### 6.2 审核工作台 `#/queue` —— 主战场

三栏，中栏随审核项类型换内容：

```text
┌ 队列 280px ─┬─ 审核面板 ──────────────────┬─ 证据 380px ──────┐
│ ▮high  M014 │ ISSUE_S0001  ocsr_failed    │ [页面图 p2]       │
│  OCSR 失败  │ 化合物 17 (CMP_0014)        │  ▭ bbox 高亮      │
│ ▮med  RXN_1 │                             │ [裁剪图 M014]     │
│  原子守恒   │ ┌ 原图裁剪 ──┬ 渲染结构 ──┐ │ [原文 p2 段落]    │
│ ▮med  数据集│ │ [crop png] │ SMILES 无法 │ │  “…lactone 17…”  │
│ ▮low  CMP_1 │ │            │ 解析 ✕      │ │                   │
│ ▮low  CMP_9 │ └────────────┴─────────────┘ │ 相关反应 ×2       │
│             │ 原始 SMILES（不可解析）：     │                   │
│ 筛选：      │ CC(=C)[C@@H]1CC(=O)…         │                   │
│ [优先级]    │ 候选：1 个，均不可解析        │                   │
│ [状态]      │                             │                   │
│ [类型]      │ ┌ 决策 ─────────────────────┐ │                   │
│             │ │ ✓接受 ✗拒绝 ✎更正 ⏱延后  │ │                   │
│             │ │ 更正值：[SMILES 输入框]   │ │                   │
│             │ │ 备注：  [_____________]   │ │                   │
│             │ └───────────────────────────┘ │                   │
└─────────────┴─────────────────────────────┴───────────────────┘
```

- **更正值的形态跟着 `item_type` 变**：结构类给 SMILES 输入框（输入时实时打
  `/api/v1/render.svg` 预览，解析失败就地报红，**不允许提交不可解析的 SMILES**，
  除非勾选「确实无法用 SMILES 表达」）；反应类给条件 / 产率的结构化小表单；
  对齐类给候选段落单选（数据源 `alignment_candidates.json`）。
- **快捷键**（`app.js` 一个全局总线，输入框聚焦时整体禁用）：
  `j/k` 上下项，`a/x/c/d` 接受 / 拒绝 / 更正 / 延后，`e` 展开证据大图，
  `Enter` 提交，`u` 撤销上一次提交（追加一条反向事件，**不删记录**），`?` 帮助浮层。
- 提交后 toast + 队列行状态点变色 + 自动跳下一项 pending。
- 决策条在**每一个实体详情页里复用同一个组件**，那里提交的是 `ADHOC:` 项。

### 6.3 路线视图 `#/route`

这条路线是**收敛型**的：`(R)-linalool` 与 `(S)-norcarvone` 两条支线在酯 4 处汇合。
RouteLM 那套纯 CSS 树线（`.tnode/.tlink/.tbranch`）只能画外向树，**这里不能照抄**。

做法：

1. 用 `route_graph.json` 的 `nodes/edges` 建图，`layer(n) = 起始物到 n 的最长路径`
   （DAG 上一次拓扑排序即可）；同层横排，层间纵向排布；
2. 节点是**普通 DOM 卡片**（化合物卡显示结构图 + 标签；反应节点显示
   `conditions_raw` 首行 + 产率徽标），因为要能点击、hover、带状态色；
3. 边画在一层绝对定位的 `<svg>` 上，节点位置用 `getBoundingClientRect()` 采集，
   `ResizeObserver` + 图片 `load` 事件触发重算——**结构图是异步加载的，
   不重算就会连错线**；
4. 节点着色：`route_graph.nodes[].status`（当前有一个 `unresolved`：CMP_0014）、
   反应的 `validation_status`（1 个 warning：RXN_SCHEME_1_01）；
5. 点击化合物 / 反应 → 跳对应审核页；hover 高亮该节点的全部入边出边。

**降级**：布局代码出错或节点数 > 200 时，直接
`<img src=".../report/route.svg">` 显示离线路线图，并提示「已切换到静态路线图」。
route.svg 是浅底深线的图，dark 主题下要给它套白底容器（或
`filter: invert(.92) hue-rotate(180deg)`）——**不要**让它在深色下糊成一团。

### 6.4 化合物 `#/compounds` `#/compound/{uid}`

列表用 `.list-row`，缩略图取 **OCSR 裁剪图**（不是渲染图——审核的第一眼应该看到
论文里长什么样），右侧显示标签、状态 chip、置信度、参与反应数。
默认排序 `unresolved → parsed_with_warnings → validated`。

详情页的核心是 §0 那条对照，**左右两列等高并排**：

```text
┌ 论文里的样子 ─────────────┬ 模型读出来的 ──────────────┐
│ [molecule_crops/M003.png] │ [RDKit SVG from SMILES]    │
│ 框 M003 · 置信 0.99       │ parsed_with_warnings       │
│ [在 Scheme 上定位][看页面]│ C15H26O2Si · 266.17        │
└───────────────────────────┴────────────────────────────┘
raw / canonical / isomeric SMILES（三行 .smiles 块，各带复制按钮）
InChIKey · 立体中心 3（未指定 1 ⚠）
候选列表：每候选一行（模型 / crop_variant / 置信 / 是否可解析 / warnings）
  → 选中某个候选 ＝ 提交一条 corrected 事件，**原候选一个都不删**
出现位置：p2 / M003 → 点击进证据抽屉
参与反应：作为产物 RXN_SCHEME_1_02 · 作为反应物 RXN_SCHEME_1_03
[决策条]
```

**降级三级**（验收项）：RDKit 可用且能解析 → SVG；解析失败 → 红字
「SMILES 无法解析」+ 裁剪图占满该列；连裁剪图都缺 → 灰底占位 + 原始 SMILES 文本。
三种情况下组件都不许抛异常。

### 6.5 反应 `#/reactions` `#/reaction/{uid}`

一行式反应式：`[反应物结构] + [反应物] ──条件──▶ [产物结构]`，条件写在箭头上方
（`conditions_raw` 带换行，如 `"1. TBAF, THF, 60 °C\n2. TBSCl, imid, DMAP, CH2Cl2"`，
渲染成多行小字），产率写箭头下方。

**注意 `yield` 和 `temperature` 不是标量，是对象**（交接文档 §5.3 的字段表在这点上
容易读错）：

```json
"yield": { "value": 56.0, "raw_text": "56% yield over 2 steps",
           "normalization_status": "exact", "confidence": null, "provenance": {...} }
```

adapter 里要拆成 `yield.value` + `yield.rawText`：**UI 显示 `value`，
hover / 副行显示 `raw_text`**——`56%` 与「56% yield over 2 steps」在审核语境下
不是一回事，两步收率被当成单步收率是这类抽取最典型的错误。
当前 14 个反应里 9 个有产率（45–87%），5 个为 `null`（要有「未给出产率」空态，
不显示 `null`）；`yield_type` 12 个 `unspecified`、2 个 `two_step`，
`two_step` 必须在 UI 上明确标出来。`temperature` 同理，`value` 是
`"60 °C"` 这样的**字符串**，不要当数字格式化。

**参与者一律走 `reactants/products` 里的 `compound_uid`，不解析 `reaction_smiles`**
（交接文档 §5.3）。`reaction_smiles` 单独一行 `.smiles` 块，标注「导出用」。

下方并列三块：

- **校验**：从 `validations.json` 里筛 `target == reaction_uid` 的项，显示
  `heavy_atom_conservation`、`lcs_ratio`、`reaction_center_size`。
  RXN_SCHEME_1_01 的守恒度是 0.458（红），**必须同时显示 `mapper: none` 这个前提**
  ——「rxnmapper 未安装，仅有守恒度指标」，避免审核人误以为这是原子映射结论。
- **对齐**：该反应关联的原文段落（可能多条），每条一句摘要 + 跳转。
- **证据**：scheme 框 + 页面文本框。

### 6.6 原文对齐 `#/alignments`

左右分栏：左边反应（结构 + 条件），右边原文段落。原文里的
`reactant_mentions` / `product_mentions` / `condition_mentions` 用不同颜色的
`<mark>` 高亮（在段落文本上做字符串匹配着色，同一词多次出现要全标）。

段落头部三个徽标：

- `relation`：`direct_reaction_description`(13) / `experimental_summary`(3) /
  `external_preparation`(2)，中文映射写在 adapter 里；
- `consistency`：consistent(9) / partial(6) / not_stated(3)；
- **回查状态**：绿色「已回查原文 p2 [1139,1452)」仅当 §3.6 的服务端比对通过，
  否则橙色「模型自称，未能回查」。

`retrieval / semantic / combined` 三个分数用一行小柱条。
「换一段原文」按钮打开 `alignment_candidates.json` 的候选列表，选中即提交一条
`corrected` 事件（`corrected_value = {passage_id, char_start, char_end}`）。

### 6.7 证据抽屉（不是导航项，是全局组件）

右侧滑出，任何地方点 `evidence_id` 都能打开。三种证据类型三种视图：

| 类型 | 数量 | 视图 |
|---|---|---|
| `scheme_image` | 1 | Scheme 高清图 + 可切「带检测编号的叠图」`moldet/SCHEME_1/SCHEME_1_moldet.png` |
| `molecule_image` | 19 | 单分子裁剪 + 在 Scheme 全图上的红框定位 |
| `page_text` | 18 | 页面图（150 dpi）+ 段落文本 + 高亮 |

**bbox 叠加的坐标换算是这里最容易做错的地方**，规则写死在 `evidence.js`：

1. 只信 `bbox.coord_space`。当前数据有两种：20 条 `page_px`（带 `dpi: 450`），
   18 条 `bbox: null`；`moldet/*/detections.json` 里则是 `image_px`
   （相对 `schemes/SCHEME_1.png`，3151×2718），另有 `raw_space: "yxyx@1000"`
   的归一化原值——**`raw` 一律忽略，只用规范化后的 `x0/y0/x1/y1`**。
2. 底图像素尺寸：
   - `page_px` → 由 `paper.json` 的 `width_pt/height_pt` 换算 `px = pt × dpi / 72`
     （第 2 页 450 dpi = 3796×5006），**不需要读图片头**；
   - `image_px` → 用 `detections.json` 自带的 `image_width/image_height`。
3. 底图选择：优先 `renders[str(dpi)]`；缺失时取任一可用 dpi 并按比例缩放
   （150 dpi 图配 450 dpi 的框 → 乘 150/450）。
4. **叠加层用百分比定位**：`left = x0 / basePx.w * 100%`，宽高同理。
   这样图片被 CSS 缩放、用户放大、窗口变窄都不会错位——绝不要把 bbox
   当 CSS 像素直接摆。
5. 交互：滚轮缩放（0.5×–8×）、拖拽平移、双击复位、`[适应窗口]`。

`bbox` 为 `null`（18 条 page_text）时不画框，只显示页面图 + 文本高亮，
并注明「该证据只有文本区间，无版面坐标」。

### 6.8 质量 `#/quality`

上半 `validations.json`（14 条，1 条未通过：RXN_SCHEME_1_01 的原子守恒）按 `severity` 分组的表格；
下半 `issues.json`（5 条）卡片列表，每张卡片带「去审核」按钮直达队列对应项。
`blocking` 级未通过要在页顶用红色 callout 顶出来（当前 `target_reachable` 是通过的）。

### 6.9 历史 `#/history`

按审核项聚合的时间线：模型原值 → 候选 → 每次人工决定（谁、何时、决定、备注）
→ 折叠后的最终值。顶部一行筛选（reviewer / decision / 时间）和「导出事件 JSONL」。
这个页面证明「刷新后事件仍在、原始数据没被覆盖」，是验收项 7 的直接体现。

---

## 7. 降级与空态总表

| 情况 | 界面 |
|---|---|
| catalog 里 `schema_version` 无 adapter | 整页「不支持的数据格式 tse.dataset.v2」+ 已知格式列表，**不猜字段** |
| RDKit 未安装 / 导入失败 | 全站结构图位置显示裁剪图；侧边栏状态卡红点；SMILES 输入框的实时预览关闭 |
| SMILES 无法解析（CMP_0014） | 红字提示 + 裁剪图 + 原始串可复制，引导人工填更正值 |
| 图片 404（`onerror`） | 灰底占位 + 相对路径文字，便于报错 |
| `yield` / `temperature` / `time` 为 null（5 / 14 无产率） | 「未给出」灰字，不显示 `null` |
| `procedures` 为空（当前 0 条） | 反应页的「实验步骤」区块整块隐藏，概览标注「无 SI」 |
| 原始 PDF 不可访问 | 「源文件未公开，请使用页面渲染图」 |
| 事件文件不可写 | 决策条禁用 + 顶部持久红条，避免人白审一遍 |
| revision 变化（409） | 弹窗「数据集已重新抽取」，提供刷新按钮 |

---

## 8. 实施顺序

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | `server.py` 的路径 / catalog / bundle / 资产 + 外壳 + 概览 + 化合物列表 | 能从 catalog 打开数据集，看到 19 / 14 / 18 / 38 |
| M2 结构与证据 | RDKit 端点、化合物详情对照、证据抽屉与 bbox | 裁剪图 / 页面图 / Scheme 都能正确叠框 |
| M3 审核闭环 | 事件 API、决策条、队列工作台、快捷键 | 四类事件都能提交，刷新仍在，`dataset.json` mtime 不变 |
| M4 关系视图 | 路线 DAG、反应页、对齐页、`verify-source` | 从任意 review item 三跳内到达证据 |
| M5 收尾 | 质量页、历史页、全部降级分支、第二个数据集验证 | 对照交接文档 §11 逐条打勾 |

M1–M3 是可用产品，M4–M5 是完整交付。

---

## 9. 与交接文档验收项的对照

| 验收项 | 落在本文哪里 |
|---|---|
| 从 catalog 打开数据集 | §3.4、§6.1 |
| 浏览 19 / 14 / 18 / 38 | §6.4 §6.5 §6.6 §6.7 |
| 5 个待审核项及优先级 | §6.2 |
| review item → 结构 / 反应 / 证据 跳转 | §4.2 `targetRoute`、§6.2 |
| scheme / 裁剪 / 页面图 / route.svg | §6.3 §6.4 §6.7 |
| 追加四类事件 | §3.5 |
| 刷新后事件仍在、原数据未覆盖 | §3.5、§6.9 |
| 资产不出现 `E:\` | §3.2 §3.3 |
| 不改代码加第二个数据集 | §2 catalog 驱动、§4.1 |
| 未知 schema / 缺图 / 坏 SMILES / 未回查原文 | §7 |

---

## 10. 已知限制（第一版就写进 README）

1. **没有身份验证**。`reviewer_id` 是自己填的；`-Lan` 之后同网段任何人都能提交事件。
2. **单进程内存缓存**。catalog / bundle 按 mtime 失效，多进程部署需换共享缓存。
3. **事件折叠在读时做**。事件量到十万级要建索引或换 SQLite（表结构已按 §3.5 对齐）。
4. **原文回查依赖 `paper.json` 的页面文本**。若某页 `has_text_layer` 为 false，
   只能给出「无文本层，无法回查」。
5. **`conditions_raw` 是原样字符串**，没有结构化的温度 / 时间 / 当量；反应页的更正
   表单写进 `corrected_value`，不回写原字段。
