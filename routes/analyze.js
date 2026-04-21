const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const router = express.Router();

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const SYSTEM_PROMPT =
  '你是一位专业的高中数学出题结构分析专家，擅长分析高考及模拟题的考点分布。' +
  '请分析用户上传的试卷图片，严格按照指定 JSON 格式返回分析结果，不要输出任何其他内容。';

const USER_INSTRUCTION = `请分析这份高中数学试卷，返回如下 JSON 格式（只输出 JSON，不含 markdown 代码块）：
{
  "summary": {
    "totalQuestions": <题目总数>,
    "totalScore": <总分>,
    "examType": "<试卷类型，如：高考模拟卷、月考卷等>"
  },
  "knowledgePoints": [
    {
      "name": "<考点名称>",
      "count": <题目数量>,
      "score": <分值>,
      "difficulty": "<难度：易/中/难>",
      "questions": [<题号列表>]
    }
  ],
  "questions": [
    {
      "number": <题号>,
      "type": "<题型：选择题/填空题/解答题>",
      "score": <分值>,
      "knowledgePoint": "<主要考点>",
      "difficulty": "<难度：易/中/难>",
      "hint": "<解题思路提示，1-2句>"
    }
  ],
  "suggestions": "<整体备考建议，2-3句>"
}`;

// Detect image media type from base64 header or raw prefix
function detectMediaType(base64String) {
  const raw = base64String.startsWith('data:') ? base64String : '';
  if (raw.startsWith('data:image/png')) return 'image/png';
  if (raw.startsWith('data:image/gif')) return 'image/gif';
  if (raw.startsWith('data:image/webp')) return 'image/webp';
  return 'image/jpeg'; // default
}

// Strip the data URI prefix if present
function stripDataUri(base64String) {
  const idx = base64String.indexOf(',');
  return idx !== -1 ? base64String.slice(idx + 1) : base64String;
}

// Rough byte size estimate from base64 length
function estimateBytes(base64String) {
  const data = stripDataUri(base64String);
  return Math.ceil((data.length * 3) / 4);
}

router.post('/', async (req, res) => {
  const { images } = req.body;

  // --- Validation ---
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ success: false, message: '请至少上传一张试卷图片' });
  }
  if (images.length > MAX_IMAGES) {
    return res.status(400).json({ success: false, message: `最多上传 ${MAX_IMAGES} 张图片` });
  }
  for (let i = 0; i < images.length; i++) {
    if (typeof images[i] !== 'string' || images[i].length === 0) {
      return res.status(400).json({ success: false, message: `第 ${i + 1} 张图片数据无效` });
    }
    const bytes = estimateBytes(images[i]);
    if (bytes > MAX_IMAGE_BYTES) {
      return res.status(400).json({
        success: false,
        message: `第 ${i + 1} 张图片超过 5MB 限制（当前约 ${(bytes / 1024 / 1024).toFixed(1)}MB）`,
      });
    }
  }

  logger.info('Analyze request received', { ip: req.ip, imageCount: images.length });

  // --- Build Anthropic message content ---
  const imageContent = images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: detectMediaType(img),
      data: stripDataUri(img),
    },
  }));

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            { type: 'text', text: USER_INSTRUCTION },
          ],
        },
      ],
    });

    const rawText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Strip markdown code fences if Claude wrapped the JSON anyway
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let analysisData;
    try {
      analysisData = JSON.parse(jsonText);
    } catch {
      logger.error('Claude returned non-JSON response', { rawText });
      return res.status(502).json({
        success: false,
        message: '分析结果解析失败，请重试',
      });
    }

    // Basic structure check
    if (!analysisData.summary || !Array.isArray(analysisData.questions)) {
      logger.error('Claude response missing required fields', { analysisData });
      return res.status(502).json({
        success: false,
        message: '分析结果格式不完整，请重试',
      });
    }

    logger.info('Analyze completed', {
      ip: req.ip,
      questionCount: analysisData.questions?.length,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
    });

    return res.json({ success: true, data: analysisData });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      logger.error('Anthropic API error', { status: err.status, message: err.message });
      const userMsg =
        err.status === 429
          ? 'AI 服务繁忙，请稍后重试'
          : err.status >= 500
          ? 'AI 服务暂时不可用，请稍后重试'
          : 'AI 服务调用失败';
      return res.status(502).json({ success: false, message: userMsg });
    }
    logger.error('Unexpected error in /api/analyze', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: '服务器内部错误，请稍后重试' });
  }
});

module.exports = router;
