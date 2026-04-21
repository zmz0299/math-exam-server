# 数学试卷智能分析 - 后端服务

Node.js + Express 中转服务，连接微信小程序与 Anthropic Claude API。

## 本地开发

```bash
cd server
npm install
cp .env.example .env    # 填入真实的 key 和 token
npm run dev             # 使用 nodemon 热重载
```

访问 `http://localhost:3000/api/health` 验证服务正常。

---

## 部署到云服务器（阿里云 / 腾讯云）

微信小程序要求后端必须使用 **HTTPS + 已备案域名**。

### 1. 服务器环境准备

```bash
# 安装 Node.js 18+（以 Ubuntu/Debian 为例）
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2（进程守护）
npm install -g pm2
```

### 2. 上传代码

```bash
# 将 server/ 目录上传到服务器，例如 /var/app/math-server
scp -r ./server user@your-server-ip:/var/app/math-server

# 在服务器上安装依赖
cd /var/app/math-server
npm install --production
```

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env   # 填写以下内容：
```

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
WECHAT_APP_TOKEN=your-random-32-char-secret
PORT=3000
NODE_ENV=production
```

> `WECHAT_APP_TOKEN` 是你自定义的共享密钥，小程序端发请求时在 Header 带上 `X-App-Token: <同一个值>`。

### 4. 用 PM2 启动服务

```bash
pm2 start server.js --name math-server
pm2 save          # 开机自启
pm2 startup       # 按提示执行生成的命令
```

### 5. 配置 Nginx 反向代理 + HTTPS

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/nginx/ssl/your-domain.crt;
    ssl_certificate_key /etc/nginx/ssl/your-domain.key;

    # 上传图片 base64 body 较大，调高限制
    client_max_body_size 25m;

    location /api/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;   # Claude 分析耗时可能较长
    }
}
```

SSL 证书可通过 **阿里云/腾讯云免费 DV 证书** 或 **Let's Encrypt** 申请。

### 6. 在微信公众平台配置合法域名

登录 [微信公众平台](https://mp.weixin.qq.com) → 开发 → 开发管理 → 开发设置 → 服务器域名，
将 `https://your-domain.com` 添加到 **request 合法域名**。

---

## 接口说明

### `GET /api/health`
健康检查，无需鉴权。

**响应**
```json
{ "status": "ok", "timestamp": "2026-04-21T06:00:00.000Z" }
```

---

### `POST /api/analyze`
分析试卷图片。

**请求头**
```
Content-Type: application/json
X-App-Token: <WECHAT_APP_TOKEN 的值>
```

**请求体**
```json
{
  "images": ["base64字符串1", "base64字符串2"]
}
```

- 最多 3 张图片
- 单张图片原始大小不超过 5MB
- base64 字符串可带或不带 `data:image/jpeg;base64,` 前缀

**成功响应**
```json
{
  "success": true,
  "data": {
    "summary": { "totalQuestions": 21, "totalScore": 150, "examType": "高考模拟卷" },
    "knowledgePoints": [...],
    "questions": [...],
    "suggestions": "..."
  }
}
```

**错误响应**
```json
{ "success": false, "message": "错误描述" }
```

| HTTP 状态码 | 含义 |
|------------|------|
| 400 | 请求参数错误（图片数量/大小超限） |
| 401 | Token 鉴权失败 |
| 429 | 请求频率超限（每 IP 每分钟最多 10 次） |
| 502 | Claude API 调用失败或返回格式异常 |
| 500 | 服务器内部错误 |

---

## 小程序端调用示例

```javascript
// utils/request.js 中的 analyzeExam 方法
const BASE_URL = 'https://your-domain.com';
const APP_TOKEN = 'your-random-32-char-secret'; // 与服务端 WECHAT_APP_TOKEN 一致

wx.request({
  url: `${BASE_URL}/api/analyze`,
  method: 'POST',
  header: {
    'Content-Type': 'application/json',
    'X-App-Token': APP_TOKEN,
  },
  data: { images: base64Array },
  success(res) { /* res.data.success / res.data.data */ },
});
```
