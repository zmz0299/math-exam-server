const logger = require('../utils/logger');

/**
 * Validates the X-App-Token header sent by the WeChat Mini Program.
 * The token is a shared secret configured via WECHAT_APP_TOKEN env var.
 */
function wechatAuth(req, res, next) {
  const token = req.headers['x-app-token'];
  const expected = process.env.WECHAT_APP_TOKEN;

  if (!expected) {
    logger.error('WECHAT_APP_TOKEN is not configured');
    return res.status(500).json({ success: false, message: '服务器配置错误' });
  }

  if (!token || token !== expected) {
    logger.warn('Unauthorized request', { ip: req.ip, path: req.path });
    return res.status(401).json({ success: false, message: '未授权的请求' });
  }

  next();
}

module.exports = { wechatAuth };
