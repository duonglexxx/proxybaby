// server.js - OpenAI to NVIDIA NIM API Proxy (STRICT + REASONING-STRIPPED)
'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const NIM_API_BASE = (process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const NIM_API_KEY = process.env.NIM_API_KEY;
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS) || 180_000;

// 📌 Whitelist: client model name → NIM model id
const ALLOWED_MODELS = Object.freeze({
  'deepseek-v4-flash-0731': 'deepseek-ai/deepseek-v4-flash-0731',
  'glm-5.3': 'z-ai/glm-5.3',
  'kimi-k3': 'moonshotai/kimi-k3',
  'nemotron-3.5-lightning-30b-a3b': 'nvidia/nemotron-3.5-lightning-30b-a3b',
  'meta/llama-3.1-8b-instruct': 'meta/llama-3.1-8b-instruct',
});

const MODEL_LIST = Object.freeze({
  object: 'list',
  data: Object.keys(ALLOWED_MODELS).map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'nvidia-nim-proxy',
  })),
});

// Field names chứa reasoning — xoá sạch trước khi trả client
const REASONING_KEYS = new Set([
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'reasoning_text',
  'thought',
  'thoughts',
  'thinking',
  'analysis',
  'reflection',
  'chain_of_thought',
  'cot',
  'scratchpad',
  'internal',
  'hidden',
]);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code ?? status;
  }
}

const sendError = (res, status, message, type = 'invalid_request_error', code) => {
  if (res.headersSent) return res.end();
  return res.status(status).json({ error: { message, type, code: code ?? status } });
};

async function readStreamAsText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeErrorPayload(raw) {
  if (!raw) return { message: 'Unknown upstream error', type: 'proxy_error' };
  if (typeof raw === 'string') {
    try { return normalizeErrorPayload(JSON.parse(raw)); }
    catch { return { message: raw, type: 'proxy_error' }; }
  }
  if (raw.error) return raw.error;
  return raw;
}

// ─────────────────────────────────────────────────────────────
// 🧠 STRIP THINKING (dành cho content có lẫn tag)
// ─────────────────────────────────────────────────────────────
const THINK_PATTERNS = [
  /<\|?\s*(?:think|thinking|reasoning|thought|reflection)\s*\|?>[\s\S]*?<\|?\s*\/\s*(?:think|thinking|reasoning|thought|reflection)\s*\|?>/gi,
  /\[\s*(?:think|thinking|reasoning|thought)\s*\][\s\S]*?\[\s*\/\s*(?:think|thinking|reasoning|thought)\s*\]/gi,
  /```\s*(?:think|thinking|reasoning|thought)[\s\S]*?```/gi,
  /^\s*(?:thinking\s+process|reasoning|chain\s+of\s+thought)\s*[:：][\s\S]*?(?:\n\s*\n|$)/gim,
];

function stripThinking(text) {
  if (typeof text !== 'string' || !text) return text || '';
  let out = text;
  for (const re of THINK_PATTERNS) out = out.replace(re, '');
  // Tag mở chưa đóng (upstream bị cắt) → xoá từ tag tới hết
  out = out.replace(/<\|?\s*(?:think|thinking|reasoning|thought)\s*\|?>[\s\S]*$/gi, '');
  out = out.replace(/\[\s*(?:think|thinking|reasoning|thought)\s*\][\s\S]*$/gi, '');
  return out.trim();
}

// ─────────────────────────────────────────────────────────────
// 🧹 SCRUB REASONING (xoá mọi field reasoning ở mọi cấp)
// ─────────────────────────────────────────────────────────────
function scrubReasoning(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) scrubReasoning(item, depth + 1);
    return obj;
  }
  for (const key of Object.keys(obj)) {
    if (REASONING_KEYS.has(key)) {
      delete obj[key];
    } else {
      const v = obj[key];
      if (v && typeof v === 'object') scrubReasoning(v, depth + 1);
    }
  }
  return obj;
}

// Làm sạch 1 chunk SSE (đã parse JSON)
function scrubChunk(parsed) {
  scrubReasoning(parsed);

  const choice = parsed?.choices?.[0];
  if (!choice) return parsed;

  // Delta (streaming)
  const delta = choice.delta;
  if (delta && typeof delta.content === 'string') {
    delta.content = stripThinking(delta.content);
  }
  // Message (full message đôi khi vẫn xuất hiện)
  const msg = choice.message;
  if (msg && typeof msg.content === 'string') {
    msg.content = stripThinking(msg.content);
  }
  // Text (legacy)
  if (typeof choice.text === 'string') {
    choice.text = stripThinking(choice.text);
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
  res.setHeader('x-request-id', req.id);
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${req.id}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─────────────────────────────────────────────────────────────
// AXIOS CLIENT
// ─────────────────────────────────────────────────────────────
const nimClient = axios.create({
  baseURL: NIM_API_BASE,
  timeout: TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

nimClient.interceptors.request.use((cfg) => {
  if (NIM_API_KEY) cfg.headers.Authorization = `Bearer ${NIM_API_KEY}`;
  return cfg;
});

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy Strict',
    uptime: process.uptime(),
    models: Object.keys(ALLOWED_MODELS).length,
  });
});

app.get('/v1/models', (_req, res) => res.json(MODEL_LIST));

app.get('/v1/models/:id', (req, res) => {
  const id = req.params.id;
  if (!ALLOWED_MODELS[id]) {
    return sendError(res, 404, `Model '${id}' not found.`, 'invalid_request_error', 404);
  }
  res.json({ id, object: 'model', created: 0, owned_by: 'nvidia-nim-proxy' });
});

app.post('/v1/chat/completions', async (req, res, next) => {
  try {
    const { model, messages, stream = false, ...rest } = req.body || {};

    if (!model) throw new HttpError(400, 'Model is required');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpError(400, 'messages must be a non-empty array');
    }
    if (!NIM_API_KEY) {
      throw new HttpError(500, 'NIM_API_KEY not configured on server', 'server_error', 500);
    }

    const nimModel = ALLOWED_MODELS[model];
    if (!nimModel) {
      throw new HttpError(400, `Model '${model}' is not supported or not allowed on this proxy.`);
    }

    const isStream = stream === true;
    console.log(`[${req.id}] ✅ ${model} → ${nimModel} (stream=${isStream})`);

    const payload = { model: nimModel, messages, stream: isStream, ...rest };

    // ─────────────────────────────────────────────────────
    // STREAMING
    // ─────────────────────────────────────────────────────
    if (isStream) {
      const upstream = await nimClient.post('/chat/completions', payload, {
        responseType: 'stream',
      });

      const ct = upstream.headers['content-type'] || '';
      if (!ct.includes('text/event-stream')) {
        const text = await readStreamAsText(upstream.data);
        const err = normalizeErrorPayload(text);
        return sendError(
          res,
          upstream.status || 502,
          err.message || 'Upstream error',
          err.type || 'proxy_error',
          upstream.status || 502,
        );
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const upstreamStream = upstream.data;
      let sseBuffer = '';

      upstreamStream.on('data', (chunk) => {
        sseBuffer += chunk.toString('utf8');
        let idx;
        while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
          const rawEvent = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + 2);

          if (!rawEvent.trim()) continue;

          // Giữ nguyên comment line (": ...") và event: line
          const lines = rawEvent.split('\n');
          const dataLines = [];
          const otherLines = [];
          for (const line of lines) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            else otherLines.push(line);
          }

          if (dataLines.length === 0) {
            // Chỉ có comment/event → gửi nguyên
            res.write(rawEvent + '\n\n');
            continue;
          }

          const dataStr = dataLines.join('\n');

          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const parsed = JSON.parse(dataStr);
            scrubChunk(parsed);
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          } catch {
            // Chunk lỗi parse → bỏ, không đẩy xuống client
          }
        }
      });

      upstreamStream.on('end', () => {
        if (sseBuffer.trim()) {
          // Xử lý nốt buffer còn lại (nếu upstream không kết bằng \n\n)
          try {
            const lines = sseBuffer.split('\n');
            const dataStr = lines
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (dataStr && dataStr !== '[DONE]') {
              const parsed = JSON.parse(dataStr);
              scrubChunk(parsed);
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } else if (dataStr === '[DONE]') {
              res.write('data: [DONE]\n\n');
            }
          } catch { /* ignore */ }
        }
        res.end();
      });

      req.on('close', () => {
        if (!upstreamStream.destroyed) upstreamStream.destroy();
      });

      upstreamStream.on('error', (err) => {
        console.error(`[${req.id}] ❌ Stream error:`, err.message);
        if (!res.headersSent) sendError(res, 502, 'Stream processing error', 'proxy_error', 502);
        else res.end();
      });

      return;
    }

    // ─────────────────────────────────────────────────────
    // NON-STREAM
    // ─────────────────────────────────────────────────────
    const upstream = await nimClient.post('/chat/completions', payload, {
      responseType: 'json',
    });

    const d = scrubReasoning(upstream.data);

    const openaiResponse = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: (d.choices || []).map((c, i) => {
        const msg = c.message || {};
        const outMsg = {
          role: msg.role || 'assistant',
          content: stripThinking(msg.content ?? ''),
        };
        if (msg.tool_calls) outMsg.tool_calls = msg.tool_calls;

        return {
          index: c.index ?? i,
          message: outMsg,
          finish_reason: c.finish_reason || 'stop',
        };
      }),
      usage: d.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    res.json(openaiResponse);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// 404 + ERROR HANDLER
// ─────────────────────────────────────────────────────────────
app.all('*', (req, res) => {
  sendError(res, 404, `Endpoint ${req.path} not found.`, 'invalid_request_error', 404);
});

// eslint-disable-next-line no-unused-vars
app.use(async (err, req, res, _next) => {
  const id = req.id || 'n/a';
  console.error(`[${id}] ❌ Error:`, err.message);

  if (err.isAxiosError || err.response) {
    const status = err.response?.status || 502;
    let payload = err.response?.data;

    if (payload && typeof payload.on === 'function') {
      try { payload = JSON.parse(await readStreamAsText(payload)); }
      catch { payload = null; }
    }

    const normalized = normalizeErrorPayload(payload) || {};
    return sendError(
      res,
      status,
      normalized.message || err.message,
      normalized.type || 'proxy_error',
      status,
    );
  }

  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ECONNABORTED') {
    return sendError(res, 504, 'Upstream timeout', 'timeout_error', 504);
  }

  if (err instanceof HttpError) {
    return sendError(res, err.status, err.message, err.type, err.code);
  }

  return sendError(res, 500, err.message || 'Internal server error', 'proxy_error', 500);
});

// ─────────────────────────────────────────────────────────────
// VERCEL
// ─────────────────────────────────────────────────────────────
module.exports = app;