// server.js - OpenAI to NVIDIA NIM API Proxy (STRICT VERSION)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 📌 DANH SÁCH MODEL ĐƯỢC PHÉP HOẠT ĐỘNG (WHITELIST)
// Key là tên client gọi lên, Value là tên chuẩn trên NVIDIA NIM. 
// Nếu client gọi đúng tên chuẩn rồi thì để giống nhau.
const ALLOWED_MODELS = {
  'deepseek-v4-flash-0731': 'deepseek-ai/deepseek-v4-flash-0731',
  'minimax-m3': 'minimaxai/minimax-m3',
  'meta/llama-3.1-405b-instruct': 'meta/llama-3.1-405b-instruct',
  'meta/llama-3.1-70b-instruct': 'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct': 'meta/llama-3.1-8b-instruct'
  // Bạn có thể thêm các model khác của NVIDIA vào đây
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy Strict' });
});

// 📌 ENDPOINT /v1/models - Trả về đúng danh sách model được phép
app.get('/v1/models', (req, res) => {
  const models = Object.keys(ALLOWED_MODELS).map(modelId => ({
    id: modelId,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// 📌 ENDPOINT CHAT COMPLETIONS - KHÔNG CÓ FALLBACK LINH TINH
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream, ...rest } = req.body;

    if (!model) {
      return res.status(400).json({ error: { message: 'Model is required', type: 'invalid_request_error' } });
    }

    if (!NIM_API_KEY) {
      return res.status(500).json({ error: { message: 'NIM_API_KEY not configured on server', type: 'server_error' } });
    }

    // 🛑 KIỂM TRA NGHIÊM NGẶT: Model có nằm trong danh sách cho phép không?
    const nimModel = ALLOWED_MODELS[model];
    
    if (!nimModel) {
      // Từ chối thẳng thừng, không tự ý đổi sang Llama hay model khác nữa
      return res.status(400).json({
        error: {
          message: `Model '${model}' is not supported or not allowed on this proxy.`,
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    console.log(`✅ Using Model: ${model} → Target NIM: ${nimModel} (Stream: ${stream ? 'Yes' : 'No'})`);

    // Xây dựng request payload
    const nimRequest = {
      model: nimModel,
      messages: messages,
      stream: stream ?? false,
      ...rest // Giữ nguyên các tham số top_p, temperature, stop,... từ client gửi lên
    };

    // Gửi sang NVIDIA NIM qua Axios
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

    // Xử lý streaming an toàn
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      response.data.pipe(res);
      
      response.data.on('error', (err) => {
        console.error('❌ Stream Error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Stream processing error' } });
        } else {
          res.end();
        }
      });
      return;
    }

    // Transform response về đúng chuẩn OpenAI format cho non-stream
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model, // Trả về đúng tên model mà client đã gọi
      choices: response.data.choices.map(choice => ({
        index: choice.index || 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: choice.message?.content || ''
        },
        finish_reason: choice.finish_reason || 'stop'
      })),
      usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(openaiResponse);

  } catch (error) {
    console.error('❌ Proxy Error:', error.message);
    
    let errorData = { message: 'Internal server error', type: 'proxy_error' };
    let status = error.response?.status || 500;

    if (error.response) {
      try {
        if (error.response.data && typeof error.response.data.on === 'function') {
          let errorString = '';
          for await (const chunk of error.response.data) {
            errorString += chunk;
          }
          const parsed = JSON.parse(errorString);
          errorData = parsed.error || parsed;
        } else if (error.response.data) {
          errorData = error.response.data.error || error.response.data;
        }
      } catch (e) {
        errorData = { message: error.message };
      }
    }

    res.status(status).json({
      error: {
        message: errorData.message || error.message,
        type: errorData.type || 'proxy_error',
        code: status
      }
    });
  }
});

// 📌 CATCH-ALL
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found.`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Strict Proxy running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
});