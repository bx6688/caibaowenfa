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
      return res.status(500).json({ ok: false, msg: '服务缺少 COZE_PAT 令牌配置' });
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

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { mode, workflow_id, file_id, ...params } = req.query;

  if (mode === 'bot') {
    const { user_id, msg } = params;
    try {
      let realText = msg || "";
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
      const { workflow_id, business_type, target_region, user_query, ...rest } = req.query;
      const targetWfId = workflow_id;
      let sendParams = { ...rest };

      if (targetWfId === "7702680885376614438") {
        sendParams = {
          business_type,
          target_region,
          ...(user_query ? { user_query } : {})
        };
        console.log("【出海入参】", sendParams);

        const cozeResp = await axios({
          method: "POST",
          url: "https://api.coze.cn/v1/workflow/stream_run",
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
          const rawStr = chunk.toString('utf8');
          const lines = rawStr.split(/\r?\n/);
          let currentEvent = "";
          for (const line of lines) {
            const trimLine = line.trim();
            if (!trimLine) continue;
            if (trimLine.startsWith('event: ')) {
              currentEvent = trimLine.slice(7);
              continue;
            }
            if (trimLine.startsWith('data: ')) {
              try {
                const payload = JSON.parse(trimLine.slice(6));
                if (currentEvent === 'PING') continue;
                const innerStr = payload.content;
                if (!innerStr) continue;
                const innerJson = JSON.parse(innerStr);
                let text = innerJson.content;
                text = text.replace(/\n/g, '\\n');
                res.write(`data: ${text}\n\n`);
              } catch (err) {
                console.error('解析异常：', err);
              }
            }
          }
        });

        cozeResp.data.on('end', () => {
          res.write(`data: [DONE]\n\n`);
          res.end();
        });

        cozeResp.data.on('error', err => {
          console.log("【出海流报错】", err.message);
          res.end();
        });
      } else if (targetWfId === WF_COMPLAINT) {
        let fullText = '';
        let currentEvent = "";

        const cozeResp = await axios({
          method: "POST",
          url: "https://api.coze.cn/v1/workflow/stream_run",
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
          const rawStr = chunk.toString('utf8');
          const lines = rawStr.split(/\r?\n/);
          for (const line of lines) {
            const trimLine = line.trim();
            if (!trimLine) continue;
            if (trimLine.startsWith('event: ')) {
              currentEvent = trimLine.slice(7);
              continue;
            }
            if (trimLine.startsWith('data: ')) {
              try {
                const payload = JSON.parse(trimLine.slice(6));
                if (payload.content) {
                  fullText = payload.content;
                }
              } catch (err) {
                console.log("诉状解析 err", err, line);
              }
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
        let endContent = '';
        let streamError = null;
        const cozeResp = await axios({
          method: "POST",
          url: "https://api.coze.cn/v1/workflow/stream_run",
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
          const rawStr = chunk.toString('utf8');
          const lines = rawStr.split(/\r?\n/);
          let currentEvent = "";
          for (const line of lines) {
            const trimLine = line.trim();
            if (!trimLine) continue;

            // 捕获 event: xxx （官方规范）
            if (trimLine.startsWith('event: ')) {
              currentEvent = trimLine.slice(7);
              continue;
            }
            if (trimLine.startsWith('data: ')) {
              try {
                const payload = JSON.parse(trimLine.slice(6));
                // 心跳包PING，直接跳过
                if (currentEvent === "PING") continue;

                if (currentEvent === "Message") {
                  // Message事件：节点输出
                  if (payload.node_title === "End" && payload.content) {
                    endContent = payload.content;
                  }
                }
                if (currentEvent === "Error") {
                  // 捕获扣子工作流内部报错
                  streamError = payload.error_message || "工作流执行报错";
                  console.error("Coze工作流Error：", payload);
                }
                if (currentEvent === "Done") {
                  // 官方Done事件，工作流结束标记
                  console.log("收到Coze Done事件");
                }
              } catch (err) {
                console.log("案例检索单包解析忽略", err.message, trimLine);
              }
            }
          }
        });

        cozeResp.data.on('end', () => {
          let sendObj;
          if (streamError) {
            sendObj = { type: "case", data: { final_list: [] }, error: streamError };
          } else if (!endContent) {
            sendObj = { type: "case", data: { final_list: [] }, error: "工作流没有返回结果" };
          } else {
            try {
              // 交给JSON.stringify自动转义，不再手动暴力替换引号（容易二次破坏JSON）
              const caseJson = JSON.parse(endContent);
              sendObj = {
                type: "case",
                data: caseJson
              };
            } catch (e) {
              console.error("案例最终解析失败", e, endContent);
              sendObj = { type: "case", data: { final_list: [] }, error: "返回数据JSON格式错误" };
            }
          }
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        });

        cozeResp.data.on('error', (err) => {
          console.error("案例检索流异常", err.message);
          const sendObj = { type: "case", data: { final_list: [] }, error: "请求Coze接口失败" };
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        });

        cozeResp.data.on('error', (err) => {
          console.error("案例检索流异常", err.message);
          const sendObj = { type: "case", data: { final_list: [] }, error: "接口请求失败" };
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        });


        cozeResp.data.on('error', (err) => {
          console.error("案例检索流异常", err.message);
          const sendObj = { type: "case", data: { final_list: [] }, error: "接口请求失败" };
          const sseMsg = JSON.stringify(sendObj);
          res.write(`data: ${sseMsg}\n\n`);
          res.write('data:[DONE]\n\n');
          res.end();
        });
      } else {
        res.write(`data: 错误：workflow_id 不匹配\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      }
    } catch (globalErr) {
      console.error("workflow外层捕获", globalErr);
      res.write(`data: workflow请求异常：${globalErr.message}\n\n`);
      res.write('data:[DONE]\n\n');
      res.end();
    }
  } else {
    res.write(`data: 错误：mode 参数非法\n\n`);
    res.end();
  }
});

app.post('/api/workflow/contract', async (req, res) => {
  try {
    const { workflow_id, file_id } = req.body;
    console.log("收到合同审查请求，workflow_id:", workflow_id, "file_id:", file_id);
    const pat = process.env.COZE_PAT;
    if (!pat) {
      console.log("错误：PAT 环境变量为空！");
      return res.status(500).json({ error: "服务端 PAT 令牌未配置" });
    }
    const cozeRes = await axios.post('https://api.coze.cn/v1/workflow/run',
      {
        workflow_id: workflow_id,
        parameters: {
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
    console.log("Coze 合同接口返回成功");
    res.json(cozeRes.data);
  } catch (err) {
    console.log('==== 合同接口原始报错 ====');
    console.log("status:", err.response?.status);
    console.log("data:", err.response?.data);
    res.status(500).json({
      error: err.response?.data ?? err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务启动成功，端口：", PORT);
});
