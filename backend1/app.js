require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { Readable } = require('stream');
const { FormData, File } = require('formdata-node');


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
    const file = new File([req.file.buffer], req.file.originalname, {
      type: req.file.mimetype
    });
    formData.append('file', file);

    const cozeResp = await axios.post(`${COZE_BASE}/v1/files/upload`, formData, {
      headers: {
        Authorization: `Bearer ${COZE_PAT}`,
        // 4.x 写法！！不是 getHeaders()
        'Content-Type': formData.getContentType()
      },
      timeout: 120000
    });

    if (cozeResp.data.code !== 0 || !cozeResp.data.data?.id) {
      console.error('Coze上传返回异常：', cozeResp.data);
      return res.status(500).json({ ok: false, msg: cozeResp.data.msg || "Coze文件上传返回异常" });
    }

    return res.json({
      ok: true,
      file_id: cozeResp.data.data.id,
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
    // =========【这里是你给的新版智能对话代码，只替换这一块】=========
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
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
    } catch (err) {
      console.error('bot对话报错：', err?.response?.data || err.message);
      res.write(`data: 请求失败：${err.response?.data?.error || err.message}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
    // =========================================================
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
          let outputData;
          const raw = resp.data.data;
          if (typeof raw === 'string') {
            outputData = JSON.parse(raw);
          } else {
            outputData = raw || {};
          }
          outputData = outputData.output || outputData;

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

// ========== 替换成你指定版本的合同审查同步接口 ==========
app.post('/api/workflow/contract', async (req, res) => {
  try {
    const { workflow_id, file_id } = req.body;
    console.log("收到合同审查请求，workflow_id:", workflow_id, "file_id:", file_id);
    const pat = process.env.COZE_PAT;
    if(!pat){
      console.log("错误：PAT环境变量为空！");
      return res.status(500).json({error: "服务端PAT令牌未配置"});
    }
    const cozeRes = await axios.post('https://api.coze.cn/v1/workflow/run',
      {
        workflow_id: workflow_id,
        parameters: {
          // File类型变量：直接传 {file_id:xxx} 对象，不要JSON.stringify
          input: { file_id: file_id }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("Coze返回成功：", cozeRes.data);
    res.json(cozeRes.data);
  } catch (err) {
    console.log('==== Coze接口原始报错 ====');
    console.log("err.response?.status:", err.response?.status);
    console.log("err.response?.data:", err.response?.data);
    res.status(500).json({
      error: err.response?.data ?? err.message
    });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`服务启动成功，端口：${PORT}`);
});
