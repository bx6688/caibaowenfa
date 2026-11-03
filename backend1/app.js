require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { FormData } = require('formdata-node');

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
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_COMPANY_OUTBOUND = process.env.WF_COMPANY_OUTBOUND;
const WF_CASE_SEARCH = process.env.WF_CASE_SEARCH;
// ========= 你其他所有工作流ID 全部保留在这里，不要删 =========
// const WF_XXX = process.env.WF_XXX;

// SSE工作流接口（你核心路由，其他路由不动）
app.get('/stream', async (req, res) => {
  const { workflow, ...params } = req.query;
  const sendParams = params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (workflow === WF_COMPLAINT) {
      // ================= 【诉状生成分支 - 完全原样保留，一点不改】=================
      let endContent = '';
      const cozeResp = await axios({
        method: "POST",
        url: "https://api.coze.cn/v1/workflow/stream_run",
        headers: {
          Authorization: `Bearer ${COZE_PAT}`,
          "Content-Type": "application/json"
        },
        data: {
          workflow_id: workflow,
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
          if (trimLine.startsWith('data: ')) {
            try {
              const payload = JSON.parse(trimLine.slice(6));
              if (payload.node_title === "End" && payload.content) {
                endContent = payload.content;
              }
            } catch (err) {
              console.log("诉状单包忽略", err.message);
            }
          }
        }
      });
      cozeResp.data.on('end', () => {
        let sendObj;
        try {
          if (!endContent) {
            sendObj = { type: "complaint", data: {} };
          } else {
            const safeStr = endContent
              .replace(/(?<!\\)\n/g, '\\n')
              .replace(/(?<!\\)\r/g, '\\r');
            const jsonData = JSON.parse(safeStr);
            sendObj = { type: "complaint", data: jsonData };
          }
        } catch (e) {
          console.error("诉状解析失败", e, endContent);
          sendObj = { type: "complaint", data: {}, error: "解析失败" };
        }
        const sseMsg = JSON.stringify(sendObj);
        res.write(`data: ${sseMsg}\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      });
      cozeResp.data.on('error', (err) => {
        console.error("诉状流异常", err.message);
        const sendObj = { type: "complaint", data: {}, error: err.message };
        const sseMsg = JSON.stringify(sendObj);
        res.write(`data: ${sseMsg}\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      });
    }
    else if (workflow === WF_CASE_SEARCH) {
      // ===================== 【案例检索：本次修复版本，只有这里改过！】 =====================
      let endContent = '';
      const cozeResp = await axios({
        method: "POST",
        url: "https://api.coze.cn/v1/workflow/stream_run",
        headers: {
          Authorization: `Bearer ${COZE_PAT}`,
          "Content-Type": "application/json"
        },
        data: {
          workflow_id: workflow,
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
          if (trimLine.startsWith('data: ')) {
            try {
              const payload = JSON.parse(trimLine.slice(6));
              if (payload.node_title === "End" && payload.content) {
                endContent = payload.content;
              }
            } catch (err) {
              console.log("案例检索单包解析忽略", err.message);
            }
          }
        }
      });

      cozeResp.data.on('end', () => {
        let sendObj;
        try {
          if (!endContent) {
            sendObj = { type: "case", data: { final_list: [] } };
          } else {
            const safeStr = endContent
              .replace(/(?<!\\)\n/g, '\\n')
              .replace(/(?<!\\)\r/g, '\\r');
            const caseJson = JSON.parse(safeStr);
            sendObj = {
              type: "case",
              data: caseJson
            };
          }
        } catch (e) {
          console.error("案例最终解析失败", e, endContent);
          sendObj = { type: "case", data: { final_list: [] }, error: "数据解析异常" };
        }
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
    }
    else if (workflow === WF_COMPANY_OUTBOUND) {
      // ================= 【企业出海分支 - 完全原样保留，一点不改】=================
      let endContent = '';
      const cozeResp = await axios({
        method: "POST",
        url: "https://api.coze.cn/v1/workflow/stream_run",
        headers: {
          Authorization: `Bearer ${COZE_PAT}`,
          "Content-Type": "application/json"
        },
        data: {
          workflow_id: workflow,
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
          if (trimLine.startsWith('data: ')) {
            try {
              const payload = JSON.parse(trimLine.slice(6));
              if (payload.node_title === "End" && payload.content) {
                endContent = payload.content;
              }
            } catch (err) {
              console.log("企业出海单包忽略", err.message);
            }
          }
        }
      });
      cozeResp.data.on('end', () => {
        let sendObj;
        try {
          if (!endContent) {
            sendObj = { type: "outbound", data: {} };
          } else {
            const safeStr = endContent
              .replace(/(?<!\\)\n/g, '\\n')
              .replace(/(?<!\\)\r/g, '\\r');
            const jsonData = JSON.parse(safeStr);
            sendObj = { type: "outbound", data: jsonData };
          }
        } catch (e) {
          console.error("企业出海解析失败", e, endContent);
          sendObj = { type: "outbound", data: {}, error: "解析失败" };
        }
        const sseMsg = JSON.stringify(sendObj);
        res.write(`data: ${sseMsg}\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      });
      cozeResp.data.on('error', (err) => {
        console.error("企业出海流异常", err.message);
        const sendObj = { type: "outbound", data: {}, error: err.message };
        const sseMsg = JSON.stringify(sendObj);
        res.write(`data: ${sseMsg}\n\n`);
        res.write('data:[DONE]\n\n');
        res.end();
      });
    }
    // ========= 你剩下的其他工作流分支，全部放在这里，保持原样 =========
    // else if (workflow === WF_XXXX) {
    //  你原有代码
    // }
    else {
      res.write(`data: ${JSON.stringify({ error: "workflow 不匹配" })}\n\n`);
      res.write('data:[DONE]\n\n');
      res.end();
    }
  } catch (globalErr) {
    console.error("外层捕获", globalErr);
    const sendObj = { error: "请求异常" };
    res.write(`data: ${JSON.stringify(sendObj)}\n\n`);
    res.write('data:[DONE]\n\n');
    res.end();
  }
});

// 你其他接口（上传、静态页面等）全部保留在这里
// app.post('/upload', upload.single('file'), (req, res) => {
// 你原来上传代码不动
// })

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务启动，端口：${PORT}`);
});
