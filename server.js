// server.js - OpenAI to NVIDIA NIM Proxy (Fixed 499 & Redirect Issues)
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
app.use(express.json());

// ✅ FIX 1: GET / trả về JSON trực tiếp, KHÔNG redirect (tránh loop/timeout với Janitor)
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'NVIDIA NIM Proxy', 
    models: Object.keys(MODEL_MAPPING),
    note: 'Use POST / or POST /v1/chat/completions for chat' 
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('/v1/models', (req, res) => {
  const data = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data });
});

// Hàm xử lý chat chung (dùng cho cả /, /v1, /v1/chat/completions)
const handleChat = async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';
    
    console.log(`📤 [${req.method} ${req.path}] ${model} → ${nimModel}`);
    
    // ✅ FIX 2: Giảm timeout xuống 30s để tránh giữ connection quá lâu gây 499
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: nimModel, 
      messages, 
      temperature: temperature ?? 0.7, 
      max_tokens: max_tokens ?? 4096, 
      stream: !!stream
    }, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json', 
      timeout: 30000 
    });

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 
        'Cache-Control': 'no-cache', 
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // ✅ FIX 3: Tắt buffering của Nginx/Railway
      });
      
      let buffer = '';
      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            res.write(line + '\n\n'); // ✅ FIX 4: Double newline chuẩn SSE
          }
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
    console.error(' Error:', err.response?.status, err.message);
    // Nếu lỗi từ NVIDIA, trả về đúng status code để client biết
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

// ✅ FIX 5: Gọi trực tiếp hàm handleChat, KHÔNG dùng next('route')
app.post('/', handleChat);
app.post('/v1', handleChat);
app.post('/v1/chat/completions', handleChat);

// Catch-all 404
app.all('*', (req, res) => res.status(404).json({ 
  error: { message: `Not found: ${req.path}`, type: 'invalid_request_error', code: 404 } 
}));

app.listen(PORT, () => console.log(`🚀 Proxy running on port ${PORT}`));