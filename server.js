// server.js - Fixed NVIDIA NIM Proxy for Janitor AI & Railway
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Model mapping
const MODEL_MAPPING = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ✅ FIX 1: GET / trả JSON ngay (tránh 404 khi JA ping health)
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'NVIDIA NIM Proxy', 
    models: Object.keys(MODEL_MAPPING) 
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('/v1/models', (req, res) => {
  const data = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data });
});

// Hàm xử lý chat chung (dùng cho /, /v1, /v1/chat/completions)
const handleChat = async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream, top_p, seed, extra_body } = req.body;
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';
    
    console.log(`📤 [${req.method} ${req.path}] ${model} → ${nimModel}`);
    
    // Build payload chuẩn NVIDIA NIM (hỗ trợ extra_body như Python SDK)
    const payload = {
      model: nimModel,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096,
      top_p: top_p ?? 1,
      seed: seed ?? null,
      stream: !!stream,
      ...(extra_body && { extra_body })
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, payload, {
      headers: { 
        Authorization: `Bearer ${NIM_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 60000
    });

    if (stream) {
      // ✅ FIX 2: Headers chuẩn SSE + Tắt Buffering Railway
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Transfer-Encoding': 'chunked'
      });

      let buffer = '';
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            // ✅ FIX 3: Double newline chuẩn SSE
            res.write(line + '\n\n');
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(c => ({
          index: c.index,
          message: {
            role: c.message.role,
            content: c.message?.content || '',
            reasoning_content: c.message?.reasoning_content // Hỗ trợ reasoning
          },
          finish_reason: c.finish_reason
        })),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (err) {
    console.error('❌ Error:', err.response?.status, err.message);
    const status = err.response?.status || 500;
    res.status(status).json({
      error: { 
        message: err.response?.data?.error?.message || err.message, 
        type: 'proxy_error', 
        code: status 
      }
    });
  }
};

// ✅ FIX 4: Gọi trực tiếp hàm, KHÔNG dùng next('route')
app.post('/', handleChat);
app.post('/v1', handleChat);
app.post('/v1/chat/completions', handleChat);

app.all('*', (req, res) => res.status(404).json({
  error: { message: `Not found: ${req.path}`, type: 'invalid_request_error', code: 404 }
}));

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
});