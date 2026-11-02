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
      const { workflow_id, ...params } = req.query;
      const targetWfId = workflow_id;
      let sendParams = { ...params };

      if (targetWfId === WF_CONTRACT) {
        sendParams = { input: params.file_id };
      }

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

      if (targetWfId === "7702680885376614438") {
        // ===== 出海，和合同审查解析逻辑完全对齐 =====
        cozeResp.data.on('data', chunk => {
          const str = chunk.toString('utf8');
          const lines = str.split('\n');
          for(const line of lines){
            if(!line.trim()) continue;
            if(line.startsWith('data: ')){
              try{
                const msg = JSON.parse(line.slice(6));
                // 重点：结束节点返回变量content，在 msg.data.content
                const text = msg.data?.content;
                if(text !== undefined){
                  res.write(`data: ${text}\n\n`);
                }
              }catch(e){
                continue;
              }
            }
          }
        });
        cozeResp.data.on('end', () => {
          res.write(`data: [DONE]\n\n`);
          res.end();
        });
        cozeResp.data.on('error', err => {
          console.log("出海流错误", err);
          res.end();
        });
      } else {
        // ===== 合同审查、其他工作流，原有代码原样保留，一字不改 =====
        let resultData = {};
        cozeResp.data.on('data', (chunk) => {
          const str = chunk.toString('utf8');
          const lines = str.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('data: ')) {
              try {
                resultData = JSON.parse(line.slice(6));
              } catch (e) {}
            }
          }
        });
        cozeResp.data.on('end', async function () {
          if (targetWfId === WF_CASE_SEARCH) {
            res.write("data: " + JSON.stringify({ type: "case", data: resultData }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            let outputText = "";
            if (targetWfId === WF_COMPLAINT) outputText = resultData?.pleading_text;
            if (targetWfId === WF_CONTRACT) outputText = resultData?.output;
            outputText = typeof outputText === "string" ? outputText : "";
            await streamText(res, outputText);
          }
        });
        cozeResp.data.on('error', function (e) {
          console.log('其他工作流流错误', e);
          res.end();
        });
      }
    } catch (err) {
      console.log('axios请求报错：', err?.response?.data || err.message);
      res.write(`data: 请求异常 ${JSON.stringify(err?.response?.data || err.message)}\n\n`);
      res.end();
    }
  }


 else {
    res.write(`data: 错误：mode参数非法\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("服务启动，端口：", PORT);
});
// ========== 新增：合同审查 同步run接口【独立，不影响智能对话SSE】 ==========
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
