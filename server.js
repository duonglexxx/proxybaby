// server.js - OpenAI to NVIDIA NIM API Proxy (Dynamic Model Version)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 1. Endpoint trả về thông tin chung cho app chat
app.get('/v1/models', (req, res) => {
  // Trả về một phản hồi giả lập để app chat không báo lỗi
  res.json({
    object: 'list',
    data: [{
      id: 'dynamic-model', // Tên gợi ý cho UI
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'nvidia-nim',
    }]
  });
});

// 2. Xử lý chat completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream, ...rest } = req.body;

    if (!model) throw new Error('Model name is required');
    if (!NIM_API_KEY) throw new Error('NIM_API_KEY is not configured');

    // NHẬN GÌ GỬI NẤY: Sử dụng trực tiếp tên model client gửi lên
    const nimRequest = {
      model: model, 
      messages: messages,
      temperature: temperature ?? 0.8,
      max_tokens: max_tokens ?? 8192,
      stream: stream ?? false,
      ...rest
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json'
        },
        timeout: 180000,
        responseType: stream ? 'stream' : 'json',
        validateStatus: (status) => status < 500
      }
    );

    if (stream) {
      return handleStreamingResponse(response, res);
    }
    return res.json(response.data);

  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: { message: error.message } });
  }
});

// (Giữ nguyên các hàm xử lý stream như cũ để đảm bảo không bị lỗi dữ liệu)
function handleStreamingResponse(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  response.data.pipe(res);
}

module.exports = app;