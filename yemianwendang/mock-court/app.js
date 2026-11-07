import { runCourt, requestJudgeInterrupt, stopCourt } from './court-runner.js';
import { parseCozeSSE } from './sse-parser.js';

// ---------- 角色 ----------
const ROLES = {
  clerk: {
    name: '书记员', avatar: '书', color: '#3f6f96', seat: '书记员席',
    intro: {
      title: '书记员',
      en: 'Court Clerk',
      body: [
        '<span class="tag">职责</span>负责庭前准备、宣读法庭纪律、核验当事人身份、记录庭审全过程，并在庭审结束后协助整理笔录与归档。',
        '<span class="tag">定位</span>庭审程序的"守护者"，确保每一个环节合法、有序、留痕。',
        '<span class="tag">常见动作</span>宣读纪律 · 询问是否申请回避 · 当庭记录 · 校对笔录签字'
      ]
    }
  },
  plaintiff: {
    name: '原告/原告代理人', avatar: '原', color: '#c24158', seat: '原告席（含代理人）',
    intro: {
      title: '原告 / 原告代理人',
      en: 'Plaintiff',
      body: [
        '<span class="tag">职责</span>提起民事诉讼，陈述诉讼请求与事实理由，出示证据证明己方主张，并对被告的答辩进行质证与反驳。',
        '<span class="tag">定位</span>诉讼的发起方，承担"谁主张谁举证"的主要举证责任。',
        '<span class="tag">常见动作</span>宣读起诉书 · 出示证据 · 质证 · 法庭辩论 · 最后陈述'
      ]
    }
  },
  defendant: {
    name: '被告/被告代理人', avatar: '被', color: '#2f9d76', seat: '被告席（含代理人）',
    intro: {
      title: '被告 / 被告代理人',
      en: 'Defendant',
      body: [
        '<span class="tag">职责</span>针对原告的诉讼请求进行答辩，提出抗辩理由，对原告证据发表质证意见，并在辩论阶段反驳原告主张。',
        '<span class="tag">定位</span>被诉一方，有权进行抗辩、反诉及举证证明己方无责或减责。',
        '<span class="tag">常见动作</span>提交答辩状 · 发表答辩意见 · 质证 · 法庭辩论 · 最后陈述'
      ]
    }
  },
  judge: {
    name: '审判长', avatar: '审', color: '#9a7428', seat: '审判席',
    intro: {
      title: '审判长',
      en: 'Presiding Judge',
      body: [
        '<span class="tag">职责</span>主持庭审全过程，归纳争议焦点，组织举证质证与法庭辩论，保障当事人诉讼权利，并在评议后依法作出判决。',
        '<span class="tag">定位</span>庭审的主导者与裁判者，中立、公正地引导诉讼程序并最终定纷止争。',
        '<span class="tag">常见动作</span>宣布开庭 · 归纳焦点 · 询问当事人 · 组织辩论 · 评议宣判'
      ]
    }
  }
};
const roleKeyByName = { '书记员': 'clerk', '原告/原告代理人': 'plaintiff', '被告/被告代理人': 'defendant', '审判长': 'judge' };

// ---------- DOM ----------
const chatLog = document.getElementById('chat-log');
const chatEmpty = document.getElementById('chat-empty');
const recordCount = document.getElementById('record-count');
const scene = document.getElementById('scene');
const sceneStatus = document.getElementById('scene-status');
const liveDot = document.getElementById('live-dot');
const turnLabel = document.getElementById('turn-label');
const progressBar = document.getElementById('progress-bar');
const ttsToggle = document.getElementById('tts-toggle');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const caseInput = document.getElementById('case-input');
const debateRoundsInput = document.getElementById('debate-rounds');
const interruptBtn = document.getElementById('interrupt-judge-btn');
const exportBtn = document.getElementById('export-btn');
const resetBtn = document.getElementById('reset-btn');
const gavelSound = document.getElementById('gavel-sound');
const toastEl = document.getElementById('toast');

const takeoverBar = document.getElementById('takeover-bar');
const takeoverRoleSpan = document.getElementById('takeover-role');
const takeoverInput = document.getElementById('takeover-input');
const takeoverConfirm = document.getElementById('takeover-confirm');
const takeoverSkip = document.getElementById('takeover-skip');
const takeoverMic = document.getElementById('takeover-mic');

const roleFigures = {
  clerk: document.querySelector('.figure[data-role="clerk"]'),
  plaintiff: document.querySelector('.figure[data-role="plaintiff"]'),
  defendant: document.querySelector('.figure[data-role="defendant"]'),
  judge: document.querySelector('.figure[data-role="judge"]')
};

// ---------- 角色介绍面板 ----------
const charInfoPanel = document.getElementById('char-info-panel');
const charInfoRole = document.getElementById('char-info-role');
const charInfoSub = document.getElementById('char-info-sub');
const charInfoBody = document.getElementById('char-info-body');
const charInfoClose = document.getElementById('char-info-close');

function showCharInfo(roleKey) {
  const r = ROLES[roleKey];
  if (!r || !r.intro) return;
  charInfoRole.textContent = r.intro.title;
  charInfoSub.textContent = r.intro.en;
  charInfoBody.innerHTML = r.intro.body.map(p => `<p>${p}</p>`).join('');
  charInfoPanel.classList.remove('hidden');
  // 滚动到面板
  charInfoPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
charInfoClose.addEventListener('click', () => charInfoPanel.classList.add('hidden'));

// 给每个角色 figure 绑定点击：role 模式下选择扮演角色，否则显示介绍
let selectedUserRole = null; // 'clerk' | 'plaintiff' | 'defendant' | 'judge' | null
Object.entries(roleFigures).forEach(([key, el]) => {
  if (el) el.addEventListener('click', () => {
    // 第一人称控辩模式且未开庭时，点击角色选择扮演对象
    if (currentMode === 'role' && !trial.running) {
      selectUserRole(key);
    } else {
      showCharInfo(key);
    }
  });
});

// 选择用户扮演的角色（第一人称控辩模式）
function selectUserRole(roleKey) {
  selectedUserRole = roleKey;
  Object.entries(roleFigures).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('role-selected', key === roleKey);
  });
  toast(`已选择扮演：${ROLES[roleKey].name}`);
}
const roleBubbles = {
  clerk: document.getElementById('speech-clerk'),
  plaintiff: document.getElementById('speech-plaintiff'),
  defendant: document.getElementById('speech-defendant'),
  judge: document.getElementById('speech-judge')
};
const spotlight = document.getElementById('spotlight');
const sceneTakeover = document.getElementById('scene-takeover');
const sceneTakeoverTitle = document.getElementById('scene-takeover-title');
const sceneTakeoverInput = document.getElementById('scene-takeover-input');
const sceneTakeoverConfirm = document.getElementById('scene-takeover-confirm');
const sceneTakeoverSkip = document.getElementById('scene-takeover-skip');
const sceneTakeoverMic = document.getElementById('scene-takeover-mic');

// ---------- 庭审状态 ----------
const trial = {
  running: false,
  finished: false,
  stopped: false,
  total: 0,
  done: 0,
  phase: ''
};
let runToken = 0;
let currentMode = 'auto'; // 'auto' | 'role' | 'interactive'

// ---------- 模式选择 ----------
window.selectMode = function (mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mode === mode);
  });
  // 切换模式时清除已选扮演角色
  selectedUserRole = null;
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('role-selected'));
  // 呼叫审判长按钮在 第一人称控辩 / 动态实时接管 模式下显示
  const showInterrupt = (mode === 'role' || mode === 'interactive');
  if (interruptBtn) interruptBtn.style.display = showInterrupt ? '' : 'none';
};

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function phaseOfStep(stepName) {
  if (!stepName || stepName === '庭审干预') return '庭审干预';
  if (stepName.includes('开庭准备')) return '开庭准备';
  if (stepName.includes('起诉书') || stepName.includes('答辩')) return '法庭调查';
  if (stepName.includes('质证')) return '举证质证';
  if (stepName.includes('争议焦点')) return '归纳焦点';
  if (stepName.includes('辩论')) return '法庭辩论';
  if (stepName.includes('最后意见') || stepName.includes('最后陈述')) return '最后陈述';
  if (stepName.includes('评议') || stepName.includes('宣判')) return '评议宣判';
  return '庭审进行中';
}

function updateTurnLabel(overrideText) {
  if (overrideText) {
    turnLabel.textContent = overrideText;
    return;
  }
  if (trial.running) {
    turnLabel.textContent = `${trial.phase || '庭审进行中'} · 第 ${Math.min(trial.done, trial.total)}/${trial.total} 幕`;
  } else if (trial.stopped) {
    turnLabel.textContent = '已中止';
  } else if (trial.finished) {
    turnLabel.textContent = '已闭庭';
  } else {
    turnLabel.textContent = '未开庭';
  }
}

function updateProgress() {
  const pct = trial.finished ? 100 : trial.total ? Math.min(trial.done / trial.total * 100, 100) : 0;
  progressBar.style.width = `${pct}%`;
}

function focusRole(roleName, stepName, takeover) {
  const key = roleKeyByName[roleName];
  Object.entries(roleFigures).forEach(([k, el]) => {
    if (!el) return;
    el.classList.toggle('turn', k === key && !takeover);
    el.classList.toggle('active', k === key && !!takeover);
    el.classList.toggle('takeover', k === key && !!takeover);
  });
  // 聚光灯定位到当前角色中心，并开启"其余角色变暗"
  if (key && roleFigures[key]) {
    const r = roleFigures[key].getBoundingClientRect();
    const sr = scene.getBoundingClientRect();
    const cx = ((r.left + r.width / 2 - sr.left) / sr.width * 100).toFixed(1);
    const cy = ((r.top + r.height / 2 - sr.top) / sr.height * 100).toFixed(1);
    spotlight.style.setProperty('--sx', `${cx}%`);
    spotlight.style.setProperty('--sy', `${cy}%`);
  }
  scene.classList.add('dim-on');
  if (stepName && stepName !== '语音输入测试') {
    const phase = phaseOfStep(stepName);
    if (phase !== '庭审干预' && phase !== trial.phase) {
      trial.phase = phase;
      addSys(`—— ${phase} ——`);
    }
  }
  updateTurnLabel();
}

function resetScene() {
  scene.classList.remove('dim-on');
  Object.values(roleFigures).forEach((el) => {
    if (!el) return;
    el.classList.remove('turn', 'active', 'takeover', 'role-selected');
  });
  Object.values(roleBubbles).forEach((b) => {
    if (!b) return;
    clearTimeout(b._hideTimer);
    b.classList.remove('show', 'below');
  });
  Object.keys(voiceHold).forEach((k) => delete voiceHold[k]);
  liveDot.classList.remove('on');
  sceneStatus.style.cursor = '';
  hideSceneTakeover();
}

// ---------- 庭审笔录 ----------
const courtRecord = [];

// ---------- 法槌音效 ----------
let audioCtx = null;

function playGavel() {
  if (!gavelSound) return;
  try {
    gavelSound.currentTime = 0;
    const p = gavelSound.play();
    if (p && p.catch) p.catch(() => playGavelFallback());
  } catch (e) {
    playGavelFallback();
  }
}

// 音频文件缺失或浏览器拦截时，用 WebAudio 合成两声“敲击”
function playGavelFallback() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [0, 0.12].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(170, t0 + offset);
      gain.gain.setValueAtTime(0.9, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.15);
    });
  } catch (e) {
    // 忽略音频不可用
  }
}

// ---------- 语音播报 ----------
const speechQueue = [];
let speaking = false;
let activeAudio = null;
// roleKey -> 等待绑定到语音任务的气泡收起回调（开启播报时气泡保留到播完）
const pendingBubbleHold = {};
// roleKey -> true 表示该角色气泡需保留到其语音播完，期间不被其他角色发言打断收起
const voiceHold = {};

function enqueueSpeech(text, roleKey) {
  if (!text || !ttsToggle.checked) return;
  // 绑定同角色刚登记的“播完再收起气泡”回调
  const done = pendingBubbleHold[roleKey] || null;
  delete pendingBubbleHold[roleKey];
  speechQueue.push({ text, roleKey, done });
  if (!speaking) runSpeechQueue();
}

function stopSpeech() {
  // 触发被丢弃任务与未绑定任务的回调，避免气泡卡住不收起
  speechQueue.forEach((job) => { if (job.done) job.done(); });
  speechQueue.length = 0;
  Object.keys(pendingBubbleHold).forEach((key) => {
    pendingBubbleHold[key]();
    delete pendingBubbleHold[key];
  });
  if (activeAudio) {
    try {
      activeAudio.pause();
    } catch (e) {}
    activeAudio = null;
  }
}

async function runSpeechQueue() {
  speaking = true;
  while (speechQueue.length) {
    const job = speechQueue.shift();
    try {
      await speakTextStream(job.text, job.roleKey);
    } catch (e) {
      console.warn('语音播报失败：', e.message);
    }
    if (job.done) job.done(); // 该角色语音播完，收起对应气泡
  }
  speaking = false;
}

function timeoutFor(text) {
  return Math.max(8000, text.length * 260);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function speakTextStream(text, roleKey) {
  const resp = await fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, role: roleKey })
  });
  if (!resp.ok) throw new Error(`TTS 请求失败 ${resp.status}`);

  const mseReady = window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported('audio/mpeg');
  if (mseReady) await playWithMediaSource(resp.body, text);
  else await playWithBlob(resp.body, text);
}

function playWithMediaSource(body, text) {
  return new Promise((resolve) => {
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    const audio = new Audio(url);
    activeAudio = audio;

    const chunks = [];
    let sourceBuffer = null;
    let sourceDone = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        audio.pause();
      } catch (e) {}
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutFor(text));

    const pump = () => {
      if (!sourceBuffer || sourceBuffer.updating) return;
      if (chunks.length) {
        try {
          sourceBuffer.appendBuffer(chunks.shift());
        } catch (e) {
          finish();
        }
        return;
      }
      if (sourceDone && ms.readyState === 'open') {
        try {
          ms.endOfStream();
        } catch (e) {}
      }
    };

    ms.addEventListener('sourceopen', () => {
      try {
        sourceBuffer = ms.addSourceBuffer('audio/mpeg');
      } catch (e) {
        finish();
        return;
      }
      sourceBuffer.addEventListener('updateend', pump);
      pump();
      audio.play().catch(() => {});
    }, { once: true });

    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });

    parseCozeSSE(body, ({ data }) => {
      if (data && data.audio) {
        chunks.push(base64ToBytes(data.audio));
        pump();
        if (audio.paused) audio.play().catch(() => {});
      }
    })
      .then(() => {
        sourceDone = true;
        pump();
      })
      .catch(finish);
  });
}

async function playWithBlob(body, text) {
  const chunks = [];
  await parseCozeSSE(body, ({ data }) => {
    if (data && data.audio) chunks.push(base64ToBytes(data.audio));
  });
  if (!chunks.length) return;

  const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' }));
  const audio = new Audio(url);
  activeAudio = audio;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutFor(text));
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.play().catch(finish);
  });
}

// ---------- 接管（场景内面板 + 弹窗兜底） ----------
let pendingResolve = null;

function hideSceneTakeover() {
  if (!sceneTakeover) return;
  sceneTakeover.classList.remove('show');
  sceneTakeoverInput.value = '';
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('active', 'takeover'));
}

function showSceneTakeover(roleName, stepName) {
  sceneTakeoverTitle.textContent = `现在由 ${roleName} 发言 · ${stepName}`;
  sceneTakeoverInput.value = '';
  sceneTakeover.classList.add('show');
  setTimeout(() => sceneTakeoverInput.focus(), 60);
}

function hideTakeoverBar() {
  takeoverBar.style.display = 'none';
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('active', 'takeover'));
  hideSceneTakeover();
}

async function askTakeover(roleName, stepName) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    stopVoiceInput();
    focusRole(roleName, stepName, true);
    showSceneTakeover(roleName, stepName);
    sceneStatus.classList.add('live');
    sceneStatus.textContent = `等待你的发言 · ${roleName}（${stepName}）`;
    updateTurnLabel(`接管发言 · ${roleName}`);
  });
}

takeoverConfirm.onclick = () => {
  const text = takeoverInput.value.trim();
  if (!text) return alert('请输入接管内容');
  takeoverBar.style.display = 'none';
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('active', 'takeover'));
  if (pendingResolve) pendingResolve(text);
  pendingResolve = null;
};

takeoverSkip.onclick = () => {
  takeoverBar.style.display = 'none';
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('active', 'takeover'));
  if (pendingResolve) pendingResolve(null); // null 表示不接管
  pendingResolve = null;
};

// 场景内接管面板的确认/跳过
sceneTakeoverConfirm.onclick = () => {
  const text = sceneTakeoverInput.value.trim();
  if (!text) { sceneTakeoverInput.focus(); return; }
  hideSceneTakeover();
  if (pendingResolve) pendingResolve(text);
  pendingResolve = null;
};
sceneTakeoverSkip.onclick = () => {
  hideSceneTakeover();
  if (pendingResolve) pendingResolve(null);
  pendingResolve = null;
};
sceneTakeoverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sceneTakeoverConfirm.click();
  }
});

// ---------- 语音输入（Web Speech API 优先，失败自动切录音上传 ASR） ----------
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let voiceBaseText = '';
let mediaRecorder = null;
let recordChunks = [];
let recording = false;
let discardRecording = false;
// 当前激活的语音输入目标（弹窗 textarea 或场景内 textarea）
let activeVoiceInput = takeoverInput;
let activeMicBtn = takeoverMic;

function setActiveVoiceTarget(inputEl, micBtn) {
  activeVoiceInput = inputEl;
  activeMicBtn = micBtn;
}

function resetMicButton() {
  if (takeoverMic) { takeoverMic.textContent = '🎤 语音输入'; takeoverMic.classList.remove('recording'); }
  if (sceneTakeoverMic) { sceneTakeoverMic.textContent = '🎤 语音'; sceneTakeoverMic.classList.remove('recording'); }
}

if (SpeechRecognitionCtor) {
  recognition = new SpeechRecognitionCtor();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    recognizing = true;
    if (activeMicBtn) { activeMicBtn.textContent = '🎙️ 识别中…'; activeMicBtn.classList.add('recording'); }
  };
  recognition.onend = () => {
    recognizing = false;
    resetMicButton();
  };
  recognition.onerror = (e) => {
    console.warn('语音识别失败：', e.error);
    // 浏览器识别依赖厂商在线服务，国内常见 network 失败 → 自动改用录音上传
    if (['network', 'service-not-allowed', 'language-not-supported'].includes(e.error)) {
      recognizing = false;
      resetMicButton();
      startRecording();
    }
  };
  recognition.onresult = (e) => {
    let finalText = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    if (activeVoiceInput) activeVoiceInput.value = `${voiceBaseText}${finalText}${interim}`.trim();
  };
} else {
  if (takeoverMic) takeoverMic.title = '当前浏览器无内置识别，将使用录音上传识别';
  if (sceneTakeoverMic) sceneTakeoverMic.title = '当前浏览器无内置识别，将使用录音上传识别';
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// PCM 采样编码为 16bit 单声道 WAV
function encodeWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLen, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

// 录音转 16k 单声道 WAV（腾讯云 16k_zh 需要）
async function blobToWav16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  await ctx.close();
  const targetRate = 16000;
  const length = Math.ceil(decoded.duration * targetRate) || 1;
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), targetRate);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert('当前浏览器不支持录音识别，请改用文字输入');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recordChunks = [];
    discardRecording = false;
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recording = false;
      resetMicButton();
      if (discardRecording) return;

      if (activeMicBtn) { activeMicBtn.textContent = '⏳ 转写中…'; activeMicBtn.disabled = true; }
      try {
        const wav = await blobToWav16k(new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' }));
        const b64 = await blobToBase64(wav);
        const resp = await fetch('/api/asr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: b64, voiceFormat: 'wav' })
        });
        const json = await resp.json();
        if (!resp.ok || !json.text) throw new Error(json.error || '识别失败');
        if (activeVoiceInput) activeVoiceInput.value = `${voiceBaseText}${json.text}`.trim();
      } catch (e) {
        console.warn('录音识别失败：', e.message);
        alert(`录音识别失败：${e.message}`);
      } finally {
        if (activeMicBtn) activeMicBtn.disabled = false;
        resetMicButton();
      }
    };
    mediaRecorder.start();
    recording = true;
    if (activeMicBtn) { activeMicBtn.textContent = '🎙️ 录音中…（再点结束）'; activeMicBtn.classList.add('recording'); }
  } catch (e) {
    console.warn('麦克风不可用：', e.message);
    alert(`无法访问麦克风：${e.message}`);
  }
}

function startVoiceInput() {
  if (recording && mediaRecorder) {
    try { mediaRecorder.stop(); } catch (e) {}
    return;
  }
  if (recognizing && recognition) {
    try { recognition.stop(); } catch (e) {}
    return;
  }
  voiceBaseText = (activeVoiceInput && activeVoiceInput.value.trim()) ? `${activeVoiceInput.value.trim()} ` : '';
  if (recognition) {
    try { recognition.start(); return; } catch (e) {}
  }
  startRecording();
}

takeoverMic.onclick = () => {
  setActiveVoiceTarget(takeoverInput, takeoverMic);
  startVoiceInput();
};
sceneTakeoverMic.onclick = () => {
  setActiveVoiceTarget(sceneTakeoverInput, sceneTakeoverMic);
  startVoiceInput();
};

function stopVoiceInput() {
  if (recognition && recognizing) {
    try {
      recognition.stop();
    } catch (e) {}
  }
  if (recording && mediaRecorder && mediaRecorder.state !== 'inactive') {
    discardRecording = true;
    try {
      mediaRecorder.stop();
    } catch (e) {}
  }
}

// ---------- 场景气泡 ----------
function showSpeechTyping(roleKey, roleName, takeover) {
  const bubble = roleBubbles[roleKey];
  if (!bubble) return;
  Object.entries(roleBubbles).forEach(([k, b]) => {
    if (!b || k === roleKey) return;
    // 开启语音播报时，其他角色的气泡保留到各自语音播完，不被新发言打断收起
    if (voiceHold[k]) return;
    clearTimeout(b._hideTimer);
    b.classList.remove('show', 'below');
  });
  const info = ROLES[roleKey] || { name: roleName, color: '#8a5a2b' };
  bubble.querySelector('.who').textContent = `${roleName}${takeover ? ' · 你' : ''}`;
  bubble.querySelector('.who').style.color = info.color;
  bubble.querySelector('.say').innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span>';
  bubble.classList.remove('below', 'show');
  void bubble.offsetWidth;
  bubble.classList.add('show');
  bubble._shownAt = Date.now(); // 记录气泡展示起始时间，用于计算最短展示时长

  const sceneTop = scene.getBoundingClientRect().top;
  if (bubble.getBoundingClientRect().top < sceneTop + 8) bubble.classList.add('below');
  clearTimeout(bubble._hideTimer);
}

function updateSpeechText(roleKey, text) {
  const bubble = roleBubbles[roleKey];
  if (!bubble) return;
  bubble.querySelector('.say').textContent = text;
}

function scheduleHideSpeech(roleKey, text) {
  const bubble = roleBubbles[roleKey];
  if (!bubble) return;
  clearTimeout(bubble._hideTimer);
  // 基础展示时长：固定 30 秒，之后才会展示下一个角色的发言
  const baseMs = 30000;
  const stamp = Date.now();
  bubble._shownAt = stamp;
  const hide = () => {
    if (bubble._shownAt !== stamp) return; // 已被该角色的新发言取代
    bubble.classList.remove('show');
    delete voiceHold[roleKey];
  };
  if (ttsToggle.checked && text) {
    // 开启语音播报：气泡保留到该角色语音播完，且不少于基础展示时长（兜底超时防卡死）
    voiceHold[roleKey] = true;
    bubble._hideTimer = setTimeout(hide, Math.max(baseMs + 5000, timeoutFor(text) + 10000));
    pendingBubbleHold[roleKey] = () => {
      clearTimeout(bubble._hideTimer);
      bubble._hideTimer = setTimeout(hide, Math.max(1500, baseMs - (Date.now() - stamp)));
    };
  } else {
    bubble._hideTimer = setTimeout(hide, baseMs);
  }
}

// ---------- 发言节奏：每条发言展示 30 秒后再展示下一条 ----------
const SPEECH_HOLD_MS = 30000;
let msgChain = Promise.resolve();
let lastSpeechDoneAt = 0;

function onMessagePaced(action, data) {
  const token = runToken;
  msgChain = msgChain.catch(() => {}).then(async () => {
    if (token !== runToken) return; // 本轮已停止/重置，丢弃残留消息
    if (action === 'start' && lastSpeechDoneAt) {
      const wait = SPEECH_HOLD_MS - (Date.now() - lastSpeechDoneAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (token !== runToken) return;
    }
    renderMessage(action, data);
    if (action === 'done') lastSpeechDoneAt = Date.now();
  });
}

// 接管询问也按同样节奏：上一条发言展示满 30 秒后再弹出
async function askTakeoverPaced(role, step) {
  if (lastSpeechDoneAt) {
    const wait = SPEECH_HOLD_MS - (Date.now() - lastSpeechDoneAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return askTakeover(role, step);
}

// ---------- 渲染 ----------
let currentMsg = null;
let currentContent = null;
let currentMeta = null;

// 打字机效果：控制文字逐字输出速度
let typewriterTimer = null;
let pendingFullText = '';
let displayedChars = 0;
const TYPE_SPEED = 130; // 每字间隔毫秒数（越大越慢）

function stopTypewriter() {
  if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }
}

function flushTypewriter() {
  stopTypewriter();
  if (currentContent && pendingFullText) currentContent.textContent = pendingFullText;
  if (currentMeta) updateSpeechText(roleKeyByName[currentMeta.role] || 'clerk', pendingFullText);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function startTypewriter() {
  if (typewriterTimer) return;
  typewriterTimer = setInterval(() => {
    if (displayedChars < pendingFullText.length) {
      displayedChars++;
      const partial = pendingFullText.slice(0, displayedChars);
      if (currentContent) currentContent.textContent = partial;
      if (currentMeta) updateSpeechText(roleKeyByName[currentMeta.role] || 'clerk', partial);
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      stopTypewriter();
    }
  }, TYPE_SPEED);
}

function addSys(text) {
  const el = document.createElement('div');
  el.className = 'sys';
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderMessage(action, data) {
  if (action === 'start') {
    if (data.step !== '庭审干预') {
      trial.done += 1;
      updateProgress();
    }
    currentMeta = { role: data.role, step: data.step, takeover: !!data.takeover, content: '' };
    currentContent = null;

    // 重置打字机
    stopTypewriter();
    pendingFullText = '';
    displayedChars = 0;

    focusRole(data.role, data.step, data.takeover);
    liveDot.classList.add('on');
    sceneStatus.classList.add('live');
    sceneStatus.textContent = `${data.role} ${data.takeover ? '由你接管发言' : '正在发言'} · ${data.step}`;

    const roleKey = roleKeyByName[data.role] || 'clerk';
    const info = ROLES[roleKey] || { name: data.role, avatar: '法', color: '#8a5a2b', seat: '法庭' };

    currentMsg = document.createElement('div');
    currentMsg.className = `msg ${data.takeover ? 'user' : 'npc'} role-${roleKey}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = info.color;
    avatar.textContent = info.avatar;

    const body = document.createElement('div');
    body.className = 'body';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>${data.role}${data.takeover ? '（你）' : ''}</b><span>${data.takeover ? '接管发言' : info.seat}</span><span class="step-tag">${data.step}</span>`;

    currentContent = document.createElement('div');
    currentContent.className = 'bubble';
    currentContent.innerHTML = '<span class="loading-dots">正在思考</span>';

    body.appendChild(meta);
    body.appendChild(currentContent);
    currentMsg.appendChild(avatar);
    currentMsg.appendChild(body);
    chatLog.appendChild(currentMsg);
    chatLog.scrollTop = chatLog.scrollHeight;

    showSpeechTyping(roleKey, data.role, data.takeover);

    // 审判长开始宣判前落槌
    if (!data.takeover && data.role === '审判长' && data.step === '评议与宣判') playGavel();
    return;
  }

  if (action === 'update') {
    pendingFullText = data.content;
    if (currentMeta) currentMeta.content = data.content;
    startTypewriter();
    return;
  }

  if (action === 'done') {
    // 打字机追平剩余文字
    flushTypewriter();
    if (currentMeta) {
      if (currentMeta.content) {
        courtRecord.push({ ...currentMeta });
        recordCount.textContent = `${courtRecord.length} 条`;
        if (currentMeta.role === '书记员' && currentMeta.step === '开庭准备') playGavel();
        scheduleHideSpeech(roleKeyByName[currentMeta.role] || 'clerk', currentMeta.content);
      } else {
        const bubble = roleBubbles[roleKeyByName[currentMeta.role] || 'clerk'];
        if (bubble) bubble.classList.remove('show');
      }
    }
    currentMeta = null;
  }
}

// ---------- 呼叫审判长 ----------
interruptBtn.onclick = () => {
  if (interruptBtn.disabled) return;
  playGavel();
  interruptBtn.disabled = true;
  requestJudgeInterrupt('ai');
};

window.onInterruptState = (active) => {
  interruptBtn.disabled = !!active;
};

// ---------- 停止庭审 ----------
stopBtn.onclick = () => {
  trial.stopped = true;
  trial.running = false;
  stopCourt();
  stopSpeech();
  stopVoiceInput();
  hideTakeoverBar();
  if (pendingResolve) {
    pendingResolve(null);
    pendingResolve = null;
  }
  interruptBtn.disabled = true;
  stopBtn.disabled = true;
  liveDot.classList.remove('on');

  // 标记被打断的当前发言
  if (currentContent && currentMeta && !currentMeta.content) {
    currentContent.textContent = '（庭审已中止）';
    currentMeta = null;
  }

  sceneStatus.classList.remove('live');
  sceneStatus.textContent = '庭审已中止';
  updateTurnLabel('已中止');
  Object.values(roleFigures).forEach((el) => el && el.classList.remove('turn', 'active', 'takeover'));
  scene.classList.remove('dim-on');
  scene.classList.add('idle');
  hideSceneTakeover();
};

ttsToggle.onchange = () => {
  if (!ttsToggle.checked) stopSpeech();
};

// ---------- 导出笔录 ----------
exportBtn.onclick = () => {
  if (!courtRecord.length) return alert('暂无庭审内容，请先开始庭审');
  const lines = courtRecord.map((r) => {
    const roleText = r.takeover ? `${r.role}（用户接管）` : r.role;
    return `[${r.step}] ${roleText}：${r.content}`;
  });
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `庭审笔录-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ---------- 重置 ----------
function resetCourt(showToast) {
  runToken += 1;
  stopCourt();
  stopSpeech();
  stopVoiceInput();
  hideTakeoverBar();
  if (pendingResolve) {
    pendingResolve(null);
    pendingResolve = null;
  }

  trial.running = false;
  trial.finished = false;
  trial.stopped = false;
  trial.total = 0;
  trial.done = 0;
  trial.phase = '';

  chatLog.querySelectorAll('.msg, .sys').forEach((el) => el.remove());
  chatEmpty.style.display = '';
  courtRecord.length = 0;
  recordCount.textContent = '0 条';
  currentMsg = null;
  currentContent = null;
  currentMeta = null;

  resetScene();
  sceneStatus.classList.remove('live');
  sceneStatus.textContent = '等待开庭 · 写下案情后点击「开庭」';
  scene.classList.add('idle');
  updateTurnLabel();
  updateProgress();

  startBtn.disabled = false;
  startBtn.textContent = '开 庭';
  caseInput.disabled = false;
  stopBtn.disabled = true;
  interruptBtn.disabled = true;

  if (showToast) toast('庭审已重置，可重新开庭');
}

resetBtn.onclick = () => resetCourt(true);

// ---------- 开始庭审 ----------
startBtn.onclick = async () => {
  const caseText = caseInput.value.trim();
  if (!caseText) {
    toast('请先写下案情');
    caseInput.focus();
    return;
  }

  const token = ++runToken;

  const rawRounds = parseInt(debateRoundsInput.value, 10);
  const debateRounds = Number.isFinite(rawRounds) ? Math.min(3, Math.max(0, rawRounds)) : 1;
  debateRoundsInput.value = debateRounds;

  trial.running = true;
  trial.finished = false;
  trial.stopped = false;
  trial.total = 11 + 2 * debateRounds;
  trial.done = 0;
  trial.phase = '';

  startBtn.disabled = true;
  startBtn.textContent = '庭审进行中';
  caseInput.disabled = true;
  stopBtn.disabled = false;
  interruptBtn.disabled = false;
  sceneStatus.classList.add('live');
  sceneStatus.textContent = '庭审准备中…';
  scene.classList.remove('idle'); // 开庭后隐藏角色作用标注

  chatLog.querySelectorAll('.msg, .sys').forEach((el) => el.remove());
  chatEmpty.style.display = 'none';
  currentMsg = null;
  currentContent = null;
  currentMeta = null;
  courtRecord.length = 0;
  recordCount.textContent = '0 条';
  stopSpeech();
  resetScene();
  liveDot.classList.add('on');
  updateTurnLabel();
  updateProgress();

  try {
    // 获取当前模式与扮演角色（第一人称控辩模式需先点击画面角色选择）
    const activeMode = currentMode;
    let userRole = 'none';
    if (activeMode === 'role') {
      if (!selectedUserRole) {
        toast('请先点击画面中的角色选择你要扮演的角色');
        // 恢复按钮状态
        startBtn.disabled = false;
        startBtn.textContent = '开 庭';
        caseInput.disabled = false;
        stopBtn.disabled = true;
        trial.running = false;
        return;
      }
      userRole = selectedUserRole;
    }

    // 重置发言节奏状态：本轮从第一条发言开始重新计时
    lastSpeechDoneAt = 0;
    msgChain = Promise.resolve();

    await runCourt({
      caseText,
      mode: activeMode,
      userRole: userRole,
      debateRounds,
      onMessage: onMessagePaced,
      onAskTakeover: askTakeoverPaced,
      onSpeechDone: (roleKey, text) => enqueueSpeech(text, roleKey)
    });
    await msgChain; // 等待节奏队列排空，再进入收尾
  } catch (e) {
    console.error(e);
    addSys(`发生错误：${e.message}`);
  } finally {
    if (token !== runToken) return; // 本轮已被重置，忽略旧任务收尾
    trial.running = false;
    if (!trial.stopped) {
      trial.finished = true;
      sceneStatus.classList.remove('live');
      sceneStatus.textContent = '庭审结束';
      updateTurnLabel();
      updateProgress();
    }
    startBtn.disabled = false;
    startBtn.textContent = '再次开庭';
    caseInput.disabled = false;
    stopBtn.disabled = true;
    interruptBtn.disabled = true;
    liveDot.classList.remove('on');
    Object.values(roleFigures).forEach((el) => el && el.classList.remove('turn', 'active', 'takeover'));
    scene.classList.remove('dim-on');
    scene.classList.add('idle');
    hideSceneTakeover();
  }
};

// ---------- 场景演示（访问 ?demo=1 时循环聚焦，不调用任何接口） ----------
if (new URLSearchParams(location.search).has('demo')) {
  const demoScript = [
    ['书记员', '开庭准备'],
    ['原告', '宣读起诉书'],
    ['被告', '答辩意见'],
    ['审判长', '归纳争议焦点']
  ];
  let demoIndex = 0;
  setInterval(() => {
    const [role, step] = demoScript[demoIndex++ % demoScript.length];
    focusRole(role, step, false);
    sceneStatus.classList.add('live');
    sceneStatus.textContent = `${role} 正在发言 · ${step}`;
    const key = roleKeyByName[role];
    showSpeechTyping(key, role, false);
    updateSpeechText(key, `${role}正在${step}。`);
  }, 1800);
}

// 初始化模式（默认全维推演，隐藏动态接管按钮）
selectMode('auto');

// ---------- 初始化 ----------
updateTurnLabel();
updateProgress();
sceneStatus.textContent = '等待开庭 · 写下案情后点击「开庭」';
scene.classList.add('idle'); // 开庭前显示各角色作用标注

// 从小工具页面返回时直接定位到庭审场景
if (location.hash === '#scene') {
  setTimeout(() => scene.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
}
