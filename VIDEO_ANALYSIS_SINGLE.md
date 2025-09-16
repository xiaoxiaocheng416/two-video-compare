# VIDEO_ANALYSIS_SINGLE.md

单视频分析成功链路技术说明（供 Compare A/B 直接复用）。本文仅覆盖“成功路径”，不涉及批次/队列。

## Overview

- 入口方式
  - `POST /api/videos/analyze_url`（URL 分析）
  - `POST /api/videos/upload`（文件分析）
- 数据流
  - URL/文件 →（URL：先下载并缓存）→（可选 sanitize）→ base64 → Gemini（prompt + inlineData）→ JSON 解析与结构校验 → 响应（含可播地址 `meta.playable_url`）
- 运行环境
  - Node.js 18+（服务端使用全局 Fetch/FormData/Blob）
  - Linux/macOS/容器均可（需可用 `ffmpeg` 与 `yt-dlp`）
  - 默认端口：`PORT=5001`

## Env & Deps

- 环境变量（必须）
  - `GEMINI_API_KEY`：Google Gemini API 密钥
  - `VIDEO_CACHE_DIR`：视频缓存根目录（默认：`/var/tmp/video-cache`）
  - `PUBLIC_API_ORIGIN`：对外基址，用于生成 `meta.playable_url`（例：`https://api.example.com`）
  - `PORT`：服务监听端口（默认：`5001`）
  - 可选：`SANITIZE_VIDEO`（默认启用；非 `false` 即启用）
- 二进制依赖
  - `ffmpeg`（要求支持 mp4 stream copy、`-movflags +faststart`）
  - `yt-dlp`（通过 `yt-dlp-exec` 提供；项目内绝对路径：`backend/node_modules/yt-dlp-exec/bin/yt-dlp`）
  - 安装：容器/Debian/Ubuntu 可通过 `apt-get install -y ffmpeg`；`yt-dlp` 随 npm 依赖安装
- NPM 依赖与版本（后端）
  - `@google/generative-ai@^0.21.0`、`multer`、`yt-dlp-exec`

## API Contracts

### POST /api/videos/analyze_url（URL 分析）

- 请求体

```json
{ "url": "https://www.tiktok.com/@name/video/1234567890" }
```

- 规则
  - 仅允许 `*.tiktok.com`、`vt.tiktok.com` 域名
  - 先用 `yt-dlp` 获取 metadata 估算体积；若估算体积 > 50MB 直接拒绝
  - 成功则下载到本地缓存，随后读入并调用 Gemini

- 成功响应（字段）
  - `meta.*`：`platform|durationSec|filesize|tiktok_id|playable_url|hls_url|poster_url|fallback_embed|expires_at|diagnostics{...}`
  - `analysisResult.raw_response`（Gemini 原始 JSON 文本）
  - `analysisResult.parsed_data`（结构化 JSON，见“输出 Schema”）
  - `analysisResult.validation_status`（结构校验标记）
  - `analysisResult.metadata.analysis_time`（毫秒，端到端模型处理耗时）

- 错误枚举（仅列成功链路相关的可复现场景说明）
  - `INVALID_URL`（400）：URL 缺失/解析失败
  - `UNSUPPORTED_HOST`（415）：域名不在白名单
  - `TOO_LARGE`（413）：估算体积超限（>50MB）
  - `UPSTREAM_TIMEOUT`（504）：下载超时（60s）
  - `DOWNLOAD_FAILED`（422）：下载失败（非超时）

- cURL 示例

```bash
export HOST=http://localhost:5001
curl -X POST "$HOST/api/videos/analyze_url" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@name/video/1234567890123456789"}'
```

### POST /api/videos/upload（文件分析）

- 请求
  - 表单字段名：`video`
  - 单文件体积上限：50MB（内存接收）
  - 成功/失败响应结构与字段同上（无 `ok` 字段，直接返回 `analysisResult{...}`）

- cURL 示例

```bash
export HOST=http://localhost:5001
curl -X POST "$HOST/api/videos/upload" \
  -F "video=@/path/to/video.mp4"
```

## Gemini 调用细节（核心）

- 模型与配置

```js
// videoanalyzersimple/backend/controllers/videoController.js
// upload: ~533–575；url: ~915–941
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-pro",
  generationConfig: {
    temperature: 0.4,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: "application/json" // 强制 JSON 输出
  }
});
```

- 消息构造

```js
// 第一段：系统/任务 prompt（getTikTokShopPrompt()，~148–516）
const prompt = getTikTokShopPrompt();
// 第二段：视频内容（base64 inlineData）
const result = await model.generateContent([
  { text: prompt },
  { inlineData: { mimeType: 'video/mp4', data: base64Video } }
]);
const rawText = result.response.text();
```

- 解析与容错
  - 去除 ```json 包裹后再 `JSON.parse`；
  - 结构校验：缺失字段列入 `validation_status.missing_fields`；
  - 时间戳修正：`t_start <= t_end`、clamp 到 `[0,300]`，phase 缺失时按片段猜测；
  - 标准化 `severity` 枚举与 `meta.playable_url` 字段名（下游统一消费）。

## 下载/清洗/缓存策略（仅 URL 流程）

- 估算体积：调用 `yt-dlp` 获取 metadata，若 `> 50MB` → 直接返回 `413 TOO_LARGE`
- 下载到缓存：
  - 代码：`backend/utils/videoCacheManager.js`
  - 60s 超时（`execAsync(..., { timeout: 60000 })`）
  - 成功写入：`VIDEO_CACHE_DIR/<token>.mp4`，返回 `playableUrl: /media/<token>`
  - TTL：默认 24h；失败缓存 TTL：30min；LRU 总量限制：默认 5GB
- 可播 URL：
  - 标准生成：`meta.playable_url = {PUBLIC_API_ORIGIN}/media/{token}`（带 Range 支持）
  - 媒体流：`GET /media/:id`（`backend/controllers/mediaController.js`）
- sanitize（不重编码）
  - `ffmpeg -map 0:v:0 -map 0:a:0? -dn -sn -map_chapters -1 -c copy -map_metadata -1 -movflags +faststart`
  - 仅变更封装与 moov 位置，视频/音频码流不变；剥离容器元数据

## 输出 Schema（我们会消费的字段）

- `analysisResult.parsed_data`（核心消费）
  - `overview{ grade, score, confidence, summary, main_issue }`
  - `pillars{ hook_0_3s, display_clarity, creator_trust, cta_effectiveness }`
  - `timeline[4]`：固定四段（`hook → trust → desire → cta`），字段：`segment|phase|t_start|t_end|score|spoken_excerpt|screen_text|visual_cue|product_visible|severity|ceiling_rules_triggered[]|pillar_contrib{...}|issue|risk|fix_hint`
  - `recommendations[3]`：问题/解决/示例口播
  - 可选：`forecast{ views_range, gmv_range, pass_probability }`、`data_quality{ completeness, widen_factor, notes[] }`
- `meta.playable_url`
  - 对 Compare 非必需；若为空/不可达，Compare 仍可直接消费 `parsed_data` 文本结构

## 错误码与超时

- URL 分析错误码与 HTTP 映射
  - `INVALID_URL` → 400
  - `UNSUPPORTED_HOST` → 415
  - `TOO_LARGE` → 413（估算 > 50MB）
  - `UPSTREAM_TIMEOUT` → 504（下载超时 60s）
  - `DOWNLOAD_FAILED` → 422（下载失败）
- 模型调用超时/重试
  - 服务器端未显式设置模型超时与重试（建议由上游网关/调用方控制）
  - 前端单视频页 XHR 设置了 120s 超时（此处仅记录，不影响 Compare）

## 日志与排障

- 关键打点
  - 开始下载/完成（URL）
  - sanitize 开始/结束（是否变更）
  - Gemini 调用开始/结束
  - JSON 解析成功/失败（缺失字段列表）
  - 总耗时（`analysisResult.metadata.analysis_time`）
- 诊断接口（可选建议）
  - 可新增 `GET /api/diag/gemini`：调用一次空载模型返回 `{ ok, model, latencyMs }`

## 对接 Compare 的最小映射

- 目标：Compare 仅消费结构化 JSON，不依赖播放器。
- 映射规则（单视频 → 5 Tabs）
  - `summary`：来自 `parsed_data.overview.summary`（附 `grade/score/confidence`）
  - `perVideo.A|B`：
    - `pillars` 四维、`flags`、`overview.main_issue`
    - `recommendations[0..2]`（按严重度/优先级排序）
  - `diff[]`：A/B 的 `pillars` 差异、`flags` 差异、`overview.score` 差异
  - `actions[3]`：来自各自 `recommendations` 的前三条（去重合并）
  - `timeline[≤8]`：拼接 A/B 的四段时间线（总计 ≤8 段）

## 关键代码位置与行号（便于检索）

- 入口路由：`videoanalyzersimple/backend/server.js`
  - `/api/videos/upload`（行 43）
  - `/api/videos/analyze_url`（行 44）
  - `/media/:id`（行 49）
  - 端口启动/日志（行 70–83）
- 控制器：`videoanalyzersimple/backend/controllers/videoController.js`
  - 上传分析：`exports.uploadVideo`（约 520–750）
    - Gemini 调用：行 533–575（`getGenerativeModel` & `generateContent`）
    - JSON 解析与校验：行 584–668
    - 响应与 `meta.playable_url` 回填：行 670–717
  - URL 分析：`exports.analyzeUrl`（约 720–1320）
    - sanitize/读取：行 900–911
    - Gemini 调用：行 915–941（`generateContent`）
    - JSON 解析与校验：行 950–1010
- 下载/缓存：`videoanalyzersimple/backend/utils/videoCacheManager.js`
  - `downloadVideo()`：行 62–108（60s 超时）
  - `getOrDownloadVideo()`：行 110–187（缓存命中/落地/TTL）
- 清洗：`videoanalyzersimple/backend/utils/sanitizeVideo.js`
  - `sanitizeVideo()`：行 17–26（ffmpeg 参数，stream copy）
- 媒体流：`videoanalyzersimple/backend/controllers/mediaController.js`（Range 支持）

## 可复现的 cURL（2 条）

```bash
export HOST=http://localhost:5001

# 1) URL 分析
curl -X POST "$HOST/api/videos/analyze_url" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@name/video/1234567890123456789"}'

# 2) 文件上传分析
curl -X POST "$HOST/api/videos/upload" \
  -F "video=@/path/to/video.mp4"
```

## 成功响应示例（精简但完整字段）

```json
{
  "ok": true,
  "source": "url",
  "meta": {
    "platform": "tiktok",
    "durationSec": 28,
    "filesize": 14234567,
    "tiktok_id": "1234567890123456789",
    "playable_url": "http://localhost:5001/media/abcdEfghIjklMnop",
    "hls_url": null,
    "poster_url": null,
    "fallback_embed": "https://www.tiktok.com/embed/v2/1234567890123456789",
    "expires_at": "2025-09-13T10:00:00.000Z",
    "diagnostics": {
      "strategy": "self-hosted",
      "cache_hit": false,
      "storage": "local",
      "sanitized": true,
      "ffmpeg": "map 0:v:0 0:a:0? -dn -sn -map_chapters -1 -c copy -map_metadata -1 -movflags +faststart",
      "source_meta_removed": true
    }
  },
  "analysisResult": {
    "raw_response": "{...Gemini JSON string...}",
    "full_analysis": "{...Gemini JSON string...}",
    "parsed_data": {
      "overview": { "grade": "A", "score": 84, "confidence": "85%", "summary": "Short summary.", "main_issue": "Hook could be stronger." },
      "pillars": { "hook_0_3s": 8, "display_clarity": 8, "creator_trust": 7, "cta_effectiveness": 8 },
      "flags": { "fatal_flaw": false, "upper_bound_c": false, "upper_bound_b": false, "penalties": [] },
      "three_dimensional": {
        "market_saturation": { "score": 6, "level": "mid", "reason": "Moderate competition." },
        "product_potential": { "grade": "A", "reason": "Clear visual value." },
        "creator_performance": { "score": 7, "strengths": ["Clear speech"], "weaknesses": ["Lighting"] }
      },
      "timeline": [
        { "segment": "0-3s", "phase": "hook",   "t_start": 0,  "t_end": 3,  "score": 8, "spoken_excerpt": "...", "screen_text": "...", "visual_cue": "...", "product_visible": true,  "severity": "none",   "ceiling_rules_triggered": [], "pillar_contrib": { "hook_0_3s": 8, "display_clarity": 2, "creator_trust": 1, "cta_effectiveness": 0 }, "issue": "", "risk": "", "fix_hint": "" },
        { "segment": "3-12s", "phase": "trust",  "t_start": 3,  "t_end": 12, "score": 8, "spoken_excerpt": "...", "screen_text": "...", "visual_cue": "...", "product_visible": true,  "severity": "none",   "ceiling_rules_triggered": [], "pillar_contrib": { "hook_0_3s": 0, "display_clarity": 5, "creator_trust": 2, "cta_effectiveness": 0 }, "issue": "", "risk": "", "fix_hint": "" },
        { "segment": "12-22s","phase": "desire", "t_start": 12, "t_end": 22, "score": 8, "spoken_excerpt": "...", "screen_text": "...", "visual_cue": "...", "product_visible": true,  "severity": "minor",  "ceiling_rules_triggered": [], "pillar_contrib": { "hook_0_3s": 0, "display_clarity": 3, "creator_trust": 3, "cta_effectiveness": 1 }, "issue": "", "risk": "", "fix_hint": "" },
        { "segment": "22-28s","phase": "cta",    "t_start": 22, "t_end": 28, "score": 7, "spoken_excerpt": "...", "screen_text": "...", "visual_cue": "...", "product_visible": true,  "severity": "none",   "ceiling_rules_triggered": [], "pillar_contrib": { "hook_0_3s": 0, "display_clarity": 0, "creator_trust": 1, "cta_effectiveness": 6 }, "issue": "", "risk": "", "fix_hint": "" }
      ],
      "recommendations": [
        { "problem": "Hook lacks novelty.", "solution": "Use curiosity opener.", "examples": { "oral": [ { "text": "Wait till you see this...", "source": { "type": "curiosity", "key": "you_wont_believe" } } ] } },
        { "problem": "Trust cues thin.", "solution": "Add before/after proof.", "examples": { "oral": [ { "text": "Watch what happens when...", "source": { "type": "authenticity", "key": "demo" } } ] } },
        { "problem": "CTA soft.", "solution": "Add urgency.", "examples": { "oral": [ { "text": "I'll drop the sale link below!", "source": { "type": "cta.urgency", "key": "sale" } } ] } }
      ],
      "forecast": { "views_range": "10k–50k", "gmv_range": "$100–$500", "pass_probability": "30%" },
      "data_quality": { "completeness": 0.8, "widen_factor": 1, "notes": [] }
    },
    "validation_status": { "is_valid_json": true, "is_complete_structure": true, "missing_fields": [], "has_actual_scores": true },
    "metadata": { "filename": "download.mp4", "filesize": 14234567, "mimetype": "video/mp4", "analysis_time": 12234, "timestamp": "2025-09-13T10:00:00.000Z" },
    "controller_meta": { "prompt_version": "v2.1", "prompt_hash": "abcdef123456", "recs_len": 3 }
  }
}
```

## 失败响应示例（含错误码）

URL 估算体积超限（>50MB）：

```http
HTTP/1.1 413 Payload Too Large
Content-Type: application/json

{
  "ok": false,
  "code": "TOO_LARGE",
  "limit": 52428800,
  "est": 73400320
}
```

> 其他错误：
> - `INVALID_URL`(400), `UNSUPPORTED_HOST`(415)
> - `UPSTREAM_TIMEOUT`(504), `DOWNLOAD_FAILED`(422)

## 我们需要你确认/写清楚的点（现状）

- 模型固定：`gemini-2.5-pro`，`responseMimeType="application/json"` 已启用
- sanitize 命令：如上所列（stream copy，不重编码；仅容器级变更与 moov 位置提前）
- URL 下载超时：60s；超时返回 `504 UPSTREAM_TIMEOUT`；其它下载错误返回 `422 DOWNLOAD_FAILED`
- `meta.playable_url`：
  - URL 流程：缓存带 TTL（默认 24h）；
  - 上传流程：注册到缓存目录（无额外 TTL 索引；实际可长期保留，建议视容量清理）；
  - Compare 可忽略播放器，仅消费结构化 JSON。

---

如需补充 `/api/videos/compare` 聚合端点，我们可基于上述两条接口在后端串/并行调用后按“对接 Compare 的最小映射”统一返回结构化结果。

