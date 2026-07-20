// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const NIM_API_KEY = process.env.NIM_API_KEY;
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 204
}));

app.use(express.json());

// Models
const MODELS = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

// Chat completions - HỖ TRỢ STREAM
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature = 0.7, max_tokens = 4096, stream = false, seed = 0, top_p = 1 } = req.body;
    
    console.log(`📩 Request: ${model}, stream: ${stream}, messages: ${messages?.length || 0}`);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Invalid messages' } });
    }

    const nimModel = MODELS[model] || 'z-ai/glm-5.2';
    
    const payload = {
      model: nimModel,
      messages: messages.map(m => ({ role: m.role || 'user', content: String(m.content || '') })),
      temperature: Math.min(Math.max(temperature, 0), 1),
      max_tokens: Math.min(Math.max(max_tokens, 1), 16384),
      seed: seed || 0,
      top_p: Math.min(Math.max(top_p || 1, 0), 1),
      stream: Boolean(stream)
    };

    // Forward to NVIDIA
    const response = await axios({
      method: 'POST',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': stream ? 'text/event-stream' : 'application/json'
      },
      data: payload,
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (stream) {
      // STREAMING - Forward trực tiếp
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      response.data.pipe(res);
      
      response.data.on('end', () => {
        console.log('✅ Stream ended');
      });
      
    } else {
      // NON-STREAMING
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
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      if (error.response.data) {
        console.error('Data:', JSON.stringify(error.response.data, null, 2));
      }
    }
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'server_error'
      }
    });
  }
});

// Redirect tất cả POST đến /v1/chat/completions
app.post('*', (req, res) => {
  req.url = '/v1/chat/completions';
  app.handle(req, res);
});

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

// Root
app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    endpoints: {
      'POST /v1/chat/completions': 'Chat completions (supports stream)',
      'POST /': 'Redirect to /v1/chat/completions'
    },
    models: Object.keys(MODELS)
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', code: 404 } });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Proxy: http://localhost:${PORT}`);
  console.log(`🤖 Models: ${Object.keys(MODELS).join(', ')}`);
  console.log(`🔑 API Key: ${NIM_API_KEY ? '✅' : '❌'}\n`);
});
