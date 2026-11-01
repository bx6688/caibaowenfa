require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { FormData } = require('formdata-node'); // 原代码缺失，上传文件必须

const app = express();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../yemianwendang')));

// multer 内存存储，最大50MB
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// 环境变量
const COZE_PAT = process.env.COZE_PAT;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const WF_OVERSEA = process.env.WF_OVERSEA;
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_CONTRACT = process.env.WF_CONTRACT;
const WF_CASE_SEARCH = process.env.WF_CASE_SEARCH;
const COZE_BASE = "https://api.coze.cn";

/**
 * 逐字流式输出文本（用于工作流非case场景）
 * @param {import('express').Response} res
 * @param {string} text
 */
async function streamText(res, text) {
  for (const char of text) {
    res.write(`data: ${char}\n\n`);
    await new Promise(r => setTimeout(r, 15));
  }
  res.write(`data: [DONE]\n\n`);
  res.end();
}

/**
 * 上传文件到 Coze 文件接口
 * POST /api/upload-coze-file
 */
app.post('/api/upload-coze-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, msg: '未接收到上传文件' });
    }
    if (!COZE_PAT) {
      return res.status(500).json({ ok: false, msg: '服务缺少COZE_PAT令牌配置' });
    }

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    formData.append('file', blob, req.file.originalname);

    const cozeResp = await axios.post(
      `${COZE_BASE}/v1/files/upload`,
      formData,
      {
        headers: {
          "Authorization": `Bearer ${COZE_PAT}`
        },
        timeout: 120000
      }
    );

    const ret = cozeResp.data;
    if (ret.code !== 0 || !ret.data?.id) {
      return res.status(500).json({ ok: false, msg: ret.msg || "Coze文件上传失败" });
    }

    return res.json({
      ok: true,
      file_id: ret.data.id,
      msg: '上传成功'
    });
  } catch (err) {
    console.error('上传文件异常', err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      msg: err?.response?.data?.msg || err.message
    });
  }
});

/**
 * SSE流式接口
 * GET /api/stream
 * mode=bot：对话模式；mode=workflow：工作流模式
 */
app.get('/api/stream', async (req, res) => {
  // SSE响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { mode, workflow_id, file_id, ...params } = req.query;

  if (mode === 'bot') {
    const { user_id, msg } = params;
    try {
      let realText = msg || "";
      // 有文件但是无文字时自动填充提示语
      if (file_id && file_id.trim() !== '' && (!realText || realText.trim() === '')) {
        realText = "请分析这份上传的文件";
      }

      let messagesPayload;
      if (file_id && file_id.trim() !== '') {
        messagesPayload = {
          content: JSON.stringify([
            { type: "text", text: realText },
            { type: "file", file_id: file_id }
          ]),
          content_type: "object_string",
          role: "user",
          type: "question"
        };
      } else {
        messagesPayload = {
          content: realText,
          content_type: "text",
          role: "user",
          type: "question"
        };
      }

      const cozeResp = await axios({
        method: "POST",
        url: `${COZE_BASE}/v3/chat`,
        headers: {
          "Authorization": `Bearer ${COZE_PAT}`,
          "Content-Type": "application/json"
        },
        data: {
          bot_id: BOT_CHAT_ID,
          user_id,
          stream: true,
          additional_messages: [messagesPayload],
          parameters: {}
        },
        responseType: "stream"
      });

      cozeResp.data.on('data', (chunk) => {
        const str = chunk.toString();
        const lines = str.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          res.write(`${line}\n\n`);
        }
      });

      cozeResp.data.on('end', () => {
        res.write(`data: [DONE]\n\n`);
        res.end();
      });

      cozeResp.data.on('error', (e) => {
        res.write(`data: 流异常：${e.message}\n\n`);
        res.end();
      });
    } catch (err) {
      res.write(`data: 请求失败：${err.response?.data?.error || err.message}\n\n`);
      res.end();
    }
  } else if (mode === 'workflow') {
    try {
      const cozeResp = await axios({
        method: "POST",
        url: `${COZE_BASE}/v1/workflow/stream_run`,
        headers: {
          "Authorization": `Bearer ${COZE_PAT}`,
          "Content-Type": "application/json"
        },
        data: {
          workflow_id,
          parameters: params
        },
        responseType: "stream"
      });

      let resultData = {};

      cozeResp.data.on('data', (chunk) => {
        const str = chunk.toString();
        const lines = str.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line.replace(/^data: /, ''));
            if (obj.type === "workflow_finish") {
              resultData = obj.data.output;
            }
          } catch (e) {
            // 忽略解析错误行
          }
        }
      });

      cozeResp.data.on('end', async () => {
        if (workflow_id === WF_CASE_SEARCH) {
          res.write(`data: ${JSON.stringify({ type: "case", data: resultData })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        } else {
          let outputText = "";
          if (workflow_id === WF_OVERSEA) outputText = resultData.content;
          if (workflow_id === WF_COMPLAINT) outputText = resultData.pleading_text;
          if (workflow_id === WF_CONTRACT) outputText = resultData.output;
          await streamText(res, outputText);
        }
      });

      cozeResp.data.on('error', (e) => {
        res.write(`data: 流异常：${e.message}\n\n`);
        res.end();
      });
    } catch (err) {
      res.write(`data: 请求失败：${err.response?.data?.error || err.message}\n\n`);
      res.end();
    }
  } else {
    res.write(`data: 错误：mode参数非法\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务启动，端口：", PORT);
});
