const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic();

router.post('/', async (req, res) => {
  const { question, messages } = req.body;

  if (!question || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const systemPrompt =
    `你是一名专业的高考数学辅导老师，正在帮助学生理解一道具体的题目。\n` +
    `\n题目信息：\n` +
    `- 题号：第${question.id}题（${question.type || ''}，${question.score || ''}分，${question.difficulty || ''}）\n` +
    `- 所属模块：${question.module || ''}\n` +
    `- 主要知识点：${question.mainKnowledge || ''}\n` +
    (question.subKnowledge ? `- 次要知识点：${question.subKnowledge}\n` : '') +
    (question.brief ? `- 题目概述：${question.brief}\n` : '') +
    (question.intent ? `- 命题意图：${question.intent}\n` : '') +
    (question.entryPoint ? `- 解题切入点：${question.entryPoint}\n` : '') +
    (question.solution ? `- 解题思路：${question.solution}\n` : '') +
    (question.commonMistakes ? `- 常见失分点：${question.commonMistakes}\n` : '') +
    `\n请根据学生的具体问题给出清晰、有针对性的解释。回答要简洁，聚焦学生的疑问，必要时可分步拆解。`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const reply = response.content[0]?.text || '抱歉，暂时无法回答，请重试。';
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: '对话请求失败，请稍后重试' });
  }
});

module.exports = router;
