// 通用 SSE 解析器
// 兼容两种后端写法：
//   1. data: {"content": "..."}                （智谱大模型对话流）
//   2. event: xxx / data: {"audio": "..."}     （TTS 音频流）
// 收到 OpenAI 风格的结束标记 data: [DONE] 时，会回调 { done: true } 并停止读取。
export async function parseSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  function handlePart(part) {
    if (!part || !part.trim()) return;
    let eventType = 'message';
    const dataLines = [];

    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }

    const dataStr = dataLines.join('\n').trim();
    if (!dataStr) return;

    if (dataStr === '[DONE]') {
      finished = true;
      onEvent({ event: 'done', data: null, done: true });
      return;
    }

    try {
      onEvent({ event: eventType, data: JSON.parse(dataStr) });
    } catch (e) {
      // 跳过无法解析的分片，不能因为一个坏包中断整条流
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop();

      for (const part of parts) {
        handlePart(part);
        if (finished) break;
      }
    }

    // 流自然结束：冲刷解码器残留字节，并处理最后一个没有以空行结尾的事件
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim()) handlePart(buffer);
    }
  } finally {
    // 收到 [DONE] 后主动断开连接，避免浏览器继续挂起等待
    if (finished) {
      try {
        await reader.cancel();
      } catch (e) {}
    }
  }
}
