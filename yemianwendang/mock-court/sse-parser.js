export async function parseCozeSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop();

    for (const part of parts) {
      if (!part.trim()) continue;
      let eventType = 'message';
      let dataStr = '';

      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }

      if (dataStr) {
        try { onEvent({ event: eventType, data: JSON.parse(dataStr) }); } catch (e) {}
      }
    }
  }
}
