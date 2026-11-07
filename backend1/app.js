require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { EdgeTTS } = require('node-edge-tts');
const { Readable } = require('stream');
const { FormData, File } = require('formdata-node');


const app = express();

app.use(cors());
// 放宽 JSON 体积上限：模拟法庭的 ASR 录音以 base64 提交
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '../yemianwendang')));

// 模拟法庭庭审页快捷入口（页面文件位于 yemianwendang/mock-court）
app.get('/court', (req, res) => {
  res.sendFile(path.join(__dirname, '../yemianwendang/mock-court/index.html'));
});

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

const COZE_PAT = process.env.COZE_PAT;
const BOT_CHAT_ID = process.env.BOT_CHAT_ID;
const WF_COMPLAINT = process.env.WF_COMPLAINT;
const WF_CONTRACT = process.env.WF_CONTRACT;
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
      return res.status(400).json({ ok: false, msg: '未接收到文件' });
    }
    if (!COZE_PAT) {
      return res.status(500).json({ ok: false, msg: '缺少COZE_PAT环境变量' });
    }

    const formData = new FormData();
    const file = new File([req.file.buffer], req.file.originalname, {
      type: req.file.mimetype
    });
    formData.append('file', file);

    // =====重点：删掉 'Content-Type': formData.getContentType() 这一行！=====
    const cozeResp = await axios.post(`${COZE_BASE}/v1/files/upload`, formData, {
      headers: {
        Authorization: `Bearer ${COZE_PAT}`
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
      msg: '文件上传失败'
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

      if (targetWfId === WF_COMPLAINT) {
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


// ========== 文件代理：解决跨域无法 fetch/预览的问题 ==========
app.get('/api/file-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  try {
    // 仅允许 http/https 链接
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: '非法的文件链接' });
    }
    const isCoze = /coze\.cn|coze\.com|byteintlapi\.com|bytegecko\.com/.test(parsed.hostname);
    const headers = {};
    if (isCoze && COZE_PAT) {
      headers.Authorization = `Bearer ${COZE_PAT}`;
    }
    const cozeResp = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 60000
    });
    const contentType = cozeResp.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(cozeResp.data));
  } catch (err) {
    console.error('文件代理失败：', err.message);
    const status = err.response?.status || 502;
    res.status(status).send({ error: err.response?.data || '文件获取失败' });
  }
});


// ==================== 模拟法庭（AI Mock Court） ====================
// 与财宝问法接口路径互不重叠；均使用同源相对路径，便于 Render 单服务部署
// 令牌与密钥仅从环境变量读取，禁止写入仓库
const COURT_COZE_PAT = process.env.COURT_COZE_PAT || process.env.COZE_PAT || '';
const COURT_COZE_BASE = 'https://api.coze.cn';
const COURT_WORKFLOW_IDS = {
  clerk: process.env.COURT_WF_CLERK || '7704894355912654863',
  plaintiff: process.env.COURT_WF_PLAINTIFF || '7704890998191308819',
  defendant: process.env.COURT_WF_DEFENDANT || '7704906743893213224',
  judge: process.env.COURT_WF_JUDGE || '7704907190629515302'
};

// 角色音色与情绪参数（削弱播音腔）
const COURT_TTS_PROFILES = {
  clerk: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+10%', pitch: '+0Hz' },
  plaintiff: { voice: 'zh-CN-XiaoyiNeural', rate: '+0%', pitch: '+15Hz' },
  defendant: { voice: 'zh-CN-YunxiNeural', rate: '-5%', pitch: '-10Hz' },
  judge: { voice: 'zh-CN-YunjianNeural', rate: '-15%', pitch: '-20Hz' }
};

// 腾讯云 ASR（一句话识别）凭证
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || '';
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || '';

// 发起庭审对话（流式代理）
app.post('/api/chat/stream', async (req, res) => {
  const { role, conversationId, message } = req.body || {};
  const workflowId = COURT_WORKFLOW_IDS[role];
  if (!workflowId) return res.status(400).json({ error: 'unknown role' });
  if (!COURT_COZE_PAT) return res.status(500).json({ error: '模拟法庭 COZE 令牌未配置' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';

  try {
    const upstream = await axios({
      method: 'POST',
      url: `${COURT_COZE_BASE}/v1/workflows/chat${query}`,
      headers: {
        Authorization: `Bearer ${COURT_COZE_PAT}`,
        'Content-Type': 'application/json'
      },
      data: {
        workflow_id: workflowId,
        parameters: { CONVERSATION_NAME: 'Default', USER_INPUT: message },
        additional_messages: [
          { role: 'user', content: message, content_type: 'text', type: 'question' }
        ]
      },
      responseType: 'stream',
      validateStatus: () => true
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      let errText = '';
      for await (const chunk of upstream.data) errText += chunk.toString();
      res.write(`event: error\ndata: ${JSON.stringify({ code: upstream.status, msg: errText })}\n\n`);
      res.end();
      return;
    }

    upstream.data.pipe(res);
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 500, msg: e.message })}\n\n`);
    res.end();
  }
});

// 建立 TTS 流，遇到 429 等瞬时错误时重试
async function startCourtTtsStream(text, profile) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const iter = new EdgeTTS({
        voice: profile.voice,
        lang: 'zh-CN',
        rate: profile.rate,
        pitch: profile.pitch,
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        timeout: 20000
      }).streamAudio(text);
      const first = await iter.next();
      return { iter, first };
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

// 庭审语音流式合成（base64 音频块通过 SSE 推送）
app.post('/api/tts/stream', async (req, res) => {
  const { text, role } = req.body || {};
  const profile = COURT_TTS_PROFILES[role];
  if (!profile) return res.status(400).json({ error: 'unknown role' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'empty text' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let audioChunks = 0;
  try {
    const { iter, first } = await startCourtTtsStream(text, profile);
    if (!first.done && Buffer.isBuffer(first.value)) {
      res.write(`data: ${JSON.stringify({ audio: first.value.toString('base64') })}\n\n`);
      audioChunks++;
    }
    for await (const chunk of iter) {
      if (!Buffer.isBuffer(chunk)) continue; // 跳过词边界信息
      res.write(`data: ${JSON.stringify({ audio: chunk.toString('base64') })}\n\n`);
      audioChunks++;
    }
    if (audioChunks === 0) {
      res.write(`event: error\ndata: ${JSON.stringify({ code: 502, msg: 'TTS 未返回音频（上游可能限流）' })}\n\n`);
    } else {
      res.write('event: done\ndata: {}\n\n');
    }
    res.end();
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 500, msg: e.message })}\n\n`);
    res.end();
  }
});

// 腾讯云一句话识别（TC3-HMAC-SHA256 签名）
app.post('/api/asr', async (req, res) => {
  const { audio, voiceFormat = 'wav' } = req.body || {};
  if (!audio) return res.status(400).json({ error: 'missing audio' });
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) {
    return res.status(503).json({ error: '腾讯云 ASR 密钥未配置' });
  }

  const buf = Buffer.from(audio, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty audio' });
  if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'audio too large' });

  const host = 'asr.tencentcloudapi.com';
  const service = 'asr';
  const action = 'SentenceRecognition';
  const version = '2019-06-14';
  const algorithm = 'TC3-HMAC-SHA256';
  const timestamp = Math.floor(Date.now() / 1000);
  const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const payload = JSON.stringify({
    ProjectId: 0,
    SubServiceType: 2,
    EngSerViceType: '16k_zh',
    SourceType: 1,
    VoiceFormat: voiceFormat,
    Data: audio,
    DataLen: buf.length,
    UsrAudioKey: `court-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
  });

  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,
    signedHeaders,
    crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
  ].join('\n');
  const credentialScope = `${dateStr}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n');
  const secretDate = crypto.createHmac('sha256', `TC3${TENCENT_SECRET_KEY}`).update(dateStr, 'utf8').digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service, 'utf8').digest();
  const signingKey = crypto.createHmac('sha256', secretService).update('tc3_request', 'utf8').digest();
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = `${algorithm} Credential=${TENCENT_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const r = await axios({
      method: 'POST',
      url: `https://${host}`,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': 'ap-guangzhou'
      },
      data: payload,
      validateStatus: () => true
    });
    const json = r.data;
    const result = json && json.Response && json.Response.Result;
    if (!result) {
      const msg = (json && json.Response && json.Response.Error && json.Response.Error.Message) || 'ASR 识别失败';
      return res.status(502).json({ error: msg });
    }
    res.json({ text: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`服务启动成功，端口：${PORT}`);
});
