require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 跨域配置
app.use(cors({
  origin: process.env.ALLOW_ORIGIN || '*'
}));
app.use(express.json());

// ===================== 通用流式代理函数（workflow 流接口：/v1/workflow/stream_run） =====================
async function streamProxy(res, token, payload) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const cozeResp = await axios({
      method: 'POST',
      url: 'https://api.coze.cn/v1/workflow/stream_run',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: payload,
      responseType: 'stream'
    });

    cozeResp.data.on('data', (chunk) => {
      res.write(chunk);
    });
    cozeResp.data.on('end', () => {
      res.end();
    });
    cozeResp.data.on('error', (err) => {
      console.error('workflow stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('request workflow failed:', err);
    res.write(`data: {"error":"${err.message}"}\n\n`);
    res.end();
  }
}

// ===================== 聊天专用流式代理函数（v3 chat：/v3/chat） =====================
async function streamProxyChat(res, token, payload) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const cozeResp = await axios({
      method: 'POST',
      url: 'https://api.coze.cn/v3/chat',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: payload,
      responseType: 'stream'
    });

    cozeResp.data.on('data', (chunk) => {
      res.write(chunk);
    });
    cozeResp.data.on('end', () => {
      res.end();
    });
    cozeResp.data.on('error', (err) => {
      console.error('chat stream error:', err);
      res.end();
    });
  } catch (err) {
    console.error('request chat failed:', err);
    res.write(`data: {"error":"${err.message}"}\n\n`);
    res.end();
  }
}

// ===================== 路由定义 =====================
// 1. 民事起诉状
app.post('/api/workflow/complaint', async (req, res) => {
  const payload = {
    workflow_id: process.env.WF_COMPLAINT,
    parameters: req.body
  };
  await streamProxy(res, process.env.SAT_COMPLAINT, payload);
});

// 2. 企业出海（你前端 overseas.html 用这个）
app.post('/api/workflow/oversea', async (req, res) => {
  const payload = {
    workflow_id: process.env.WF_OVERSEA,
    parameters: req.body
  };
  await streamProxy(res, process.env.SAT_OVERSEA, payload);
});

// 3. 合同审查
app.post('/api/workflow/contract', async (req, res) => {
  const payload = {
    workflow_id: process.env.WF_CONTRACT,
    parameters: req.body
  };
  await streamProxy(res, process.env.SAT_CONTRACT, payload);
});

// 4. 判例检索
app.post('/api/workflow/case-search', async (req, res) => {
  const payload = {
    workflow_id: process.env.WF_CASE_SEARCH,
    parameters: req.body
  };
  await streamProxy(res, process.env.SAT_CASE_SEARCH, payload);
});

// 5. Coze v3 聊天
app.post('/api/chat', async (req, res) => {
  const { user_id, content, conversation_id } = req.body;
  const payload = {
    bot_id: process.env.BOT_CHAT_ID,
    user_id,
    stream: true,
    conversation_id,
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
  await streamProxyChat(res, process.env.SAT_CHAT, payload);
});

// 健康检测接口（Render自动检测）
app.get('/', (req, res) => {
  res.send('caibaowenfa backend running ok!');
});

app.listen(PORT, () => {
  console.log(`Server start on port ${PORT}`);
});
