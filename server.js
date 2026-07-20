// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_KEY = process.env.NIM_API_KEY;
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// CORS - QUAN TRỌNG: phải để trước tất cả routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use(express.json());

// Model mapping
const MODELS = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', models: Object.keys(MODELS) });
});

// Models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODELS).map(id => ({ id, object: 'model' }))
  });
});

// CHAT COMPLETIONS - Endpoint chính
app.post('/v1/chat/completions', async (req, res) => {
  console.log('📩 Received POST to /v1/chat/completions');
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { model, messages, temperature = 0.7, max_tokens = 4096, stream = false } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: 'messages is required and must be an array' }
      });
    }

    const nimModel = MODELS[model] || 'moonshotai/kimi-k2.6';
    
    const payload = {
      model: nimModel,
      messages: messages.map(m => ({
        role: m.role || 'user',
        content: String(m.content || '')
      })),
      temperature,
      max_tokens: Math.min(max_tokens, 16384),
      stream: Boolean(stream)
    };

    console.log(`🚀 Forward to: ${nimModel}`);

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    console.log('✅ NIM responded');

    // Trả về OpenAI format
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: response.data.choices.map(c => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content || ''
        },
        finish_reason: c.finish_reason
      })),
      usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'server_error'
      }
    });
  }
});

// Tất cả POST requests đều redirect đến /v1/chat/completions
app.post('*', (req, res) => {
  console.log(`🔄 Redirect POST ${req.path} → /v1/chat/completions`);
  // Forward request đến handler chính
  req.url = '/v1/chat/completions';
  app.handle(req, res);
});

// Root GET - trả về info
app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    endpoints: {
      'POST /v1/chat/completions': 'Main chat endpoint',
      'POST /': 'Redirect to chat endpoint'
    },
    models: Object.keys(MODELS)
  });
});

// 404
app.use((req, res) => {
  console.log(`❌ 404: ${req.method} ${req.path}`);
  res.status(404).json({
    error: {
      message: `Endpoint ${req.method} ${req.path} not found`,
      code: 404
    }
  });
});

// Start
app.listen(PORT, () => {
  console.log(`\n🚀 Proxy running on port ${PORT}`);
  console.log(`📡 POST to: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`🤖 Models: ${Object.keys(MODELS).join(', ')}`);
  console.log(`🔑 API Key: ${NIM_API_KEY ? '✅ Set' : '❌ MISSING!'}\n`);
});
