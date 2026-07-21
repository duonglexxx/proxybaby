// server.js - Fixed for Janitor AI POST / & Streaming
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

// CORS chi tiết cho JA Mobile
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));

// Health check & Root GET
app.get('/', (req, res) => res.json({ status: 'ok', service: 'NVIDIA NIM Proxy' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));
app.get('/v1/models', (req, res) => {
  const data = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data });
});

// ✅ FIX: Hàm xử lý chat chung, gọi TRỰC TIẾP tại route POST /
const handleChat = async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream, extra_body } = req.body;
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';
    
    console.log(`📤 [${req.method} ${req.path}] ${model} → ${nimModel}`);
    
    const payload = {
      model: nimModel, messages, temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 4096, stream: !!stream,
      ...(extra_body && { extra_body })
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, payload, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json', timeout: 60000
    });

    if (stream) {
      // ✅ FIX QUAN TRỌNG: Tắt Buffering + Double Newline SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
        'Transfer-Encoding': 'chunked', 'Access-Control-Allow-Origin': '*'
      });

      let buffer = '';
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) res.write(line + '\n\n'); // ✅ \n\n chuẩn SSE
        }
      });
      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
    } else {
      res.json({
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model,
        choices: response.data.choices.map(c => ({
          index: c.index, message: { role: c.message.role, content: c.message?.content || '' },
          finish_reason: c.finish_reason
        })),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (err) {
    console.error('❌ Error:', err.response?.status, err.message);
    res.status(err.response?.status || 500).json({
      error: { message: err.response?.data?.error?.message || err.message, type: 'proxy_error', code: err.response?.status || 500 }
    });
  }
};

// ✅ FIX: Gọi trực tiếp handleChat, KHÔNG dùng next('route')
app.post('/', handleChat);
app.post('/v1', handleChat);
app.post('/v1/chat/completions', handleChat);

app.all('*', (req, res) => res.status(404).json({
  error: { message: `Not found: ${req.path}`, type: 'invalid_request_error', code: 404 }
}));

app.listen(PORT, () => console.log(`🚀 Proxy running on port ${PORT}`));