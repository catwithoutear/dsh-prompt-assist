import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  CHAT_REPLY, PREDICT_TEXT, CONTINUATION_TEXT, OPTIMIZE_OUTPUT,
} from './prompts.mjs';

const PORT = Number(process.env.MOCK_PORT || 18090);
const ARTIFACTS = process.env.ARTIFACTS_DIR || '/artifacts';
const LOG = `${ARTIFACTS}/llm-requests.jsonl`;
mkdirSync(ARTIFACTS, { recursive: true });

const REPLY = {
  chat: CHAT_REPLY,
  predict: PREDICT_TEXT,
  continuation: CONTINUATION_TEXT,
  optimize: OPTIMIZE_OUTPUT,
};

const stats = { requests: 0, byKind: {}, startedAt: new Date().toISOString() };

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  }
  return '';
}

function classify(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.filter(message => message.role === 'system')
    .map(message => contentText(message.content)).join('\n');
  if (system.includes('You write the next USER message')) return 'predict';
  if (system.includes("You continue the human's unsent message")) return 'continuation';
  if (system.includes('One-shot application contract')) return 'optimize';
  return 'chat';
}

function writeSse(res, text, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
  res.write(chunk({ role: 'assistant' }));
  const size = Math.max(1, Math.ceil(text.length / 3));
  for (let index = 0; index < text.length; index += size) {
    res.write(chunk({ content: text.slice(index, index + size) }));
  }
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/__stats') return writeJson(res, stats);
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return writeJson(res, {
      object: 'list',
      data: [{ id: 'mock-1', object: 'model', owned_by: 'verification' }],
    });
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    res.writeHead(404).end('not found');
    return;
  }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* classify an empty body as chat */ }
    const kind = classify(body);
    const text = REPLY[kind] ?? REPLY.chat;
    stats.requests += 1;
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    appendFileSync(LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      model: body.model ?? null,
      stream: body.stream ?? null,
      messageCount: (body.messages ?? []).length,
      system: (body.messages ?? []).filter(message => message.role === 'system')
        .map(message => contentText(message.content).slice(0, 80)),
    })}\n`);
    if (body.stream) writeSse(res, text, body.model ?? 'mock-1');
    else writeJson(res, {
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'mock-1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on 127.0.0.1:${PORT}`);
});
