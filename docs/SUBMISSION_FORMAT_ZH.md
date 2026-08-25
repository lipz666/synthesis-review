# 提交格式规范 · `review.submission.v1`

> 面向**上游抽取流水线**和任何想把数据送进审核台的系统。
> 机器可读版本：`GET /api/v1/ingest/spec`（服务端实时返回当前限制值）。

一次提交 = 一篇论文的一次抽取结果。提交成功后它立刻出现在数据集列表里，
不需要重启服务、不需要改任何代码。

---

## 1. 三条硬规则

1. **只有 `data/dataset.json` 是必需的**，其它一切都是可选增强。
2. **revision 由内容决定**：`sha256(dataset.json) + sha256(review_queue.json)` 取前 16 位。
   同样的内容重复提交 → 同一个 revision → 不产生副本（幂等）。
   内容变了 → 新 revision → 旧 revision 保留，审核事件仍绑在它上面。
3. **提交前先校验**。所有接口都支持 `dry_run`，返回同样的报告但不写任何东西。

---

## 2. 包结构

```text
data/dataset.json                 必需  抽取结果本体
data/review_queue.json            建议  待审核队列
data/alignment_candidates.json    可选  备选原文段落（审核时「改选段落」用）
data/database_rows.json           可选  按库表拆分的行数据
data/reactions.csv                可选  下载用
data/reaction_smiles.csv          可选  下载用
report/route.svg                  可选  离线路线图（交互路线图的降级视图）
report/extraction_summary.md      可选  抽取摘要，显示在概览页
manifest.json                     可选  {"dataset_id": "...", "source": "...", "notes": "..."}

pages/                            可选  PDF 页面渲染图（bbox 叠加的底图）
schemes/                          可选  Scheme 高分辨率裁剪
molecule_crops/                   可选  单分子 OCSR 裁剪 ← 审核最依赖这个
moldet/                           可选  YOLO 检测框与叠图
evidence/                         可选  其它证据图
```

- 允许的后缀：`.png .jpg .jpeg .svg .json .md .csv .txt`，其它一律忽略。
- **压缩包可以有一层根目录**（直接把 workspace 文件夹打包即可），会自动剥掉。
- 不在上表里的文件会被丢弃，不会存进数据目录。
- 提交包里**不要**放原始 PDF、模型权重、`state/`、`source/` 这些内部产物。

### 图片路径怎么写

`dataset.json` 里的 `image_path` / `renders` 可以是绝对路径（流水线原样输出即可），
也可以是包内相对路径。服务端会做两件事：

- 能在包里找到对应文件的 → 改写成公开 URL；
- 找不到、或指向包外的（原始 PDF、别的机器上的权重）→ 置空并标 `_private_source`，
  **绝不会把服务器路径发给浏览器**。

引用了但包里没有的图片会在报告里列为警告（不阻塞导入），对应视图显示占位符。

---

## 3. `dataset.json` 的字段要求

当前有前端 adapter 的 schema 是 **`tse.dataset.v1`**。其它 `schema_version` 也**能存**，
但会被标记为「不支持的数据格式」，需要先给前端加一个 adapter
（`static/js/adapters/`，页面代码不用动）。

必须满足的约束（不满足就拒绝，报告里逐条列出）：

| 字段 | 要求 |
|---|---|
| `schema_version` | 必填字符串 |
| `compounds[].compound_uid` | 必填、唯一 |
| `reactions[].reaction_uid` | 必填、唯一 |
| `reactions[].reactants/products` | 里面的每个 uid 必须能在 `compounds` 里找到 |
| `alignments[].alignment_uid` | 唯一 |
| `alignments[].reaction_uid` | 必须能找到对应反应 |
| `evidence[].evidence_id` | 唯一 |
| `review_queue.items[].review_item_uid` | 唯一，且**不能以 `ADHOC:` 开头**（该前缀保留给审核员即席发起的审核项） |

会产生**警告但仍然导入**的情况：

- `schema_version` 没有 adapter；
- 引用的图片不在包里；
- 反应没有任何参与者；
- **原文引用回查不通过**（见下一节）；
- 没有任何化合物。

### 原文回查在提交时就会做

`alignments[]` 里的 `char_start` / `char_end` 会被拿去
`paper.documents[].pages[].text` 里重新切片，压缩空白后与 `text` 字段逐字比对。
比对通过的才会在审核界面显示绿色「已回查原文」。

提交报告里会给出 `source_verification: {checked, verified, unverified[]}`。
**`source_verified: true` 只是模型的自述，审核台不采信**——如果你的 offsets 对不上，
在这里就会看到，不用等审核员发现。

### 最小可用示例

```json
{
  "schema_version": "tse.dataset.v1",
  "run": { "paper_id": "MY_PAPER", "pipeline_state": "HUMAN_REVIEW", "target_compound_uid": "CMP_2" },
  "paper": { "paper_id": "MY_PAPER", "title": "…", "doi": "10.1021/…", "year": 2026, "documents": [] },
  "document_map": { "target_molecule": { "name": "…" }, "strategy_summary": "…" },
  "compounds": [
    { "compound_uid": "CMP_1", "labels": ["1"], "raw_smiles": "CCO",
      "structure_status": "validated", "confidence": 0.9,
      "identity": { "canonical_smiles": "CCO", "formula": "C2H6O" },
      "candidates": [], "mentions": [], "evidence_ids": [] }
  ],
  "reactions": [
    { "reaction_uid": "RXN_1", "reactants": ["CMP_1"], "products": ["CMP_2"],
      "conditions_raw": "PCC, DCM", "yield": null,
      "validation_status": "passed", "step_index": 0, "evidence_ids": [] }
  ],
  "procedures": [], "alignments": [], "evidence": [],
  "route_graph": { "nodes": [], "edges": [], "target_node_id": "CMP_2" },
  "issues": [], "validations": []
}
```

> 注意 `yield` / `temperature` / `time` 是**对象**不是标量：
> `{"value": 56.0, "raw_text": "56% yield over 2 steps", "normalization_status": "exact"}`。
> 审核界面同时显示 `value` 和 `raw_text`——两步收率被当成单步是这类抽取最典型的错误。

---

## 4. 四种提交方式

### 4.1 命令行：打包 + 上传（推荐）

```bash
# 在流水线那边打包（只挑审核需要的文件）
python scripts/ingest_workspace.py <workspace> --pack pkg.zip

# 先校验
curl -X POST "https://review.example.com/api/v1/ingest?dataset_id=MY_PAPER&dry_run=true" \
  -H "Content-Type: application/zip" \
  -H "X-Api-Key: $REVIEW_INGEST_TOKEN" \
  --data-binary @pkg.zip

# 确认无误后导入
curl -X POST "https://review.example.com/api/v1/ingest?dataset_id=MY_PAPER" \
  -H "Content-Type: application/zip" \
  -H "X-Api-Key: $REVIEW_INGEST_TOKEN" \
  -H "X-Submitted-By: pipeline@ci" \
  --data-binary @pkg.zip
```

**是原始 body，不是 multipart。** 这样服务端不需要额外依赖，
`curl --data-binary`、`requests.post(data=open(...,'rb'))`、浏览器 `fetch(body: file)` 都能直接用。

### 4.2 纯 JSON（没有图片）

```bash
curl -X POST "https://review.example.com/api/v1/ingest/json" \
  -H "Content-Type: application/json" \
  -d '{"dataset_id":"MY_PAPER","dataset":{…},"review_queue":{…}}'
```

适合快速灌一批只有结构式和反应的数据。审核界面会降级成「只有 SMILES 渲染、没有原图对照」——
能用，但**审核质量会明显下降**，因为审核的核心动作就是拿原图和模型读数对照。

### 4.3 本机目录（同一台机器）

```bash
python scripts/ingest_workspace.py <workspace>            # 导入
python scripts/ingest_workspace.py <workspace> --dry-run  # 只校验
python scripts/ingest_workspace.py <workspace> --force    # 覆盖同一 revision
python scripts/ingest_workspace.py --rebuild-catalog      # 只重建索引
```

走的是**同一套校验和安装代码**，命令行接受的包，HTTP 也接受，反之亦然。

### 4.4 浏览器

审核台左侧「提交数据」页：拖入 .zip → 先校验 → 看报告 → 导入 → 直接打开新数据集。

---

## 5. Python 客户端示例

```python
import requests

BASE = "https://review.example.com"
HEADERS = {"Content-Type": "application/zip", "X-Api-Key": TOKEN, "X-Submitted-By": "pipeline"}

with open("pkg.zip", "rb") as handle:
    package = handle.read()

# 1) 校验
report = requests.post(f"{BASE}/api/v1/ingest",
                       params={"dataset_id": "MY_PAPER", "dry_run": "true"},
                       headers=HEADERS, data=package).json()
if not report["ok"]:
    raise SystemExit("\n".join(report["errors"]))
for warning in report["warnings"]:
    print("WARN", warning)

# 2) 导入
result = requests.post(f"{BASE}/api/v1/ingest",
                       params={"dataset_id": "MY_PAPER"},
                       headers=HEADERS, data=package)
result.raise_for_status()
print(result.json()["revision"])
```

---

## 6. 响应

**成功导入 → `201`**

```json
{
  "ok": true,
  "installed": true,
  "dataset_id": "MY_PAPER",
  "revision": "e820d72694c6ed8e",
  "files": 45,
  "bytes": 6553600,
  "counts": { "compounds": 19, "reactions": 14, "alignments": 18,
              "evidence": 38, "issues": 5, "validations": 14, "review_items": 5 },
  "source_verification": { "checked": 18, "verified": 18, "unverified": [] },
  "missing_assets": [],
  "warnings": [],
  "errors": [],
  "catalog": { "…": "该数据集在目录中的完整条目" }
}
```

**校验通过但没写（dry_run 或 revision 已存在）→ `200`**，`installed: false`，
后者带 `message: "this revision is already present; pass force=true to reinstall"`。

**被拒绝 → `4xx`**，`detail` 里是同样结构的报告：

```json
{
  "detail": {
    "message": "submission failed validation",
    "errors": ["RXN_1.reactants references unknown compound CMP_MISSING"],
    "warnings": [],
    "counts": { "…": "…" }
  }
}
```

| 状态码 | 含义 |
|---|---|
| 201 | 已导入 |
| 200 | 校验通过但未写入（dry_run / 已存在同 revision） |
| 400 | 压缩包结构不安全（`..`、绝对路径）或 body 为空 |
| 401 | 需要 `X-Api-Key` 而没给或给错 |
| 413 | 超过上传 / 解压 / 文件数上限 |
| 422 | 校验未通过（字段缺失、uid 重复、引用悬空、不是 zip…） |
| 503 | 该部署关闭了提交接口 |

---

## 7. 安全与配额

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `REVIEW_INGEST_ENABLED` | `1` | 设 `0` 彻底关闭提交接口（只读部署） |
| `REVIEW_INGEST_TOKEN` | 空 | 设了就必须带 `X-Api-Key`，常数时间比较 |
| `REVIEW_INGEST_MAX_BYTES` | 512 MB | 单次上传上限 |
| `REVIEW_INGEST_MAX_UNCOMPRESSED_BYTES` | 2 GB | 解压后上限（防 zip bomb） |
| `REVIEW_INGEST_MAX_ENTRIES` | 20000 | 压缩包内文件数上限 |

服务端做的事：

- 拒绝 `..`、绝对路径、盘符开头的压缩包条目（zip slip）；
- 解压到临时目录，逐项校验，**通过之后才**原子地移进数据目录；
- 任何失败都会清空临时目录，不会留下半个数据集；
- 提交接口是唯一会写数据目录的入口，**上线前请务必设 `REVIEW_INGEST_TOKEN`**。

---

## 8. 更新已有数据集

- **重跑抽取后再提交**：内容变了 → 新 revision → 自动成为该数据集的当前版本，
  旧 revision 留在磁盘上（`available_revisions`），此前的审核事件仍绑定旧 revision，
  不会凭空「转移」到新版本上。
- **审核员正在审旧版本**：提交审核事件时带的 `If-Match` 与当前 revision 不符会返回 409，
  界面提示「数据集已重新抽取，请刷新后重审」。
- **同一 revision 想覆盖**（比如补了图片）：加 `force=true`。
