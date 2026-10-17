# 📷 Moments · AI 朋友圈选图

把一次出行的照片批量导入网页，AI（识图 LLM）帮你挑出发朋友圈的 Top N 并说明理由，后续还会支持二次构图裁剪、文案生成、九宫格预览。

## 功能状态

**已实现（对应 AC Plan M0~M3）**

- 用户系统：注册 / 登录 / 登出，JWT 鉴权，数据按用户隔离（越权 404），登录接口防爆破限速
- 照片导入：拖拽/选择批量上传（≤30 张/会话），HEIC/HEIF 自动转码，EXIF 方向纠正与拍摄时间解析（无 EXIF 回退文件时间），sha256 重复去重，GPS 等隐私元数据不保留
- AI 分析：压缩图（长边 1024）送模型，结构化输出（score/tags/issues/中文评语）+ JSON Schema 校验 + 纠错重试，429 指数退避，全局并发闸，进度轮询，可取消，失败可重跑
- 相似聚类：拍摄时间间隔 ≤2s 或 pHash 相似自动归组（本地计算，零模型成本），同组最多推荐 1 张
- AI 挑图：Top N 推荐（默认 9）+ 入选理由 + 落选原因分类（重复/质量问题/内容平淡）
- 二次构图：AI 裁剪建议（比例 + 归一化裁剪框 + 构图理由），服务端硬校验（框进画面/比例精确/面积 ≥20%，非法降级居中），画布拖拽/角部缩放微调，按原图坐标导出
- AI 文案：按风格（混合/简洁/文艺/搞笑）出 3 条候选，可编辑、一键复制，随导出打包 caption.txt
- 排版预览：1/3/4/9 朋友圈模板，拖拽或点选交换顺序，空位占位提示，按排版顺序导出
- 用量统计：每次模型调用的 token 消耗记录与展示，配置单价后折算费用估算
- 多供应商：统一 OpenAI-compatible 抽象，内置 Mock（无 Key 也能跑通全流程）、智谱 GLM、OpenAI、自定义兼容端点，连通性测试接口
- 工程化：模型调用接口限速 + 每用户每日 token 配额（`DAILY_TOKEN_LIMIT`，防烧 Key）、数据库版本化迁移（升级不丢数据）、失败照片可单独重试 / 批量重试未完成项、错误响应不透传供应商细节、GitHub Actions CI
- 体验：上传进度条、会话管理（列表 / 切换 / 重命名 / 删除）、挑图结果 👍/👎 反馈落库、批量构图可取消且进度重启后可查、按排版顺序导出单张九宫格拼图
- 部署：Dockerfile + docker-compose + Caddy 自动 HTTPS

## 本地开发

要求：Node 22+（原生 ESM + fetch）。

```bash
npm install
npm run dev        # 同时启动 API(8787) 与前端(5173)
```

打开 http://localhost:5173 ，注册一个账号即可。没配任何模型 Key 时会默认使用 **Mock** 供应商，可完整体验导入→分析→挑图流程。

配置真实模型：把 Key 填进项目**根目录 `.env`**（本地 dev 与 Docker 都会读取），重启后在**前端右上角切换供应商**再点分析。

```bash
# .env（已在 .env.example 中列出全部变量）
ZHIPU_API_KEY=your-key
# 可选：ZHIPU_MODELS=glm-4.5v,glm-4v-plus
```

注意：
- 本地 dev（`npm run dev`）会在启动时加载根目录或 `server/` 下的 `.env`，不覆盖 shell/Docker 已注入的变量；
- **已创建的会话会记住当时的供应商**，新配置生效后需在右上角下拉切到新供应商再分析；
- 登录/注册等接口的限速、`REGISTER_ENABLED` 等开关同样来自该文件；
- `DAILY_TOKEN_LIMIT` 可限制每用户每日消耗的模型 token（0 = 不限制），达到后模型调用返回 429——用真实 Key 时建议配上；
- **二次构图建议有诊断日志**：dev 时看 `npm run dev` 的 api 输出里 `[crop-suggest]` 开头的行，Docker 用 `docker compose logs -f app | grep crop-suggest`。里面记录模型原始返回（`rawData`）、是否给出主体坐标（`subject`）、服务端采纳了哪个中心（`boxSource`）与最终裁剪框（`finalBox`）——建议框不合理时用它定位是模型语义问题还是几何问题。

## 云服务器部署

```bash
cp .env.example .env
# 编辑 .env：DOMAIN=你的域名，JWT_SECRET=openssl rand -hex 32，填入模型 Key，REGISTER_ENABLED 按需
docker compose up -d --build
```

Caddy 会自动申请 Let's Encrypt 证书，`http://域名` 301 跳转 `https://域名`。数据落在 named volume `app-data`，容器重建不丢。

## 测试

测试体系分四层（全部基于 Vitest，E2E 基于 Playwright）：

```bash
npm test              # 后端单元 + 集成测试 & 前端测试
npm run test:server   # 仅后端（server/test/unit + server/test/integration）
npm run test:web      # 仅前端（web/test）
npm run test:e2e      # Playwright 全流程（自动拉起 API 与前端 dev server）
```

首次运行 E2E 需要安装浏览器：`npx playwright install chromium`。

| 层 | 位置 | 说明 |
|---|---|---|
| 后端单元 | `server/test/unit/` | 纯函数：裁剪框硬校验（cropBox）、JSON Schema、pHash/EXIF 图片处理、Mock 供应商、供应商注册表、JWT 鉴权、**数据库迁移、OpenAI 客户端（429 退避 / 400 降级 / JSON 提取）、配额、错误归类** |
| 后端集成 | `server/test/integration/` | fastify.inject + 独立临时 SQLite（每文件一个进程），覆盖注册/登录/限速/越权 404/上传去重/限额/分析管线/挑图聚类/文案/裁剪/用量/导出 zip，**以及日配额 429、增量分析与单张重试、挑图反馈、九宫格拼图导出、构图进度与取消、会话管理** |
| 前端 | `web/test/` | 裁剪几何计算（crop.ts）、API 封装（鉴权头、401 跳转、错误处理、XHR 上传进度） |
| E2E | `e2e/` | 真实浏览器走 Mock 供应商全流程：注册→导入→分析→挑图→构图建议→导出 zip，**以及分析取消、挑图反馈刷新后保持** |

集成测试说明：`server/test/setup.ts` 为每个测试文件创建独立临时 `DATA_DIR`（`pool: 'forks'` 进程隔离）；`buildApp` 支持关闭限速以便常规用例不被 10 次/分钟的注册限流打断（限速行为由 `auth.rate-limit.test.ts` 单独覆盖）。CI（`.github/workflows/ci.yml`）在 Node 22 上执行 install → build → 后端测试 → 前端测试 → Playwright。

## API 概览

```
POST /api/auth/register|login      GET /api/auth/me     POST /api/auth/logout
GET  /api/providers                POST /api/providers/:id/test
POST /api/sessions                 GET  /api/sessions（含 title/photoCount）
PATCH /api/sessions/:id            {title} 重命名
POST /api/sessions/:id/photos      (multipart, files=多文件)
POST /api/sessions/:id/analyze     {provider, model, photoIds?, retryFailed?}
POST /api/sessions/:id/analyze/cancel
GET  /api/sessions/:id/progress
POST /api/sessions/:id/select      {n}
POST /api/photos/:id/analyze       单张重试（同步返回结果）
PUT  /api/photos/:id/feedback      {feedback: 1|-1|0}
POST /api/photos/:id/crop-suggest  PUT /api/photos/:id/crop
POST /api/sessions/:id/crop-suggest    POST /api/sessions/:id/crop-suggest/cancel
GET  /api/sessions/:id/crop-progress
POST /api/sessions/:id/caption     {style, note, photoIds}   PUT /api/sessions/:id/caption
POST /api/sessions/:id/export      {photoIds 按排版顺序}
POST /api/sessions/:id/export-grid {photoIds, cols, cell, gap}  → 单张九宫格大图
GET  /api/photos/:id/thumb|image   GET  /api/sessions/:id/usage
```

除 register/login/config 外均需 `Authorization: Bearer <token>`。会触发模型调用的接口（analyze / crop-suggest / caption）额外受**限速**与**每用户每日 token 配额**（`DAILY_TOKEN_LIMIT`）约束，超限返回 429。
