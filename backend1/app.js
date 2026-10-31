require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// 配置项
const SAT_COMPLAINT = process.env.SAT_COMPLAINT;
const SAT_COMMON = process.env.SAT_COMMON;
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_OVERSEA = process.env.WF_OVERSEA;
const WF_CONTRACT = process.env.WF_CONTRACT;
const WF_CASE_SEARCH = process.env.WF_CASE_SEARCH;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN;

// 中间件
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// 限流
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  message: { code: 429, msg: "请求过于频繁，请稍后再试" }
});
app.use(limiter);

/**
 * SSE 流式转发工具
 */
async function streamProxy(res, url, method, token, body) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      res.write(`data: ${JSON.stringify({event:"error", code: resp.status, msg: resp.statusText})}\n\n`);
      return res.end();
    }
    resp.body.on('data', chunk => res.write(chunk));
    resp.body.on('end', () => res.end());
    resp.body.on('error', err => {
      res.write(`data: ${JSON.stringify({event:"error", msg: err.message})}\n\n`);
      res.end();
    })
  } catch (err) {
    res.write(`data: ${JSON.stringify({event:"error", msg: err.message})}\n\n`);
    res.end();
  }
}

// ========== 路由 ==========
/**
 * 1. 民事起诉状
 * POST /api/workflow/complaint
 */
app.post('/api/workflow/complaint', async (req, res) => {
  const params = {};
  const fields = [
    "case_content", "case_evidence", "case_law_basis", "claim_amount", "claim_main",
    "claim_other", "defendant_address", "defendant_name", "defendant_phone", "defendant_type",
    "lawsuit_type", "plaintiff_address", "plaintiff_name", "plaintiff_phone", "plaintiff_type"
  ];
  for (const f of fields) {
    if (req.body[f] !== undefined && req.body[f] !== "") params[f] = req.body[f];
  }
  await streamProxy(res, "https://api.coze.cn/v1/workflow/stream_run", "POST", SAT_COMPLAINT, {
    workflow_id: WF_COMPLAINT,
    parameters: params
  });
});

/**
 * 2. 企业出海咨询
 * POST /api/workflow/oversea
 */
app.post('/api/workflow/oversea', async (req, res) => {
  const params = {};
  ["business_type", "target_region", "user_query"].forEach(f => {
    if (req.body[f] !== undefined && req.body[f] !== "") params[f] = req.body[f];
  });
  await streamProxy(res, "https://api.coze.cn/v1/workflow/stream_run", "POST", SAT_COMMON, {
    workflow_id: WF_OVERSEA,
    parameters: params
  });
});

/**
 * 3. 合同审查
 * POST /api/workflow/contract
 */
app.post('/api/workflow/contract', async (req, res) => {
  const { input } = req.body;
  await streamProxy(res, "https://api.coze.cn/v1/workflow/stream_run", "POST", SAT_COMMON, {
    workflow_id: WF_CONTRACT,
    parameters: { input }
  });
});

/**
 * 4. 判例检索
 * POST /api/workflow/case-search
 */
app.post('/api/workflow/case-search', async (req, res) => {
  const params = {};
  ["case_type", "court", "keyword", "search_mode", "sort_type"].forEach(f => {
    if (req.body[f] !== undefined && req.body[f] !== "") params[f] = req.body[f];
  });
  await streamProxy(res, "https://api.coze.cn/v1/workflow/stream_run", "POST", SAT_COMMON, {
    workflow_id: WF_CASE_SEARCH,
    parameters: params
  });
});

/**
 * 5. 文件上传
 * POST /api/file/upload
 */
app.post('/api/file/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ code:400, msg:"缺少上传文件" });
  try {
    const formData = new FormData();
    formData.append('file', file.buffer, { filename: file.originalname });
    const r = await fetch("https://api.coze.cn/v1/files/upload", {
      method: "POST",
      headers: { "Authorization": `Bearer ${SAT_COMMON}` },
      body: formData
    });
    const data = await r.json();
    return res.json(data);
  } catch(e) {
    return res.status(500).json({ code:500, msg:"文件上传失败", error:e.message });
  }
});

/**
 * 6. 聊天机器人（多轮对话）
 * POST /api/chat
 */
app.post('/api/chat', async (req, res) => {
  const { user_id, content, conversation_id } = req.body;
  if (!user_id || !content) {
    return res.status(400).json({ code:400, msg:"缺少 user_id 或者消息内容 content" });
  }
  const payload = {
    bot_id: BOT_CHAT_ID,
    user_id,
    stream: true,
    additional_messages: [
      {
        content,
        content_type: "text",
        role: "user",
        type: "question"
      }
    ],
    parameters: {}
  };
  if (conversation_id) payload.conversation_id = conversation_id;
  await streamProxy(res, "https://api.coze.cn/v3/chat", "POST", SAT_COMMON, payload);
});

app.get('/', (req, res) => {
  res.send("✅ Coze Proxy Backend Running");
});

app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
