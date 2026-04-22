const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic();

function detectMediaType(base64String) {
  if (base64String.startsWith('data:image/png'))  return 'image/png';
  if (base64String.startsWith('data:image/gif'))  return 'image/gif';
  if (base64String.startsWith('data:image/webp')) return 'image/webp';
  if (base64String.startsWith('data:image/jpeg') || base64String.startsWith('data:image/jpg')) return 'image/jpeg';
  const raw = base64String.startsWith('data:') ? base64String.split(',')[1] : base64String;
  const header = raw.slice(0, 12);
  if (header.startsWith('iVBORw'))  return 'image/png';
  if (header.startsWith('R0lGOD'))  return 'image/gif';
  if (header.startsWith('UklGR'))   return 'image/webp';
  return 'image/jpeg';
}

function stripDataUri(base64String) {
  const idx = base64String.indexOf(',');
  return idx !== -1 ? base64String.slice(idx + 1) : base64String;
}

router.post('/', async (req, res) => {
  const { question, messages, images } = req.body;

  if (!question || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const systemPrompt =
    '你是一名专业的高考数学辅导老师，正在帮助学生理解一道具体的题目。\n' +
    '【格式要求】回答必须使用纯文本，不能使用任何markdown语法：不要用#号标题、不要用**加粗、不要用---分隔线、不要用$$或$包裹公式。\n' +
    '数学符号规则：上标用Unicode上标字符（x²、x³、xⁿ、(a+b)²），下标用Unicode下标字符（x₁、x₂、aₙ），' +
    '根号用√（√3、√(x+1)、∛2），希腊字母直接写（π、θ、α、β、Δ、Σ），不等号用≤≥≠≈，乘号用×或·，' +
    '分数用斜线（(x+1)/(x-1)），绝对值用|x|。\n' +
    '步骤用"第一步、第二步"或"①②③"标注。\n' +
    '【题目信息】\n' +
    `题号：第${question.id}题（${question.type || ''}，${question.score || ''}分，${question.difficulty || ''}）\n` +
    `模块：${question.module || ''}\n` +
    `主要知识点：${question.mainKnowledge || ''}\n` +
    (question.subKnowledge ? `次要知识点：${question.subKnowledge}\n` : '') +
    (question.brief ? `题目概述：${question.brief}\n` : '') +
    (question.intent ? `命题意图：${question.intent}\n` : '') +
    (question.entryPoint ? `解题切入点：${question.entryPoint}\n` : '') +
    (question.solution ? `解题思路：${question.solution}\n` : '') +
    (question.commonMistakes ? `常见失分点：${question.commonMistakes}\n` : '') +
    (images && images.length > 0 ? '（已附上试卷原图，可参考图中的具体题目内容）\n' : '') +
    '请根据学生的具体问题给出清晰有针对性的解释，回答简洁，聚焦疑问。';

  // 构建 Claude messages，首条用户消息附带试卷图片
  const claudeMessages = messages.map((m, idx) => {
    if (idx === 0 && m.role === 'user' && images && images.length > 0) {
      return {
        role: 'user',
        content: [
          ...images.map(img => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: detectMediaType(img),
              data: stripDataUri(img),
            },
          })),
          { type: 'text', text: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: claudeMessages,
    });

    const reply = response.content[0]?.text || '抱歉，暂时无法回答，请重试。';
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: '对话请求失败，请稍后重试' });
  }
});

module.exports = router;
