require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../yemianwendang')));

const storage = multer.memoryStorage();
const upload = multer({
storage: storage,
limits: { fileSize: 50 * 1024 * 1024 }
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
return res.status(500).json({ ok: false, msg: '服务缺少COZE_PAT令牌配置' });
}

const formData = new FormData();
formData.append('file', req.file.buffer, {
    filename: req.file.originalname,
    contentType: req.file.mimetype
});

const cozeResp = await axios.post(`${COZE_BASE}/v1/files/upload`, formData, {
headers: {
"Authorization": `Bearer ${COZE_PAT}`,
...formData.getHeaders()
},
timeout: 120000
});

const ret = cozeResp.data;
if(ret.code !== 0 || !ret.data?.id){
return res.status(500).json({
ok: false,
msg: ret.msg || "Coze文件上传失败"
});
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
if(file_id && file_id.trim() !== '' && (!realText || realText.trim() === '')){
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
// ========== 【修复重复的核心改动：buffer缓存，只下发完整行】 ==========
let buffer = "";
cozeResp.data.on('data', chunk => {
buffer += chunk.toString();
const lines = buffer.split('\n');
buffer = lines.pop(); // 剩下不完整的片段留在buffer，等下一次chunk拼接
for (const line of lines) {
if (!line.trim()) continue;
res.write(`${line}\n\n`);
}
});
cozeResp.data.on('end', () => {
if(buffer.trim()){
    res.write(`${buffer}\n\n`);
}
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
let buffer = "";
cozeResp.data.on('data', chunk => {
buffer += chunk.toString();
const lines = buffer.split('\n');
buffer = lines.pop();
for (const line of lines) {
if (!line.trim()) continue;
try {
const obj = JSON.parse(line.replace(/^data: /, ''));
if (obj.type === "workflow_finish") {
resultData = obj.data.output;
}
} catch (e) {}
}
});
cozeResp.data.on('end', async () => {
if (workflow_id === WF_CASE_SEARCH) {
res.write(`data: ${JSON.stringify({type:"case", data:resultData})}\n\n`);
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
