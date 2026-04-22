require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');

const logger = require('./utils/logger');
const { wechatAuth } = require('./middleware/auth');
const { analyzeRateLimiter } = require('./middleware/rateLimiter');
const healthRouter = require('./routes/health');
const analyzeRouter = require('./routes/analyze');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// Validate required env vars at startup
if (!process.env.ANTHROPIC_API_KEY) {
  logger.error('ANTHROPIC_API_KEY is not set. Exiting.');
  process.exit(1);
}
if (!process.env.WECHAT_APP_TOKEN) {
  logger.error('WECHAT_APP_TOKEN is not set. Exiting.');
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;

// --- Global middleware ---
app.use(express.json({ limit: '20mb' })); // 3 images × ~5MB base64 overhead

// Trust first proxy (nginx / Tencent CLB) so req.ip is the real client IP
app.set('trust proxy', 1);

// --- Routes ---
app.use('/api/health', healthRouter);

// Auth applies to all protected routes; rate limit only on POST (analysis submission)
app.use('/api', wechatAuth);
app.use('/api/analyze', analyzeRouter);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ success: false, message: '接口不存在' });
});

// Centralised error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: '服务器内部错误' });
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV });
});
