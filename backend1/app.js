const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// 密钥从Render环境变量读取，不要写死到代码
const COZE_TOKEN = process.env.COZE_TOKEN;
const WORKFLOW_ID = process.env.WORKFLOW_ID;
const COZE_API = "https://api.coze.cn/v1/workflow/stream_run";

// SSE代理接口
app.get('/api/outbound-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { business_type, target_region, user_query = "" } = req.query;

  if (!COZE_TOKEN || !WORKFLOW_ID) {
    res.write(`data: 后端缺少Coze环境配置\n\n`);
    res.write(`data: [DONE]\n\n`);
    return res.end();
  }

  try {
    const cozeResp = await axios.post(
      COZE_API,
      {
        workflow_id: WORKFLOW_ID,
        parameters: {
          business_type,
          target_region,
          user_query
        }
      },
      {
        headers: { Authorization: `Bearer ${COZE_TOKEN}` },
        responseType: 'stream',
        timeout: 120000
      }
    );

    let fullText = "";
    cozeResp.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.replace('data:', '').trim();
        if (!raw) continue;
        try {
          const json = JSON.parse(raw);
          // Coze PING心跳包，转发保活
          if (json.node_execute_uuid === "" && Object.keys(json.content || {}).length === 0) {
            res.write(`data: PING\n\n`);
            continue;
          }
          if (json.node_type === 'End' && json.content) {
            fullText = json.content;
          }
        } catch (e) {
          // 解析错误直接忽略
        }
      }
    });

    cozeResp.data.on('end', () => {
      let idx = 0;
      // 打字速度 30ms 一个字符，自行调整
      const timer = setInterval(() => {
        if (idx >= fullText.length) {
          clearInterval(timer);
          res.write(`data: [DONE]\n\n`);
          return res.end();
        }
        const piece = fullText[idx];
        res.write(`data: ${piece}\n\n`);
        idx++;
      }, 30);
    });

    cozeResp.data.on('error', (err) => {
      res.write(`data: Coze请求异常：${err.message}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    });

  } catch (err) {
    res.write(`data: 代理接口调用失败：${err.message}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务启动 on port ${PORT}`);
});

