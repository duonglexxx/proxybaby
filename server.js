// server.js - OpenAI to NVIDIA NIM Proxy (Optimized)
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

// ✅ FIX: Health check & Root redirect
app.get('/', (req, res) => res.redirect('/health'));
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  service: 'NVIDIA NIM Proxy', 
  models: Object.keys(MODEL_MAPPING) 
}));

app.get('/v1/models', (req, res) => {
  const data = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data });
});

// Auto-redirect legacy endpoints
const redirectLegacy = (req, res, next) => { req.url = '/v1/chat/completions'; next('route'); };
app.post('/', redirectLegacy);
app.post('/v1', redirectLegacy);

// Main Chat Endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    const nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';
    
    console.log(`📤 ${model} → ${nimModel}`);
    
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model: nimModel, messages, temperature: temperature ?? 0.7, 
      max_tokens: max_tokens ?? 4096, stream: !!stream
    }, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: stream ? 'stream' : 'json', timeout: 60000
    });

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'
      });
      
      let buffer = '';
      response.data.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) res.write(line + '\n\n'); // ✅ FIX: Double newline for SSE
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
      error: { message: err.message, type: 'proxy_error', code: err.response?.status || 500 }
    });
  }
});

// Catch-all 404
app.all('*', (req, res) => res.status(404).json({ 
  error: { message: `Not found: ${req.path}`, type: 'invalid_request_error', code: 404 } 
}));

app.listen(PORT, () => console.log(`🚀 Proxy running on port ${PORT}`));