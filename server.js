// server.js - OpenAI to NVIDIA NIM API Proxy (SPEED OPTIMIZED)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 📌 CẤU HÌNH TỐI ƯU TỐC ĐỘ
const CONFIG = {
  // Giảm temperature để response nhanh hơn (ít random hơn)
  temperature: 0.3,
  
  // Giảm max_tokens để response nhanh hơn
  max_tokens: 1024,
  
  // Timeout ngắn hơn
  timeout: 30000, // 30 giây
  
  // Tắt thinking mode để nhanh hơn
  enable_thinking: false
};

// 📌 MODEL MAPPING
const MODEL_MAPPING = {
  'deepseek-v4-flash-0731': 'deepseek-ai/deepseek-v4-flash-0731',
  'minimax-m3': 'minimaxai/minimax-m3'
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy (Speed Optimized)' });
});

// 📌 ENDPOINT /v1/models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// 📌 ENDPOINT CHAT COMPLETIONS - TỐI ƯU TỐC ĐỘ
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!model) {
      return res.status(400).json({ error: { message: 'Model is required' } });
    }

    if (!NIM_API_KEY) {
      return res.status(500).json({ error: { message: 'NIM_API_KEY not configured' } });
    }

    // 🔥 SMART MODEL SELECTION - Ưu tiên model nhanh nhất
    let nimModel = MODEL_MAPPING[model];
    
    if (!nimModel) {
      // Luôn chọn model nhanh nhất (8B)
      nimModel = 'meta/llama-3.1-8b-instruct';
    }

    console.log(`🔄 Mapping: ${model} → ${nimModel}`);

    // Xây dựng request - Tối ưu cho tốc độ
    const nimRequest = {
      model: nimModel,
      messages: messages,
      // Ưu tiên giá trị từ request, nếu không thì dùng config speed
      temperature: temperature !== undefined ? Math.min(temperature, 0.5) : CONFIG.temperature,
      max_tokens: max_tokens !== undefined ? Math.min(max_tokens, 2048) : CONFIG.max_tokens,
      stream: stream ?? false,
      // Thêm top_p thấp để focus hơn, response nhanh hơn
      top_p: 0.8
    };

    // KHÔNG bật thinking mode để nhanh hơn
    if (CONFIG.enable_thinking) {
      nimRequest.chat_template_kwargs = { thinking: false };
    }

    console.log(`⏱️ Sending request with speed optimization...`);
    const startTime = Date.now();

    // Gửi sang NVIDIA với timeout ngắn
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: CONFIG.timeout,
        responseType: stream ? 'stream' : 'json'
      }
    );

    const elapsed = Date.now() - startTime;
    console.log(`✅ Response in ${elapsed}ms`);

    // Xử lý streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
      response.data.on('error', () => res.end());
      return;
    }

    // Transform response
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: response.data.choices.map(choice => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message?.content || ''
        },
        finish_reason: choice.finish_reason
      })),
      usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(openaiResponse);

  } catch (error) {
    console.error('❌ Proxy Error:', error.message);
    
    // Xử lý timeout
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: {
          message: 'Request timeout - please try again',
          type: 'timeout_error',
          code: 504
        }
      });
    }
    
    if (error.response) {
      console.error('📥 Status:', error.response.status);
      console.error('📥 Data:', error.response.data);
    }

    const status = error.response?.status || 500;
    res.status(status).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'proxy_error',
        code: status
      }
    });
  }
});

// 📌 CATCH-ALL
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found. Try /v1/models or /v1/chat/completions`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Speed-optimized Proxy running on port ${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`📋 Models: http://localhost:${PORT}/v1/models`);
  console.log(`\n⚡ Speed Config:`);
  console.log(`   Temperature: ${CONFIG.temperature} (low for speed)`);
  console.log(`   Max Tokens: ${CONFIG.max_tokens} (limited for speed)`);
  console.log(`   Timeout: ${CONFIG.timeout/1000}s`);
  console.log(`   Thinking Mode: OFF`);
});