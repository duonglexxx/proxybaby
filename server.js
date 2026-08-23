// server.js - OpenAI to NVIDIA NIM API Proxy (FULL VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 📌 CẤU HÌNH QUAN TRỌNG
const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 📌 MODEL MAPPING - Cái này giúp chuyển đổi tên model
const MODEL_MAPPING = {
  'deepseek-v4-flash-0731': 'deepseek-ai/deepseek-v4-flash-0731',
  'minimax-m3': 'minimaxai/minimax-m3'
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

// 📌 ENDPOINT /v1/models - Trả về danh sách model hỗ trợ
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

// 📌 ENDPOINT CHAT COMPLETIONS - XỬ LÝ THÔNG MINH
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!model) {
      return res.status(400).json({ error: { message: 'Model is required' } });
    }

    if (!NIM_API_KEY) {
      return res.status(500).json({ error: { message: 'NIM_API_KEY not configured' } });
    }

    // 🔥 SMART MODEL SELECTION - Tự động chọn model phù hợp
    let nimModel = MODEL_MAPPING[model];
    
    if (!nimModel) {
      // Fallback logic thông minh
      const modelLower = model.toLowerCase();
      if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus')) {
        nimModel = 'meta/llama-3.1-405b-instruct';
      } else if (modelLower.includes('claude') || modelLower.includes('gemini')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }

    console.log(`🔄 Mapping: ${model} → ${nimModel}`);

    // Xây dựng request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 9024,
      stream: stream ?? false
    };

    // Thêm thinking mode nếu cần
    if (ENABLE_THINKING_MODE) {
      nimRequest.chat_template_kwargs = { thinking: false };
    }

    // Gửi sang NVIDIA
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 180000,
        responseType: stream ? 'stream' : 'json'
      }
    );

    // Xử lý streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
      response.data.on('error', () => res.end());
      return;
    }

    // Transform response về OpenAI format
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

// 📌 CATCH-ALL - Bắt các endpoint không tồn tại
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
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`📋 Models: http://localhost:${PORT}/v1/models`);
});