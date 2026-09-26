// server.js - OpenAI to NVIDIA NIM API Proxy with Dynamic Fallback (Optimized for Vercel)
'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ─────────────────────────────────────────────────────────────
// CONFIG & MODEL FALLBACK CHAIN
// ─────────────────────────────────────────────────────────────
const NIM_API_BASE = (process.env.NIM_API_BASE || 'https://nvidia.com').replace(/\/+\$/, '');
const NIM_API_KEY = process.env.NIM_API_KEY;
const TIMEOUT_MS = Number(process.env.NIM_TIMEOUT_MS) || 180_000;

// Danh sách Mapping Model và Chuỗi Fallback tương ứng khi lỗi
const MODEL_CONFIG = Object.freeze({
  'muse-glimmer-30b': { nimId: 'meta/muse-glimmer-30b', fallbacks: ['gemma-4-31b-it', 'meta/llama-3.1-8b-instruct'] },
  'glm-5.3': { nimId: 'z-ai/glm-5.3', fallbacks: ['glm-5.3-flash', 'meta/llama-3.1-8b-instruct'] },
  'kimi-k3': { nimId: 'moonshotai/kimi-k3', fallbacks: ['glm-5.3', 'meta/llama-3.1-8b-instruct'] },
  'gemma-4-31b-it': { nimId: 'google/gemma-4-31b-it', fallbacks: ['meta/llama-3.1-8b-instruct'] },
  'glm-5.3-flash': { nimId: 'z-ai/glm-5.3-flash', fallbacks: ['deepseek-v4.1-flash', 'meta/llama-3.1-8b-instruct'] },
  'deepseek-v4.1-flash': { nimId: 'deepseek-ai/deepseek-v4.1-flash', fallbacks: ['glm-5.3-flash', 'meta/llama-3.1-8b-instruct'] },
  'meta/llama-3.1-8b-instruct': { nimId: 'meta/llama-3.1-8b-instruct', fallbacks: [] }, // Tuyến phòng thủ cuối
});

const MODEL_LIST = Object.freeze({
  object: 'list',
  data: Object.keys(MODEL_CONFIG).map((id) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'nvidia-nim-proxy',
  })),
});

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
  return raw.error || raw;
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 8);
  res.setHeader('x-request-id', req.id);
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${req.id}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

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
    service: 'OpenAI to NVIDIA NIM Proxy with Fallback',
    uptime: process.uptime(),
    models: Object.keys(MODEL_CONFIG).length,
  });
});

app.get('/v1/models', (_req, res) => res.json(MODEL_LIST));

app.get('/v1/models/:id', (req, res) => {
  const id = req.params.id;
  if (!MODEL_CONFIG[id]) {
    return sendError(res, 404, `Model '${id}' not found.`, 'invalid_request_error', 404);
  }
  res.json({ id, object: 'model', created: 0, owned_by: 'nvidia-nim-proxy' });
});

app.post('/v1/chat/completions', async (req, res, next) => {
  try {
    const { model: requestedModel, messages, stream = false, ...rest } = req.body || {};

    if (!requestedModel) throw new HttpError(400, 'Model is required');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpError(400, 'messages must be a non-empty array');
    }
    if (!NIM_API_KEY) {
      throw new HttpError(500, 'NIM_API_KEY not configured on server', 'server_error', 500);
    }

    if (!MODEL_CONFIG[requestedModel]) {
      throw new HttpError(400, `Model '${requestedModel}' is not supported.`);
    }

    const isStream = stream === true;
    
    // Tạo danh sách các model sẽ thử nghiệm tuần tự (Model gốc -> Các model fallback)
    const modelExecutionQueue = [requestedModel, ...MODEL_CONFIG[requestedModel].fallbacks];
    
    let lastError = null;
    let attemptSuccess = false;

    for (const currentModel of modelExecutionQueue) {
      const nimModelId = MODEL_CONFIG[currentModel].nimId;
      console.log(`[${req.id}] 🔄 Attempting model: ${currentModel} (NIM ID: ${nimModelId}) | Stream=${isStream}`);

      try {
        const payload = { model: nimModelId, messages, stream: isStream, ...rest };

        // ── CHẾ ĐỘ STREAMING ─────────────────────────────────
        if (isStream) {
          const upstream = await nimClient.post('/chat/completions', payload, { responseType: 'stream' });
          const ct = upstream.headers['content-type'] || '';

          if (!ct.includes('text/event-stream')) {
            const text = await readStreamAsText(upstream.data);
            throw new Error(`Upstream returned non-SSE data: ${text}`);
          }

          // Cấu hình headers phản hồi Stream
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();

          const upstreamStream = upstream.data;

          req.on('close', () => {
            if (!upstreamStream.destroyed) upstreamStream.destroy();
          });

          // Pipe luồng dữ liệu trực tiếp về client
          await new Promise((resolve, reject) => {
            upstreamStream.on('error', (err) => reject(err));
            upstreamStream.on('end', () => resolve());
            upstreamStream.pipe(res);
          });

          attemptSuccess = true;
          return; // Kết thúc request thành công
        }

        // ── CHẾ ĐỘ NON-STREAM ────────────────────────────────
        const upstream = await nimClient.post('/chat/completions', payload, { responseType: 'json' });
        const d = upstream.data;

        const openaiResponse = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel, // Giữ nguyên tên model client yêu cầu ban đầu để tránh crash client app
          choices: (d.choices || []).map((c, i) => ({
            index: c.index ?? i,
            message: {
              role: c.message?.role || 'assistant',
              content: c.message?.content ?? '',
              ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
            },
            finish_reason: c.finish_reason || 'stop',
          })),
          usage: d.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        res.json(openaiResponse);
        attemptSuccess = true;
        return; // Kết thúc request thành công

      } catch (err) {
        lastError = err;
        console.warn(`[${req.id}] ⚠️ Model '${currentModel}' failed. Error: ${err.message}. Trying next fallback...`);
        
        // Nếu response đã gửi một phần dữ liệu (Headers sent trong stream), không thể fallback tiếp sang model khác
        if (res.headersSent) {
          console.error(`[${req.id}] ❌ Response headers already sent. Cannot recover fallback.`);
          break;
        }
      }
    }

    // Nếu chạy hết toàn bộ hàng đợi model mà vẫn thất bại
    if (!attemptSuccess) {
      throw lastError || new Error('All models in fallback chain failed.');
    }

  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// CENTRALIZED ERROR HANDLER
// ─────────────────────────────────────────────────────────────
app.all('*', (req, res) => {
  sendError(res, 404, `Endpoint ${req.path} not found.`, 'invalid_request_error', 404);
});

app.use(async (err, req, res, _next) => {
  const id = req.id || 'n/a';
  console.error(`[${id}] ❌ Final Proxy Error:`, err.message);

  if (err.isAxiosError || err.response) {
    const status = err.response?.status || 502;
    let payload = err.response?.data;

    if (payload && typeof payload.on === 'function') {
      try { payload = JSON.parse(await readStreamAsText(payload)); }
      catch { payload = null; }
    }

    const normalized = normalizeErrorPayload(payload) || {};
    return sendError(res, status, normalized.message || err.message, normalized.type || 'proxy_error', status);
  }

  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ECONNABORTED') {
    return sendError(res, 504, 'All tried upstreams timed out', 'timeout_error', 504);
  }

  if (err instanceof HttpError) {
    return sendError(res, err.status, err.message, err.type, err.code);
  }

  return sendError(res, 500, err.message || 'Internal server error', 'proxy_error', 500);
});

module.exports = app;
