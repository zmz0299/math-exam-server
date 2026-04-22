const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { analyzeRateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// In-memory job store: jobId -> { status, data?, message? }
const jobs = new Map();

// Clean up jobs older than 15 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

const SYSTEM_PROMPT =
  '你是一名中国高考数学试卷诊断与提分分析助手，熟悉全国高考数学命题逻辑、试卷架构、常见设问方式、' +
  '知识点分布规律和高三冲刺阶段的提分策略。你的任务是帮助学生查漏补缺、识别高频考法、理解命题意图、' +
  '抓住最值得补的分数点。请始终围绕"有限时间内如何更高效提分"来分析试卷。' +
  '严格按照指定 JSON 格式返回分析结果，不要输出任何其他内容。';

const USER_INSTRUCTION = `请对这份高中数学试卷进行深度诊断分析，从命题逻辑和提分策略角度输出。
注意：必须分析图片中每一道题，一道不能跳过。每个字段用精炼语言表达，去除废话，但保证准确性和教学价值。solution字段分步说明但每步一句话。
返回如下 JSON 格式（只输出 JSON，不含 markdown 代码块）：
{
  "summary": {
    "totalQuestions": <题目总数>,
    "totalScore": <总分>,
    "examType": "<试卷类型，如：高考全国卷模拟、月考卷、专项练习卷等>"
  },
  "questions": [
    {
      "id": <题号，整数>,
      "type": "<选择题/填空题/解答题>",
      "score": <分值>,
      "brief": "<题目核心内容一句话概括>",
      "mainKnowledge": "<主要知识点，贴近高考体系，如：三角函数、导数应用、解析几何等>",
      "subKnowledge": "<次要知识点，无则为空字符串>",
      "module": "<基础分题/中档提分题/压轴拔高题>",
      "difficulty": "<简单/中等/较难/困难>",
      "intent": "<命题意图：出题人为什么这样出、想筛选什么水平的学生，1-2句>",
      "coreAbility": "<核心考查能力，如：计算准确性/数形结合/分类讨论/转化与化归/阅读建模等>",
      "entryPoint": "<解题切入点，1句，直接告诉学生从哪里突破>",
      "solution": "<详细解题思路，分步说明，如：第一步...；第二步...；最终...>",
      "commonMistakes": "<常见失分原因，1-2句，指出学生最容易犯的错误>",
      "value": "<提分价值：低/中/高>",
      "recommend": <是否建议重点复盘：true/false>
    }
  ],
  "structure": {
    "type": "<卷型判断，如：综合能力型/基础巩固型/压轴拔高型>",
    "reason": "<判断依据，1-2句>",
    "basicCount": <基础分题数量>,
    "mediumCount": <中档提分题数量>,
    "hardCount": <压轴拔高题数量>,
    "unitDistribution": {
      "<知识单元名>": <该单元题目占总题数百分比，整数>
    }
  },
  "knowledgeStats": [
    { "name": "<知识点>", "count": <出现题目数量> }
  ],
  "highFreqPoints": ["<高频核心考点1>", "<高频核心考点2>", "<高频核心考点3>"],
  "examStyle": "<偏基础/综合能力/技巧性/压轴能力>",
  "coreAbilities": ["<命题人看重的能力1>", "<命题人看重的能力2>", "<命题人看重的能力3>"],
  "topReviews": [
    {
      "direction": "<查漏补缺方向名称>",
      "reason": "<为何优先补这个，1句，聚焦提分效益>",
      "questions": [<相关题号列表，整数数组>]
    }
  ],
  "weakPoints": [
    {
      "topic": "<薄弱考点名称>",
      "priority": "<高/中/低>",
      "suggestion": "<针对性建议，1-2句>"
    }
  ]
}`;

function detectMediaType(base64String) {
  if (base64String.startsWith('data:image/png')) return 'image/png';
  if (base64String.startsWith('data:image/gif')) return 'image/gif';
  if (base64String.startsWith('data:image/webp')) return 'image/webp';
  return 'image/jpeg';
}

function stripDataUri(base64String) {
  const idx = base64String.indexOf(',');
  return idx !== -1 ? base64String.slice(idx + 1) : base64String;
}

function estimateBytes(base64String) {
  const data = stripDataUri(base64String);
  return Math.ceil((data.length * 3) / 4);
}

// Run analysis in background — no HTTP response timeout risk
async function runAnalysis(images, jobId) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const imageContent = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: detectMediaType(img), data: stripDataUri(img) },
  }));

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [...imageContent, { type: 'text', text: USER_INSTRUCTION }] }],
    });

    const rawText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let analysisData;
    try {
      analysisData = JSON.parse(jsonText);
    } catch {
      logger.error('Claude returned non-JSON', { jobId, rawText: rawText.slice(0, 200) });
      jobs.set(jobId, { status: 'error', message: '分析结果解析失败，请重试', createdAt: jobs.get(jobId).createdAt });
      return;
    }

    if (!analysisData.summary || !Array.isArray(analysisData.questions)) {
      jobs.set(jobId, { status: 'error', message: '分析结果格式不完整，请重试', createdAt: jobs.get(jobId).createdAt });
      return;
    }

    logger.info('Analyze completed', {
      jobId,
      questionCount: analysisData.questions.length,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
    });

    jobs.set(jobId, { status: 'done', data: analysisData, createdAt: jobs.get(jobId).createdAt });
  } catch (err) {
    let message = 'AI 服务调用失败';
    if (err instanceof Anthropic.APIError) {
      message = err.status === 429 ? 'AI 服务繁忙，请稍后重试'
        : err.status >= 500 ? 'AI 服务暂时不可用，请稍后重试'
        : 'AI 服务调用失败';
    }
    logger.error('Analysis error', { jobId, error: err.message });
    jobs.set(jobId, { status: 'error', message, createdAt: jobs.get(jobId).createdAt });
  }
}

// POST /api/analyze — start job, return immediately (rate limited)
router.post('/', analyzeRateLimiter, (req, res) => {
  const { images } = req.body;

  if (!Array.isArray(images) || images.length === 0)
    return res.status(400).json({ success: false, message: '请至少上传一张试卷图片' });
  if (images.length > MAX_IMAGES)
    return res.status(400).json({ success: false, message: `最多上传 ${MAX_IMAGES} 张图片` });

  for (let i = 0; i < images.length; i++) {
    if (typeof images[i] !== 'string' || images[i].length === 0)
      return res.status(400).json({ success: false, message: `第 ${i + 1} 张图片数据无效` });
    const bytes = estimateBytes(images[i]);
    if (bytes > MAX_IMAGE_BYTES)
      return res.status(400).json({ success: false, message: `第 ${i + 1} 张图片超过 5MB` });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'processing', createdAt: Date.now() });

  logger.info('Analyze job started', { jobId, ip: req.ip, imageCount: images.length });

  // Fire and forget — no await
  runAnalysis(images, jobId);

  return res.json({ success: true, jobId });
});

// GET /api/analyze/result/:jobId — poll for result
router.get('/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, message: '任务不存在或已过期' });
  return res.json({ success: true, status: job.status, data: job.data, message: job.message });
});

module.exports = router;
