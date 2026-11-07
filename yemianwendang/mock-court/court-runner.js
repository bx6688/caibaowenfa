import { parseCozeSSE } from './sse-parser.js';

// 清洗模型返回的文本：剔除不可见控制字符，并吃掉流末尾多出来的 } 或 "}（Coze 工作流纯文本节点偶发）
function sanitizeText(text) {
  let clean = String(text || '').replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
  clean = clean.replace(/\s*["']?\}\s*$/, '');
  return clean;
}

const state = {
  caseText: '',
  conversations: {},
  mode: 'auto',           // 'auto' | 'role' | 'interactive'
  fixedUserRole: 'none',  // role 模式下用户扮演的角色
  globalMemory: '',
  interruptRequested: false, // 呼叫审判长（AI 审判长质询）
  interruptMode: 'ai',
  cancelled: false,
  abortController: null,
};

// 中止整场庭审：置位取消标记并中断进行中的请求
export function stopCourt() {
  state.cancelled = true;
  state.interruptRequested = false;
  state.interruptMode = 'ai';
  if (state.abortController) {
    try {
      state.abortController.abort();
    } catch (e) {}
  }
}

// 用户点击「呼叫审判长」时置位，由 AI 审判长介入质询
export function requestJudgeInterrupt(mode = 'ai') {
  state.interruptRequested = true;
  state.interruptMode = 'ai';
}

async function maybeJudgeInterrupt(currentRoleKey) {
  if (state.cancelled || !state.interruptRequested || currentRoleKey === 'judge') return;
  state.interruptRequested = false;
  state.interruptMode = 'ai';
  if (window.onInterruptState) window.onInterruptState(false);
  await executeStep('judge', '庭审干预', `【当前阶段：庭审干预】\n请结合当前庭审进展，向双方进行质询。\n{context}`, false);
}

async function callBot(roleKey, prompt, onDelta) {
  const controller = new AbortController();
  state.abortController = controller;

  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: roleKey, conversationId: state.conversations[roleKey] || null, message: prompt }),
      signal: controller.signal,
    });

    let accumulated = '';
    let errorMsg = '';

    await parseCozeSSE(resp.body, ({ event, data }) => {
      // 对话流会在首个事件里返回 conversation_id，复用即可保持该角色的庭审上下文
      if (data.conversation_id) state.conversations[roleKey] = data.conversation_id;

      if (event === 'error') {
        errorMsg = data.msg || 'Coze 请求失败';
      } else if (event === 'conversation.message.delta' && data.type === 'answer' && data.content) {
        accumulated += sanitizeText(data.content);
        if (onDelta) onDelta(accumulated);
      } else if (event === 'conversation.message.completed' && data.type === 'answer' && !accumulated && data.content) {
        accumulated = sanitizeText(data.content);
        if (onDelta) onDelta(accumulated);
      }
    });

    accumulated = sanitizeText(accumulated); // 兜底：吃掉流末尾多出来的脏字符
    if (errorMsg) throw new Error(errorMsg);
    return accumulated;
  } catch (e) {
    if (state.cancelled) return ''; // 用户中止庭审
    throw e;
  } finally {
    if (state.abortController === controller) state.abortController = null;
  }
}

function remember(displayRole, stepName, text) {
  state.globalMemory += `\n[${displayRole} - ${stepName}]: ${text}`;
  const MAX_MEMORY_LENGTH = 1500;
  if (state.globalMemory.length > MAX_MEMORY_LENGTH) {
    const recentMemory = state.globalMemory.slice(-1200);
    state.globalMemory = `[案情简介]：${state.caseText}\n...[中间庭审记录已省略]...` + recentMemory;
  }
}

async function executeStep(roleKey, stepName, promptTemplate) {
  if (state.cancelled) return '';
  const roleNameMap = { clerk: '书记员', plaintiff: '原告/原告代理人', defendant: '被告/被告代理人', judge: '审判长' };
  const displayRole = roleNameMap[roleKey];

  // —— 判断是否由用户接管发言 ——
  // 模式2（第一人称控辩）：轮到用户扮演的角色时由用户发言
  // 模式3（动态实时接管）：每个角色发言前都询问用户是否接管
  let shouldAskUser = false;
  if (state.mode === 'role' && state.fixedUserRole === roleKey) {
    shouldAskUser = true;
  } else if (state.mode === 'interactive') {
    shouldAskUser = true;
  }

  if (shouldAskUser && window.onAskTakeover) {
    const userInput = await window.onAskTakeover(displayRole, stepName);
    if (state.cancelled) return '';
    if (userInput !== null) {
      const text = userInput.trim();
      if (window.onRealtimeStart) window.onRealtimeStart(displayRole, stepName, true);
      if (window.onRealtimeUpdate) window.onRealtimeUpdate(text);
      remember(displayRole, stepName, text);
      if (window.onMessageDone) window.onMessageDone();
      if (window.onSpeechDone) window.onSpeechDone(roleKey, text);
      await maybeJudgeInterrupt(roleKey);
      return text;
    }
    // 用户跳过 → 交由 AI 发言
  }

  const prompt = promptTemplate.replace('{context}', state.globalMemory);

  if (window.onRealtimeStart) window.onRealtimeStart(displayRole, stepName, false);

  let text = await callBot(roleKey, prompt, (partialText) => {
    if (window.onRealtimeUpdate) window.onRealtimeUpdate(partialText);
  });

  if (state.cancelled) return '';

  remember(displayRole, stepName, text);

  if (window.onMessageDone) window.onMessageDone();
  if (window.onSpeechDone) window.onSpeechDone(roleKey, text);
  await maybeJudgeInterrupt(roleKey);
  return text;
}

export async function runCourt({ caseText, onMessage, onAskTakeover, mode = 'auto', userRole = 'none', debateRounds = 2, onSpeechDone }) {
  state.caseText = caseText;
  state.mode = mode;
  state.fixedUserRole = userRole;
  state.globalMemory = `案情简介：${caseText}`;
  state.conversations = {}; // 每场庭审重新建立对话流会话
  state.interruptRequested = false;
  state.cancelled = false;
  state.abortController = null;

  window.onAskTakeover = onAskTakeover;
  window.onRealtimeStart = (role, step, takeover) => onMessage('start', { role, step, takeover: !!takeover, content: '' });
  window.onRealtimeUpdate = (partial) => onMessage('update', { content: partial });
  window.onMessageDone = () => onMessage('done', {});
  window.onSpeechDone = onSpeechDone || null;

  // 阶段一：开庭准备
  await executeStep('clerk', '开庭准备', `【当前阶段：开庭准备】\n请宣读法庭纪律。案情简述：${caseText}`);

  // 阶段二：法庭调查
  await executeStep('plaintiff', '宣读起诉书', `【当前阶段：法庭调查-宣读起诉书】\n请宣读起诉书。\n{context}`);
  await executeStep('defendant', '答辩意见', `【当前阶段：法庭调查-答辩意见】\n请发表答辩意见。\n{context}`);

  // 阶段三：举证质证
  await executeStep('plaintiff', '质证', `【当前阶段：举证质证】\n请针对被告的答辩出示证据。\n{context}`);
  await executeStep('defendant', '质证', `【当前阶段：举证质证】\n请针对原告出示的证据发表质证意见。\n{context}`);

  // 阶段四：归纳争议焦点
  await executeStep('judge', '归纳争议焦点', `【当前阶段：归纳争议焦点】\n请根据双方发言归纳争议焦点。\n{context}`);

  // 阶段五：法庭辩论
  await executeStep('plaintiff', '辩论-陈述意见', `【当前阶段：辩论-陈述意见】\n请针对焦点陈述意见。\n{context}`);
  await executeStep('defendant', '辩论-陈述意见', `【当前阶段：辩论-陈述意见】\n请针对焦点陈述意见。\n{context}`);

  // 辩论循环（轮数由用户设定）
  for (let round = 1; round <= debateRounds; round++) {
    await executeStep('plaintiff', `辩论-第${round}轮交锋`, `【当前阶段：辩论-第${round}轮焦点交锋】\n请反驳被告。\n{context}`);
    await executeStep('defendant', `辩论-第${round}轮交锋`, `【当前阶段：辩论-第${round}轮焦点交锋】\n请反驳原告。\n{context}`);
  }

  await executeStep('plaintiff', '辩论-最后意见', `【当前阶段：辩论-最后意见】\n请发表最后意见。\n{context}`);
  await executeStep('defendant', '辩论-最后意见', `【当前阶段：辩论-最后意见】\n请发表最后意见。\n{context}`);

  // 阶段六：宣判
  await executeStep('judge', '评议与宣判', `【当前阶段：评议与宣判】\n请宣读判决结果及理由。\n{context}`);
}

