# 合成抽取审核台 · Synthesis Review

化学合成文献抽取结果的人工审核前端。它是一个**独立系统**：一份静态前端 + 一个
FastAPI 后端 + 一个自带的数据目录，跑起来不依赖抽取流水线的任何代码。

```
浏览器  ──►  FastAPI  ──►  data/datasets/{dataset_id}/{revision}/   （抽取结果，只读）
                       └►  data/review.sqlite3                      （审核事件，只追加）
```

核心原则：**抽取结果永远只读，人工判断永远只追加。** 服务端从不修改
`dataset.json`；每一次决定都是一条新事件，某个审核项的当前状态是它全部事件的折叠结果。

设计说明见 [docs/DESIGN_ZH.md](docs/DESIGN_ZH.md)，
提交格式见 [docs/SUBMISSION_FORMAT_ZH.md](docs/SUBMISSION_FORMAT_ZH.md)。

---

## 1. 五分钟跑起来

需要 Python 3.10+，`fastapi`、`uvicorn`，以及可选的 `rdkit`
（没有 RDKit 也能跑，结构图会降级成 OCSR 原图裁剪）。

```powershell
# 1. 导入一次抽取结果（把 workspace 复制进本项目的 data/）
python scripts/ingest_workspace.py E:\OSTE\paper-record-to-eln\workspaces\INELEGANOLIDE_MVP_V2

# 2. 启动
powershell -ExecutionPolicy Bypass -File .\start.ps1
#    或者： python -m uvicorn app.main:app --port 8770
```

打开 http://127.0.0.1:8770 。`start.ps1` 默认用 `chemistry` conda 环境
（那里有 RDKit），可用 `-Port`、`-Lan`、`-Reload` 调整。

跑测试：

```bash
python -m pytest tests -q
```

---

## 2. 提交新数据

三条路径，走的是**同一套校验和安装代码**。格式规范见
[docs/SUBMISSION_FORMAT_ZH.md](docs/SUBMISSION_FORMAT_ZH.md)，
机器可读版在 `GET /api/v1/ingest/spec`。

### 2.1 HTTP 提交（远程、CI、别的机器）

```bash
# 打包（在流水线那边）
python scripts/ingest_workspace.py <workspace> --pack pkg.zip

# 先校验，不写入
curl -X POST "http://127.0.0.1:8770/api/v1/ingest?dataset_id=MY_PAPER&dry_run=true" \
  -H "Content-Type: application/zip" --data-binary @pkg.zip

# 导入
curl -X POST "http://127.0.0.1:8770/api/v1/ingest?dataset_id=MY_PAPER" \
  -H "Content-Type: application/zip" -H "X-Submitted-By: pipeline@ci" \
  --data-binary @pkg.zip
```

原始 body，不是 multipart。没有图片时可以直接发 JSON：
`POST /api/v1/ingest/json`，body 为 `{"dataset_id": "...", "dataset": {...}}`。

### 2.2 浏览器提交

左侧「提交数据」页：拖入 .zip → 先校验 → 看报告 → 导入 → 一键打开新数据集。
catalog 为空时（全新部署）首页会直接跳到这里。

### 2.3 本机目录

```bash
python scripts/ingest_workspace.py <workspace>            # 导入
python scripts/ingest_workspace.py <workspace> --dry-run  # 只校验
python scripts/ingest_workspace.py <workspace> --force    # 覆盖同一 revision
python scripts/ingest_workspace.py --rebuild-catalog      # 只重建索引
```

### 2.4 提交时会发生什么

1. 解压到临时目录，拒绝 `..`、绝对路径、非白名单后缀，限制大小与文件数；
2. 校验结构与引用完整性（uid 唯一、反应参与者能解析、队列项 uid 唯一…）；
3. **重新回查每条原文引用**：用 `char_start/char_end` 去页面文本里切片比对，
   报告里给出 `verified/checked`——offsets 对不上在这一步就暴露，不用等审核员发现；
4. 校验通过后才原子地移进 `data/datasets/{dataset_id}/{revision}/`；
5. 重建 catalog 并清掉服务端缓存，**不需要重启**。

revision 由内容决定（`sha256(dataset.json)+sha256(review_queue.json)` 前 16 位），
所以重复提交同样的内容是幂等的：不会产生副本。`state/`、`source/`、原始 PDF 不会被复制。

## 3. 目录结构

```
synthesis-review/
├── app/                     后端（约 1200 行）
│   ├── config.py            全部配置来自环境变量
│   ├── storage.py           唯一的文件读取入口（换对象存储只改这里）
│   ├── bundle.py            catalog、bundle 装载、路径脱敏
│   ├── evidence.py          bbox 坐标换算（page_px / image_px → 图像比例）
│   ├── verify.py            用页面文本回查原文引用
│   ├── depict.py            RDKit 结构图（可选依赖）
│   ├── ingest.py            提交校验、暂存、原子安装、catalog 重建
│   ├── events.py            append-only 审核事件存储（SQLite）
│   └── main.py              HTTP 接口
├── static/                  前端（零构建，原生 ES modules）
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── app.js           hash 路由、主题、快捷键
│       ├── store.js         数据装载、索引、事件提交
│       ├── review.js        决策条（四类决定 + 更正编辑器）
│       ├── evidence.js      证据查看器（bbox 叠加、缩放、原文高亮）
│       ├── routemap.js      收敛路线的分层 DAG
│       ├── adapters/        schema_version → ViewModel
│       └── views/           各页面（含 submit.js 提交页）
├── scripts/ingest_workspace.py
├── docs/SUBMISSION_FORMAT_ZH.md   提交格式规范
├── schema/events_postgres.sql
├── data/                    数据目录（catalog + 数据集 + 事件库）
├── tests/
├── Dockerfile / docker-compose.yml / .env.example
└── start.ps1
```

---

## 4. 页面

| 页面 | 作用 |
|---|---|
| 概览 | 论文信息、实体计数、审核进度、目标分子、抽取摘要 |
| 审核队列 | 三栏工作台：队列 / 待判对象 / 证据。快捷键 `j` `k` `a` `x` `c` `d` `Enter` |
| 路线 | 分层 DAG（收敛支线并排），降级到 `report/route.svg` |
| 化合物 | 左「论文原图裁剪」右「RDKit 渲染」并排对照 + 候选列表 |
| 反应 | 反应式、条件、产率（含 raw_text）、确定性校验、原文对齐 |
| 原文对齐 | 反应与原文并排，提及词高亮，回查状态 |
| 质量 | 14 项校验 + 已知问题，可直达对应审核项 |
| 历史 | 每个审核项的完整事件时间线，可导出 JSONL |
| 提交数据 | 拖入 .zip 或粘贴 JSON，先校验再导入，含格式说明和 curl 示例 |

**证据查看器**不是独立页面，而是全局抽屉：任何地方点 `EV_xxxx` 都能打开页面图、
bbox 叠加、Scheme 裁剪和原文段落。

---

## 5. 两个值得单独说明的设计

### 5.1 队列只有 5 项，能审的有 51 件

`review_queue.json` 只收录被检测出问题的条目。真正要人看的是**每一个结构、
每一个反应、每一条对齐**。所以除了队列项，任何实体页面都能直接记录决定，
uid 形如 `ADHOC:compound:CMP_0003`，与队列项**共用同一套事件格式和同一个接口**。
概览页因此有两个进度：待办（队列）和覆盖率（实体）。

### 5.2 「已回查原文」是服务端算出来的，不是模型自称

`alignments[].source_verified` 是抽取模型对自己的评价，前端不用它。
服务端拿 `char_start/char_end` 去 `paper.json` 的页面文本里重新切片，
压缩空白后逐字比对，只有比对通过才显示绿色的「已回查原文」。
当前数据集 18 条对齐全部通过。

同理，bbox 叠加不接受任何「大概位置」：服务端把
`page_px @450dpi` 或 `image_px` 统一换算成**底图比例**再交给浏览器，
`bbox.raw`（`yxyx@1000` 归一化值）一律忽略。页面像素尺寸由
`width_pt × dpi / 72` 得出，不需要读图片头。

---

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | RDKit 是否可用、catalog、事件库是否可写 |
| GET | `/api/v1/catalog` | 数据集清单 |
| GET | `/api/v1/datasets/{id}` | 脱敏后的完整 bundle（`ETag: {revision}`） |
| GET | `/api/v1/datasets/{id}/review-items` | 队列项 + 当前状态 |
| GET | `/api/v1/datasets/{id}/compounds/{uid}` | 单个化合物 |
| GET | `/api/v1/datasets/{id}/reactions/{uid}` | 单个反应 |
| GET | `/api/v1/datasets/{id}/evidence/{id}` | 证据 + 底图 + bbox 比例 |
| GET | `/api/v1/datasets/{id}/alignments/{uid}/verify-source` | 服务端回查原文 |
| GET | `/api/v1/datasets/{id}/review-events` | 全部事件 + 折叠后的当前状态 |
| GET | `/api/v1/datasets/{id}/review-events/export.jsonl` | 导出 |
| POST | `/api/v1/datasets/{id}/review-events` | 追加事件 |
| GET | `/api/v1/render.svg?smiles=` | RDKit 结构图 |
| GET | `/api/v1/molecule?smiles=` | RDKit 描述符（更正框实时校验用） |
| GET | `/review-data/datasets/{id}/{revision}/{path}` | 数据集资产 |
| POST | `/api/v1/admin/reload` | 重建 catalog / bundle 缓存 |
| GET | `/api/v1/ingest/spec` | 提交格式规范（机器可读） |
| POST | `/api/v1/ingest` | 提交 zip 数据包（原始 body） |
| POST | `/api/v1/ingest/json` | 提交纯 JSON（无图片） |
| POST | `/api/v1/ingest/validate` | 只校验 JSON，不写入 |

提交事件：

```bash
curl -X POST http://127.0.0.1:8770/api/v1/datasets/INELEGANOLIDE_MVP_V2/review-events \
  -H 'Content-Type: application/json' \
  -H 'If-Match: e820d72694c6ed8e' \
  -H 'Idempotency-Key: 6f1c...' \
  -H 'X-Reviewer-Id: lpz' \
  -d '{"review_item_uid":"ADHOC:compound:CMP_0003","decision":"accepted"}'
```

- `If-Match` 与当前 revision 不符 → **409**（数据被重新抽取过，先刷新）；
- `Idempotency-Key` 重复 → **200** 返回首次写入的那条，不重复记录；
- `review_event_uid`、`reviewed_at`、`dataset_revision` 一律由服务端生成，客户端说了不算。

---

## 7. 部署到云端

### 7.1 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `REVIEW_DATA_DIR` | `./data` | 数据目录（云端挂卷或同步自对象存储） |
| `REVIEW_STATIC_DIR` | `./static` | 前端目录 |
| `REVIEW_ASSET_URL_PREFIX` | `/review-data/datasets` | 改成 CDN/桶地址即可不再由本进程发图 |
| `REVIEW_DATABASE_URL` | `sqlite:///<data>/review.sqlite3` | 事件库 |
| `REVIEW_DEFAULT_REVIEWER` | `anonymous` | 审核人兜底值 |
| `REVIEW_REQUIRE_REVIEWER` | `0` | 设 `1` 则拒绝未署名的事件 |
| `REVIEW_CORS_ORIGINS` | 空 | 前后端不同源时才需要 |
| `REVIEW_ASSET_MAX_AGE` | `86400` | 资产缓存秒数 |
| `REVIEW_INGEST_ENABLED` | `1` | 设 `0` 关闭提交接口（只读部署） |
| `REVIEW_INGEST_TOKEN` | 空 | 设了就必须带 `X-Api-Key` |
| `REVIEW_INGEST_MAX_BYTES` | 512 MB | 单次上传上限 |
| `REVIEW_INGEST_MAX_UNCOMPRESSED_BYTES` | 2 GB | 解压上限（防 zip bomb） |
| `REVIEW_INGEST_MAX_ENTRIES` | 20000 | 包内文件数上限 |

完整示例见 `.env.example`。

### 7.2 容器

```bash
docker compose up --build
# 在容器内导入数据（把 workspace 目录挂进去）
WORKSPACES_DIR=E:\OSTE\paper-record-to-eln\workspaces docker compose run --rm review \
  python scripts/ingest_workspace.py /workspaces/INELEGANOLIDE_MVP_V2
```

镜像不包含任何数据集，`/data` 是卷。

### 7.3 三种规模

**最小**：一台机器 + 一个卷。`docker compose up`，本地 SQLite 存事件，
资产由应用自己发。适合十来个人内部使用。

**中等**：应用容器（Cloud Run / ECS / 阿里云 ACK 都行）+ 对象存储 + 托管 Postgres。

1. 把 `data/datasets/` 整个同步到桶里（目录结构就是对象前缀，不用转换）：
   ```
   datasets/{dataset_id}/{revision}/data/dataset.json
   datasets/{dataset_id}/{revision}/pages/...
   ```
2. `REVIEW_ASSET_URL_PREFIX=https://cdn.example.com/datasets`，
   图片直接走 CDN，应用只发 JSON；
3. 事件库换 Postgres：先 `psql -f schema/events_postgres.sql`，
   再设 `REVIEW_DATABASE_URL`（需要给 `app/events.py` 加一个 psycopg 版
   store 类，表结构已经对齐，SQLite 导出的 JSONL 可以直接灌进去）；
4. 前端可以整个丢到 CDN，只要设 `REVIEW_CORS_ORIGINS`。

**私有资产**：原始 PDF 和未公开证据放私有桶，由后端按用户权限签发短时 URL——
`app/storage.py` 的 `asset_url()` 就是这个签名函数的落点。

### 7.4 上线前必须做的两件事

1. **加身份验证。** 现在没有任何鉴权，任何能访问的人都能提交审核事件。
   放在反向代理后面（OAuth2 Proxy / Cloudflare Access）是最省事的做法，
   然后设 `REVIEW_REQUIRE_REVIEWER=1`，并把 `reviewer_id` 改成从 token 取。
   **提交接口另外设 `REVIEW_INGEST_TOKEN`**——它是唯一会写数据目录的入口。
2. **给事件库配备份。** 抽取结果可以重跑，人工判断不能。

---

## 8. 已知限制

1. **没有身份验证**（见上）。
2. **事件折叠在读时做**：事件量到十万级要加索引或物化视图（Postgres 侧已经准备了
   `review_item_state` 视图）。
3. **单进程内存缓存**：catalog / bundle 按 mtime 失效，多副本部署时各自缓存，
   导入新数据后各副本需要各自 `POST /api/v1/admin/reload`（或滚动重启）。
4. **`conditions_raw` 没有结构化**：更正表单写进 `corrected_value`，不回写原字段。
5. **未知 schema 不做猜测**：catalog 里出现没有 adapter 的 `schema_version` 时，
   前端显示「不支持的数据格式」并列出已支持的格式。
