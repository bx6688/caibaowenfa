require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 环境变量读取
const COZE_PAT = process.env.COZE_PAT;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const WF_OVERSEA = process.env.WF_OVERSEA;
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_CONTRACT = process.env.WF_CONTRACT;
const WF_CASE_SEARCH = process.env.WF_CASE_SEARCH;
const COZE_BASE = "https://api.coze.cn";

// 工具：伪流式分片推送文本（打字机）
async function streamText(res, text) {
    for (const char of text) {
        res.write(`data: ${char}\n\n`);
        await new Promise(r => setTimeout(r, 15));
    }
    res.write(`data: [DONE]\n\n`);
    res.end();
}

// 统一SSE接口
app.get('/api/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const { mode, workflow_id, ...params } = req.query;

    if (mode === 'bot') {
        // 智能体对话
        const { user_id, msg } = params;
        try {
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
                    additional_messages: [
                        {
                            content: msg,
                            content_type: "text",
                            role: "user",
                            type: "question"
                        }
                    ],
                    parameters: {}
                },
                responseType: "stream"
            });
            cozeResp.data.on('data', chunk => {
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
            cozeResp.data.on('error', e => {
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
            cozeResp.data.on('data', chunk => {
                const str = chunk.toString();
                const lines = str.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const obj = JSON.parse(line.replace(/^data: /, ''));
                        // 结束节点输出
                        if (obj.type === "workflow_finish") {
                            resultData = obj.data.output;
                        }
                    } catch (e) {}
                }
            });
            cozeResp.data.on('end', async () => {
                // 案例检索：结构化json直接返回
                if (workflow_id === WF_CASE_SEARCH) {
                    res.write(`data: ${JSON.stringify({type:"case", data:resultData})}\n\n`);
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                } else {
                    // 其余三个：取出文本，打字机推送
                    let outputText = "";
                    if (workflow_id === WF_OVERSEA) outputText = resultData.content;
                    if (workflow_id === WF_COMPLAINT) outputText = resultData.pleading_text;
                    if (workflow_id === WF_CONTRACT) outputText = resultData.output;
                    await streamText(res, outputText);
                }
            });
            cozeResp.data.on('error', e => {
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
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("服务启动，端口：", PORT);
})
