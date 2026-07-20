// server.js - OpenAI to NVIDIA NIM API Proxy
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

// Middleware - CORS đầy đủ
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', models: Object.keys(MODEL_MAPPING) });
});

// Models list
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model' }))
  });
});

// MAIN CHAT COMPLETIONS - Fix cho Janitor AI
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature = 0.7, max_tokens = 4096, stream = false } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Invalid messages' } });
    }

    const nimModel = MODEL_MAPPING[model] || 'moonshotai/kimi-k2.6';
    
    const nimPayload = {
      model: nimModel,
      messages: messages.map(m => ({ role: m.role || 'user', content: m.content || '' })),
      temperature,
      max_tokens: Math.min(max_tokens, 16384),
      stream
    };

    console.log(`🚀 ${model} → ${nimModel}`);

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimPayload,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json',
        timeout: 120000
      }
    );

    if (stream) {
      // Streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      response.data.pipe(res);
      
    } else {
      // Non-streaming
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(c => ({
          index: c.index,
          message: { role: c.message.role, content: c.message.content || '' },
          finish_reason: c.finish_reason
        })),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'server_error'
      }
    });
  }
});

// Redirect các alias
app.post('/', (req, res) => {
  req.url = '/v1/chat/completions';
  app.handle(req, res);
});

app.post('/v1', (req, res) => {
  req.url = '/v1/chat/completions';
  app.handle(req, res);
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', code: 404 } });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on ${PORT}`);
  console.log(`🤖 Models: ${Object.keys(MODEL_MAPPING).join(', ')}`);
});
