export async function parseCozeSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

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
    try {
      onEvent({ event: eventType, data: JSON.parse(dataStr) });
    } catch (e) {}
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop();

    for (const part of parts) handlePart(part);
  }

  // 流结束：冲刷解码器残留字节，并处理最后一个没有以空行结尾的事件
  buffer += decoder.decode();
  if (buffer.trim()) handlePart(buffer);
  buffer = '';
}

