require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { FormData } = require('formdata-node');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../yemianwendang')));

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

const COZE_PAT = process.env.COZE_PAT;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const WF_OVERSEA = process.env.WF_OVERSEA;
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_CONTRACT = process.env.WF_CONTRACT;
const WF_CASE_SEARCH = process.env.WF_CASE_SEARCH;
const COZE_BASE = "https://api.coze.cn";

async function streamText(res, text) {
  for (const char of text) {
    res.write(`data: ${char}\n\n`);
    await new Promise(r => setTimeout(r, 15));
  }
  res.write(`data: [DONE]\n\n`);
  res.end();
}

app.post('/api/upload-coze-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, msg: '未接收到上传文件' });
    }
    if (!COZE_PAT) {
      return res.status(500).json({ ok: false, msg: '缺少COZE_PAT环境变量' });
    }

    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    const cozeResp = await axios.post(`${COZE_BASE}/v1/files/upload`, formData, {
      headers: {
        Authorization: `Bearer ${COZE_PAT}`,
        ...formData.getHeaders()
      },
      timeout: 120000
    });

    return res.json({
      ok: true,
      file_id: cozeResp.data.data?.id,
      msg: '上传成功'
    });
  } catch (err) {
    console.error('文件上传异常：', err?.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      msg: err?.response?.data?.msg || '文件上传失败'
    });
  }
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { mode, workflow_id, file_id, ...params } = req.query;

  if (mode === 'bot') {
    const { user_id, prompt } = params;
    try {
      let messages = [];
      messages.push({ role: 'user', content: prompt });
      if (file_id) {
        messages = [{
          role: 'user',
          content: [
            { type: 'file', file_id: file_id },
            { type: 'text', text: prompt }
          ]
        }];
      }
      const cozeResp = await axios({
        method: 'POST',
        url: `${COZE_BASE}/v3/chat`,
        headers: {
          Authorization: `Bearer ${COZE_PAT}`,
          'Content-Type': 'application/json'
        },
        data: {
          bot_id: BOT_CHAT_ID,
          user_id,
          stream: true,
          messages
        },
        responseType: 'stream'
      });
      cozeResp.data.on('data', chunk => {
        const chunkStr = chunk.toString('utf8');
        const lines = chunkStr.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            res.write(`${line}\n\n`);
          }
        }
      });
      cozeResp.data.on('end', () => {
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
      cozeResp.data.on('error', e => {
        res.write(`data: 流异常：${e.message}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
    } catch (err) {
      console.error('bot对话报错：', err?.response?.data || err.message);
      res.write(`data: 请求失败：${err.message}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
  } else if (mode === 'workflow') {
    try {
      const targetWfId = workflow_id;
      const sendParams = { ...params };

      if (targetWfId === WF_OVERSEA) {
        console.log("【企业出海入参】", sendParams);
        const cozeResp = await axios({
          method: "POST",
          url: `${COZE_BASE}/v1/workflow/stream_run`,
          headers: {
            Authorization: `Bearer ${COZE_PAT}`,
            "Content-Type": "application/json"
          },
          data: {
            workflow_id: targetWfId,
            parameters: sendParams
          },
          responseType: "stream"
        });
        cozeResp.data.on('data', chunk => {
          const raw = chunk.toString('utf8');
          const lines = raw.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              res.write(`${line}\n\n`);
            }
          }
        });
        cozeResp.data.on('end', () => {
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
        cozeResp.data.on('error', err => {
          console.log("【出海流报错】", err.message);
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
      } else if (targetWfId === WF_COMPLAINT) {
        let fullText = '';
        const cozeResp = await axios({
          method: "POST",
          url: `${COZE_BASE}/v1/workflow/stream_run`,
          headers: {
            Authorization: `Bearer ${COZE_PAT}`,
            "Content-Type": "application/json"
          },
          data: {
            workflow_id: targetWfId,
            parameters: sendParams
          },
          responseType: "stream"
        });
        cozeResp.data.on('data', chunk => {
          const raw = chunk.toString('utf8');
          const lines = raw.split('\n');
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const json = JSON.parse(line.replace('data:', ''));
                if (json.content) {
                  fullText = json.content;
                }
              } catch (e) {}
            }
          }
        });
        cozeResp.data.on('end', () => {
          res.write(`data:${fullText}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        });
        cozeResp.data.on('error', err => {
          console.log("【诉状流报错】", err.message);
          res.end();
        });
      } else if (targetWfId === WF_CASE_SEARCH) {
        try {
          const resp = await axios({
            method: "POST",
            url: `${COZE_BASE}/v1/workflow/run`,
            headers: {
              Authorization: `Bearer ${COZE_PAT}`,
              "Content-Type": "application/json"
            },
            data: {
              workflow_id: targetWfId,
              parameters: sendParams
            }
          });
          const rawStr = resp.data.data;
          const parsedAll = JSON.parse(rawStr);
          const outputData = parsedAll.output || {};

          const sendObj = {
            type: "case",
            data: {
              final_list: outputData.final_list || [],
              total: outputData.total || 0,
              tip_msg: outputData.tip_msg || ""
            }
          };
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        } catch (err) {
          console.error("案例检索同步接口报错：", err?.response?.data || err.message);
          const sendObj = {
            type: "case",
            data: { final_list: [] },
            error: "请求Coze工作流失败"
          };
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        }
      } else {
        res.write(`data: 错误：workflow_id 不匹配\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      }
    } catch (globalErr) {
      console.error("workflow外层捕获：", globalErr.message);
      res.write(`data: workflow请求异常：${globalErr.message}\n\n`);
      res.write('data:[DONE]\n\n');
      res.end();
    }
  } else {
    res.write(`data: mode参数非法\n\n`);
    res.write('data:[DONE]\n\n');
    res.end();
  }
});

app.post('/api/workflow/contract', async (req, res) => {
  try {
    const { workflow_id, file_id } = req.body;
    console.log("收到合同审查请求 workflow_id:", workflow_id, "file_id:", file_id);
    const pat = process.env.COZE_PAT;
    if (!pat) {
      console.log("错误：PAT为空");
      return res.status(500).json({ error: "服务端PAT配置缺失" });
    }
    const cozeRes = await axios.post(`${COZE_BASE}/v1/workflow/run`,
      {
        workflow_id,
        parameters: {
          input: { file_id }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("合同接口返回成功");
    res.json(cozeRes.data);
  } catch (err) {
    console.log('====合同接口报错====');
    console.log("status:", err.response?.status);
    console.log("data:", err.response?.data);
    res.status(500).json({
      error: err.response?.data ?? err.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`服务启动成功，端口：${PORT}`);
});
