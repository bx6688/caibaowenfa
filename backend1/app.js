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
const OpenAI = require('openai');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { tavily } = require('@tavily/core');


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
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 禁用 Render/Nginx 缓冲，保证逐字流式下发
  res.setHeader('X-Accel-Buffering', 'no');
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
// 大模型接入：智谱 AI（OpenAI 兼容协议）
// 密钥仅从环境变量读取，禁止写入仓库
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || '';
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';

// 模型降级链（严格按优先级，禁止加入 glm-4.7-flash）
const MODEL_CHAIN = ['glm-5.3-flash', 'glm-4-flash'];
const RETRY_DELAYS = [1000, 2000]; // 每个模型最多重试 2 次：1s、2s
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const tavilyClient = TAVILY_API_KEY ? tavily({ apiKey: TAVILY_API_KEY }) : null;
// 百度千帆 AI 搜索（合同审查联网风控的第一优先级）
const BAIDU_SEARCH_API_KEY = process.env.BAIDU_SEARCH_API_KEY || '';

const zhipuClient = new OpenAI({
  apiKey: ZHIPU_API_KEY || 'not-configured',
  baseURL: ZHIPU_BASE_URL,
  timeout: 90000,
  // 关闭 SDK 内置重试，统一由 /api/chat/stream 的指数退避控制
  maxRetries: 0
});

function getErrorStatus(error) {
  return error?.status || error?.statusCode || 0;
}

function getErrorCode(error) {
  const raw = error?.code ?? error?.error?.code ?? error?.response?.data?.error?.code;
  return raw == null ? '' : String(raw);
}

// 429 限流、1305 智谱并发限制、5xx、408 与网络瞬断都可以重试
function isRetryableLLMError(error) {
  const status = getErrorStatus(error);
  if (getErrorCode(error) === '1305') return true;
  if (status === 408 || status === 429 || status >= 500) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up|timeout|fetch failed|terminated/i.test(error?.message || '');
}

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

// 书记员 / 原告 / 被告 / 审判长的角色人设
// 庭审阶段与历史上下文由前端 prompt 传入，这里只负责身份与表达规范
const SYSTEM_PROMPTS = {
  clerk: `你是一名中国基层人民法院的书记员，正在主持模拟法庭的开庭准备环节。
你的职责是宣布法庭纪律、核对当事人到庭情况，并请审判长入席。
表达风格：严肃、规范、简洁，使用规范的法庭用语。
输出要求：
1. 只输出你当庭宣读的台词，不要输出括号旁白、动作描写、标题或自我介绍。
2. 不要复述案情，不要使用任何 Markdown 符号，不要出现“以上为模拟”之类的提示。
3. 控制在 100-200 个汉字，一次讲完，语气平稳。`,

  plaintiff: `你是一起民事案件中的原告（或原告代理人），正在参加模拟法庭庭审。
你的立场：依法维护原告的合法权益，围绕案情陈述诉讼请求、出示证据、发表质证意见并参与辩论，必要时回应审判长的发问。
表达风格：条理清晰、态度坚定、用词口语化，但不情绪化、不人身攻击。
输出要求：
1. 只输出你当庭说的话，不要输出括号旁白、动作描写或心理活动。
2. 紧扣【当前阶段】和庭审记录，不重复前面已经讲过的内容。
3. 不要编造与案情无关的事实，不要使用任何 Markdown 符号。
4. 控制在 100-200 个汉字。`,

  defendant: `你是一起民事案件中的被告（或被告代理人），正在参加模拟法庭庭审。
你的立场：依法答辩，针对原告的诉讼请求与证据提出抗辩和质证意见，参与法庭辩论，必要时回应审判长的发问。
表达风格：冷静、克制、条理清晰，用词口语化，但不情绪化、不人身攻击。
输出要求：
1. 只输出你当庭说的话，不要输出括号旁白、动作描写或心理活动。
2. 紧扣【当前阶段】和庭审记录，不重复前面已经讲过的内容。
3. 不要编造与案情无关的事实，不要使用任何 Markdown 符号。
4. 控制在 100-200 个汉字。`,

  judge: `你是一起民事案件的审判长，主持模拟法庭庭审。
你的职责：按阶段组织法庭调查、举证质证与法庭辩论，归纳争议焦点，必要时向双方发问，最后评议并宣判。
表达风格：中立、权威、简洁，使用规范的法庭用语。
输出要求：
1. 只输出你当庭说的话，不要输出括号旁白、动作描写或标题。
2. 归纳争议焦点要明确、凝练；宣判时给出清晰的处理结果和简要理由。
3. 不偏向任何一方，不重复前文已经讲过的内容，不要使用任何 Markdown 符号。
4. 控制在 100-220 个汉字。`
};

const COURT_ROLES = Object.keys(SYSTEM_PROMPTS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 通用模型降级网关：按 MODEL_CHAIN 流式输出 SSE（调用前必须已写好响应头）
// 每个模型失败后按 1s、2s 退避重试，重试 2 次仍失败则自动降级到下一个模型
async function streamModelChain(res, messages, { temperature = 0.3, reasoningEffort = 'low' } = {}) {
  let clientClosed = false;
  let sentContent = false;
  res.on('close', () => {
    if (!res.writableEnded) clientClosed = true;
  });

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (clientClosed) return;

      try {
        const stream = await zhipuClient.chat.completions.create({
          model,
          messages,
          stream: true,
          temperature,
          // 降低思考强度，显著缩短首字前的推理耗时（glm-5.3-flash 实测 58s → 1.3s）
          reasoning_effort: reasoningEffort
        });

        for await (const chunk of stream) {
          if (clientClosed) return;
          const delta = chunk.choices?.[0]?.delta;
          // 只转发正文，reasoning_content（思考过程）绝对不进入前端与 TTS
          const content = delta?.content || '';
          if (!content) continue;
          sentContent = true;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        if (!clientClosed) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      } catch (error) {
        if (clientClosed) return;

        const status = getErrorStatus(error);
        const code = getErrorCode(error);

        // Key 无效：不重试、不降级，直接告知前端并关闭
        if (status === 401) {
          console.error('智谱 API Key 无效：', error?.message);
          res.write(`data: ${JSON.stringify({ error: 'API Key 无效' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 已经吐过字就不能重试或换模型，否则前端会收到重复内容；直接收尾
        if (sentContent) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (!isRetryableLLMError(error)) {
          console.error(`模型 ${model} 调用失败（不可重试）：`, error?.message);
          res.write(`data: ${JSON.stringify({ error: '大模型请求失败，请重试' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        console.error(
          `模型 ${model} 第 ${attempt + 1} 次失败（status=${status}, code=${code || '-'}）：`,
          error?.message
        );

        if (attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          console.log(`${delay}ms 后重试模型 ${model}…`);
          await sleep(delay);
          continue;
        }

        const nextModel = MODEL_CHAIN[i + 1];
        console.log(nextModel
          ? `模型 ${model} 重试耗尽，降级到 ${nextModel}`
          : `模型 ${model} 重试耗尽，已无备用模型`);
      }
    }
  }

  if (!clientClosed) {
    res.write(`data: ${JSON.stringify({ error: '大模型暂不可用，请稍后重试' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 发起庭审对话：智谱 AI 流式透传（统一为 data: {"content": "..."} + data: [DONE]）
app.post('/api/chat/stream', async (req, res) => {
  const { role, message } = req.body || {};
  if (!COURT_ROLES.includes(role)) return res.status(400).json({ error: 'unknown role' });
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'empty message' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：禁用 Render/Nginx 的响应缓冲，收到多少立刻下发多少
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Key 缺失同样走 SSE，前端能直接展示错误文案
  if (!ZHIPU_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'API Key 未配置' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPTS[role] },
    { role: 'user', content: String(message) }
  ];

  await streamModelChain(res, messages);
});

// ========== 诉状生成：替代原有 Coze 工作流 ==========
// 响应格式与模拟法庭一致：data: {"content": "..."} + data: [DONE]
const PLEADING_REQUIRED_FIELDS = ['lawsuit_type', 'plaintiff_name', 'defendant_name', 'case_content', 'claim_main'];

function buildPleadingPrompt(d) {
  return `你是专业法律文书助手，严格依照法院现行民事诉讼文书样式撰写民事起诉状，案件类型：【${d.lawsuit_type}】。

一、当事人信息
原告：
身份类型：${d.plaintiff_type || ''}
姓名/名称：${d.plaintiff_name}
住址/住所地：${d.plaintiff_address || ''}
联系电话：${d.plaintiff_phone || ''}

被告：
身份类型：${d.defendant_type || ''}
姓名/名称：${d.defendant_name}
住址/住所地：${d.defendant_address || ''}
联系电话：${d.defendant_phone || ''}

二、基础案情
案件事实经过：${d.case_content}
证据清单：${d.case_evidence || ''}
用户手动填写的法律依据：${d.case_law_basis || ''}

三、诉讼请求原文
1.主要请求：${d.claim_main}
2.金额/具体请求：${d.claim_amount || ''}
3.其他请求：${d.claim_other || ''}

四、强制写作规则（必须逐条遵守，不得违反）
1. 法律依据补充规则：
如果 用户手动填写的法律依据 为空或无，你必须结合本案案由、案件事实、证据，匹配现行有效的法律条文（《民法典》《劳动合同法》《民事诉讼法》及对应司法解释），写明法律名称+具体条款，法条必须真实有效，严禁虚构、编造不存在的法条；
如果 用户手动填写的法律依据 不为空，优先使用用户提供的法律依据，仅做语句润色，不得私自更换法条。

2. 格式硬性要求：
严格使用法院标准民事起诉状纯文本格式，顺序：标题、原被告信息、诉讼请求、事实与理由、此致、横线填写受理法院名称、具状人、日期；
只输出起诉状正文，方便前端预览和导出Word，绝对不要输出任何多余的 Markdown 标记（除了纯文本排版所需的换行）或思考过程。

3. 占位横线规则【重点】：
禁止你自行填写法院名称、自行生成编造任何年月日数字。
“此致”单独一行；下一行输出：______________________人民法院
判断 原告姓名/名称：
若 原告姓名/名称 有内容，则写：具状人：${d.plaintiff_name}
若 原告姓名/名称 为空，则写：具状人：__________
下一行统一写：日期：__________

4. 行文规范：
语言书面严谨，客观陈述案情。事实与理由部分先梳理案件经过，结合证据说理，最后附上匹配的法律依据支撑诉讼请求。`;
}

app.post('/api/legal/pleading', async (req, res) => {
  const d = req.body || {};

  // 核心必填项缺失直接拒绝
  if (PLEADING_REQUIRED_FIELDS.some((key) => !String(d[key] || '').trim())) {
    return res.status(400).json({ error: '核心必填信息缺失' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：禁用 Render/Nginx 的响应缓冲，收到多少立刻下发多少
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!ZHIPU_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'API Key 未配置' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const messages = [
    { role: 'system', content: buildPleadingPrompt(d) },
    { role: 'user', content: '请严格按照上述材料与写作规则，输出民事起诉状正文。' }
  ];

  // 法律文书要求严谨，温度降到 0.1
  await streamModelChain(res, messages, { temperature: 0.1 });
});

// ========== 智能对话：财宝问法 ==========
const LEGAL_CHAT_PROMPT = `# 角色设定
你是“财宝问法”——一位专业、克制、易懂的中国法律AI助手。你具备扎实的法律理论功底与实务经验。

# 性格与语气
- 专业严谨但不居高临下，像一位耐心的事务所前辈。
- 用大白话解释法律术语，避免堆砌法言法语。
- 态度中立，不煽动情绪，不替用户做决策，只摆事实、讲选项、析后果。

# 能力边界（必须牢记）
1. 仅基于现行有效法律条文分析，不臆造法条，不引用已失效规定。
2. 你的输出是【法律科普与分析】，不构成正式法律意见，不替代执业律师。
3. 信息不足时先追问，不盲目下结论；拿不准时明确说“这一点需要进一步核实”。
4. 严禁承诺胜诉率、判决结果，严禁指导任何违法操作。
5. 不处理与法律无关的闲聊型请求（引导回法律场景）。

# 回复逻辑（每次回复严格按以下流程执行）
1. 判断信息是否完整：若缺少关键信息（如纠纷类型、发生时间、诉求等），先向用户提问补充。
2. 若信息完整，直接按“结论 -> 法律分析 -> 建议”的结构输出。

# 输出格式（硬性要求）
- 只输出纯文本，严禁任何 Markdown 标记：不要出现 **、#、##、-、*、> 等符号，不要输出表格、代码块或加粗标题。
- 需要分段时用空行，需要列举时用「一、」「1.」「（1）」这类纯文本序号。
- 用中文标点，保持口语化、可直接朗读的书面表达。`;

app.post('/api/legal/chat', async (req, res) => {
  const { message, history, imageBase64 } = req.body || {};
  const text = String(message || '').trim();
  if (!text && !imageBase64) return res.status(400).json({ error: '消息内容不能为空' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：禁用 Render/Nginx 的响应缓冲，收到多少立刻下发多少
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!ZHIPU_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'API Key 未配置' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  let userMessage = text;

  // 有图片时先用多模态模型提取信息，再把提取结果拼到用户文字前面
  if (imageBase64) {
    try {
      const visionRes = await zhipuClient.chat.completions.create({
        model: 'glm-4v-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageBase64 } },
            { type: 'text', text: '请提取图片中的法律相关文字或描述图片内容。' }
          ]
        }]
      });
      const extracted = visionRes.choices?.[0]?.message?.content || '';
      userMessage = `[用户上传了图片，提取信息：${extracted}]\n用户文字：${text}`;
    } catch (error) {
      console.error('图片解析失败：', error?.message);
      // 纯图片且解析失败时没有可继续的内容
      if (!text) {
        res.write(`data: ${JSON.stringify({ error: '图片解析失败，请重新上传' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }
  }

  // 只接受 user/assistant 文本消息，避免客户端注入 system 角色
  const safeHistory = Array.isArray(history)
    ? history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  const messages = [
    { role: 'system', content: LEGAL_CHAT_PROMPT },
    ...safeHistory,
    { role: 'user', content: userMessage }
  ];

  // 咨询场景温度略高于庭审，表达更自然
  await streamModelChain(res, messages, { temperature: 0.4 });
});

// ========== 合同审查：文件解析 + 企业风控检索 ==========
// 解析上传文件中的纯文本（支持 PDF / Word / 纯文本）
async function parseDocument(file) {
  if (!file) return '';
  try {
    if (file.mimetype === 'application/pdf') {
      const data = await pdf(file.buffer);
      return data.text;
    } else if (file.mimetype.includes('word') || file.mimetype.includes('officedocument')) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    } else if (file.mimetype === 'text/plain') {
      return file.buffer.toString('utf-8');
    }
    return '';
  } catch (error) {
    console.error('解析文件出错:', error?.message);
    return '';
  }
}

// 从合同文本中提取甲方/委托方公司全称（轻量模型同步调用）
async function extractCompanyName(contractText) {
  try {
    const response = await zhipuClient.chat.completions.create({
      model: 'glm-4-flash',
      messages: [
        { role: 'system', content: '你是一个专业的信息提取助手。' },
        { role: 'user', content: `请从以下合同文本中提取“甲方”或“委托方”的准确公司全称。只输出公司名称，不要输出任何标点符号或额外解释。如果没有找到，请输出“未找到”。\n\n合同文本：\n${contractText.substring(0, 3000)}` }
      ],
      temperature: 0.1
    });
    return (response.choices?.[0]?.message?.content || '').trim() || '未找到';
  } catch (e) {
    console.error('提取企业名称失败:', e?.message);
    return '未找到';
  }
}

// 给任意 Promise 加超时，避免某个搜索源卡死拖住整个审查流程
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 百度千帆 AI 搜索（第一优先级）
async function searchWithBaidu(companyName) {
  if (!BAIDU_SEARCH_API_KEY) return null;

  try {
    console.log(`[Baidu] 正在搜索: ${companyName}`);
    const response = await axios.post(
      'https://qianfan.baidubce.com/v2/ai_search/web_search',
      {
        messages: [{ role: 'user', content: `${companyName} 工商信息 经营状态 法律诉讼 风险` }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: 10 }],
        edition: 'standard'
      },
      {
        headers: {
          Authorization: `Bearer ${BAIDU_SEARCH_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const refs = response.data && response.data.references;
    if (!Array.isArray(refs) || refs.length === 0) {
      console.warn('[Baidu] 未返回有效结果。');
      return null;
    }

    const text = refs
      .map((item, index) => {
        const title = String(item?.title || '').trim();
        const snippet = String(item?.snippet || item?.content || '').trim();
        if (!title && !snippet) return '';
        return `${index + 1}. ${title}${snippet ? '：' + snippet : ''}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!text) return null;
    console.log(`[Baidu] 搜索成功，${refs.length} 条结果。`);
    return text;
  } catch (error) {
    console.error('[Baidu] 搜索失败:', error?.message);
    return null;
  }
}

// Tavily 联网搜索（第二优先级兜底），统一返回纯文本
async function searchWithTavily(companyName) {
  if (!tavilyClient) return null;

  try {
    console.log(`[Tavily] 正在搜索: ${companyName}`);
    const response = await withTimeout(
      tavilyClient.search(
        `${companyName} 工商信息 经营状态 法律诉讼 被执行人 风险`,
        {
          searchDepth: 'basic',      // 基础搜索，速度快、额度消耗低
          includeAnswer: 'basic',    // 返回一段聚合摘要
          maxResults: 5
        }
      ),
      15000,
      'Tavily'
    );

    // 优先使用聚合摘要
    if (response && response.answer) {
      console.log('[Tavily] 搜索成功（使用 answer）。');
      return response.answer;
    }

    // 没有摘要时拼接 results
    const results = Array.isArray(response?.results) ? response.results : [];
    const text = results
      .map((item, index) => {
        const title = String(item?.title || '').trim();
        const snippet = String(item?.content || item?.snippet || '').trim();
        if (!title && !snippet) return '';
        return `${index + 1}. ${title}${snippet ? '：' + snippet : ''}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!text) {
      console.warn('[Tavily] 未返回有效结果。');
      return null;
    }
    console.log(`[Tavily] 搜索成功（拼接 ${results.length} 条结果）。`);
    return text;
  } catch (error) {
    console.error('[Tavily] 搜索失败:', error?.message);
    return null;
  }
}

// 统一调度：百度优先，Tavily 兜底
async function searchCompanyInfo(companyName) {
  if (!companyName || companyName === '未找到') return null;

  // 第一优先：百度搜索
  let result = await searchWithBaidu(companyName);
  if (result) return { source: '百度搜索', text: result };

  // 第二优先：Tavily 兜底
  console.warn('[Search] 百度未返回有效结果，降级到 Tavily...');
  result = await searchWithTavily(companyName);
  if (result) return { source: 'Tavily', text: result };

  return null; // 全部失败
}

app.post('/api/legal/contract', upload.single('file'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关键：禁用 Render/Nginx 的响应缓冲，收到多少立刻下发多少
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    if (!req.file) {
      res.write(`data: ${JSON.stringify({ error: '请上传合同文件' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (!ZHIPU_API_KEY) {
      res.write(`data: ${JSON.stringify({ error: 'API Key 未配置' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const contractText = await parseDocument(req.file);
    if (!contractText.trim()) {
      res.write(`data: ${JSON.stringify({ error: '无法解析文件内容，请检查文件格式' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 优先使用前端手动传入的企业名称，否则从合同中提取
    let companyName = String(req.body.company_name || '').trim();
    if (!companyName) companyName = await extractCompanyName(contractText);

    let companyInfoText = '';
    if (companyName && companyName !== '未找到') {
      const searchResult = await searchCompanyInfo(companyName);

      if (searchResult) {
        companyInfoText = `企业名称：${companyName}\n检索来源：${searchResult.source}\n联网检索摘要：\n${searchResult.text}`;
      } else {
        companyInfoText = `企业名称：${companyName}\n风险提示：百度与 Tavily 均未能获取该企业的实时公开风险信息，请人工核实其经营状态与涉诉情况。`;
      }
    } else {
      companyInfoText = '风险提示：合同文本中未明确识别到甲方公司全称，无法进行外部联网风控核查。';
    }

    const systemPrompt = `你是一名资深企业法律顾问及风控分析师。请基于提供的【合同文本】和【企业风控数据】进行全面审查，并输出专业的 Markdown 格式审查报告。

【企业风控数据】
${companyInfoText}

【合同文本】
${contractText}

【输出格式要求（严格按此结构输出Markdown，不要输出多余内容）】
## 一、相对方企业风控画像
（基于风控数据，列出“重大”或“关注”风险。如无数据，写“未发现公开重大风险记录”或沿用提示内容）

## 二、合同基本信息
（合同类型、主体、签订背景）

## 三、条款逐项审查
必须覆盖：1. 主体资格 2. 标的与价款 3. 履行期限 4. 违约责任 5. 解除权 6. 争议解决 7. 知识产权 8. 其他显著不公平条款。
（每条包含：**条款摘要**、**风险等级（高/中/低）**、**问题分析**、**修改建议**）

## 四、总体评价
- 整体风险评级（高/中/低）+ 一段总评
- 必须修改条款清单（按优先级排序）

## 五、法律依据清单
（格式：- 《法律全称》第X条：条文核心句。不确定的写“依据待核实”，禁止臆造）

【硬性要求】
每条意见必须落到合同具体文字，禁止泛泛而谈。报告结尾注明：本审查意见仅供参考，不构成正式法律意见。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请开始审查并输出报告。' }
    ];

    // 合同审查要求严谨，温度降到 0.1
    await streamModelChain(res, messages, { temperature: 0.1 });
  } catch (error) {
    console.error('合同审查接口报错:', error);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    }
    res.write(`data: ${JSON.stringify({ error: '服务器内部错误，审查失败' })}\n\n`);
    res.write('data: [DONE]\n\n');
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
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 禁用代理缓冲，语音分片实时下发
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

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
