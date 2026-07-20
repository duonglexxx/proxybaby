// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_KEY = process.env.NIM_API_KEY;
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// CORS - XỬ LÝ TẤT CẢ OPTIONS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Xử lý OPTIONS cho TẤT CẢ các route
app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.status(204).send();
});

app.use(express.json());

const MODELS = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

// CHAT COMPLETIONS - XỬ LÝ TẤT CẢ POST
app.post('/v1/chat/completions', async (req, res) => {
  console.log('📩 POST to /v1/chat/completions');
  await handleChat(req, res);
});

// Redirect tất cả POST đến handler
app.post('/', async (req, res) => {
  console.log('📩 POST to /');
  await handleChat(req, res);
});

app.post('*', async (req, res) => {
  console.log(`📩 POST to ${req.path}`);
  await handleChat(req, res);
});

// Hàm xử lý chat
async function handleChat(req, res) {
  try {
    const { model, messages, temperature = 0.7, max_tokens = 4096, stream = false } = req.body;
    
    console.log(`Model: ${model}, Stream: ${stream}, Messages: ${messages?.length || 0}`);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        error: { message: 'messages is required' } 
      });
    }

    const nimModel = MODELS[model] || 'z-ai/glm-5.2';
    
    const payload = {
      model: nimModel,
      messages: messages.map(m => ({
        role: m.role || 'user',
        content: String(m.content || '')
      })),
      temperature: Math.min(Math.max(temperature, 0), 1),
      max_tokens: Math.min(Math.max(max_tokens, 1), 16384),
      stream: Boolean(stream)
    };

    const response = await axios({
      method: 'POST',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: payload,
      timeout: 120000
    });

    // Trả về response
    const data = response.data;
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: data.choices.map(c => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content || ''
        },
        finish_reason: c.finish_reason
      })),
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'server_error'
      }
    });
  }
}

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', models: Object.keys(MODELS) });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODELS).map(id => ({ id, object: 'model' }))
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    endpoints: ['POST /', 'POST /v1/chat/completions'],
    models: Object.keys(MODELS)
  });
});

// 404
app.use((req, res) => {
  console.log(`❌ 404: ${req.method} ${req.path}`);
  res.status(404).json({ error: { message: 'Not found', code: 404 } });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`🤖 Models: ${Object.keys(MODELS).join(', ')}`);
  console.log(`🔑 API Key: ${NIM_API_KEY ? '✅' : '❌'}\n`);
});