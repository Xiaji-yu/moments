# 📷 Moments · AI 朋友圈选图

把一次出行的照片批量导入网页，AI（识图 LLM）帮你挑出发朋友圈的 Top N 并说明理由，后续还会支持二次构图裁剪、文案生成、九宫格预览。

## 功能状态

**已实现（对应 AC Plan M0/M1 主体）**

- 用户系统：注册 / 登录 / 登出，JWT 鉴权，数据按用户隔离（越权 404），登录接口防爆破限速
- 照片导入：拖拽/选择批量上传（≤30 张/会话），HEIC/HEIF 自动转码，EXIF 方向纠正与拍摄时间解析（无 EXIF 回退文件时间），sha256 重复去重，GPS 等隐私元数据不保留
- AI 分析：压缩图（长边 1024）送模型，结构化输出（score/tags/issues/中文评语）+ JSON Schema 校验 + 纠错重试，429 指数退避，全局并发闸，进度轮询，可取消，失败可重跑
- 相似聚类：拍摄时间间隔 ≤2s 或 pHash 相似自动归组（本地计算，零模型成本），同组最多推荐 1 张
- AI 挑图：Top N 推荐（默认 9）+ 入选理由 + 落选原因分类（重复/质量问题/内容平淡）
- 多供应商：统一 OpenAI-compatible 抽象，内置 Mock（无 Key 也能跑通全流程）、智谱 GLM、OpenAI、自定义兼容端点，连通性测试接口
- 部署：Dockerfile + docker-compose + Caddy 自动 HTTPS

**计划中（AC Plan M2/M3）**

- 二次构图：AI 裁剪建议（比例 + 裁剪框 + 构图理由）+ 画布微调 + 按原图坐标导出
- AI 文案生成（按风格出 3 条候选）
- 九宫格排版预览、拖拽排序、打包导出 zip
- 每用户存储配额、修改密码

## 本地开发

要求：Node 22+（原生 ESM + fetch）。

```bash
npm install
npm run dev        # 同时启动 API(8787) 与前端(5173)
```

打开 http://localhost:5173 ，注册一个账号即可。没配任何模型 Key 时会默认使用 **Mock** 供应商，可完整体验导入→分析→挑图流程。

配置真实模型：复制 `.env.example` 为 `server/.env`（或直接设置环境变量），填入 `ZHIPU_API_KEY` / `OPENAI_API_KEY` 等，重启后在前端右上角切换供应商。

```bash
# server/.env
ZHIPU_API_KEY=your-key
```

## 云服务器部署

```bash
cp .env.example .env
# 编辑 .env：DOMAIN=你的域名，JWT_SECRET=openssl rand -hex 32，填入模型 Key，REGISTER_ENABLED 按需
docker compose up -d --build
```

Caddy 会自动申请 Let's Encrypt 证书，`http://域名` 301 跳转 `https://域名`。数据落在 named volume `app-data`，容器重建不丢。

## API 概览

```
POST /api/auth/register|login      GET /api/auth/me     POST /api/auth/logout
GET  /api/providers                POST /api/providers/:id/test
POST /api/sessions                 GET  /api/sessions/:id
POST /api/sessions/:id/photos      (multipart, files=多文件)
POST /api/sessions/:id/analyze     {provider, model}
POST /api/sessions/:id/analyze/cancel
GET  /api/sessions/:id/progress
POST /api/sessions/:id/select      {n}
GET  /api/photos/:id/thumb|image
```

除 register/login/config 外均需 `Authorization: Bearer <token>`。
