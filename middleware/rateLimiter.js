const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const analyzeRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    logger.warn('Rate limit exceeded', { ip: req.ip });
    res.status(429).json({
      success: false,
      message: '请求过于频繁，请稍后再试（每分钟最多10次）',
    });
  },
});

module.exports = { analyzeRateLimiter };
