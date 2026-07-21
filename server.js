// server.js - OpenAI to NVIDIA NIM API Proxy (Optimized for Vercel)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Model mapping - Cập nhật với model mới
const MODEL_MAPPING = {
  // Các model mới
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'kimi-k2.6': 'moonshotai/kimi-k2.6'
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    version: '1.0.0',
    available_models: Object.keys(MODEL_MAPPING),
    timestamp: new Date().toISOString()
  });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy',
    permission: []
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// Main chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Validate API key
    if (!NIM_API_KEY) {
      throw new Error('NIM_API_KEY is not configured');
    }

    // Smart model selection
    let nimModel = getModelMapping(model);

    // Transform request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: Math.min(max_tokens || 4096, 16384),
      stream: stream || false
    };

    // Make request to NVIDIA NIM
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json'
        },
        timeout: 120000,
        responseType: stream ? 'stream' : 'json',
        validateStatus: (status) => status < 500
      }
    );

    // Handle streaming
    if (stream) {
      return handleStreamingResponse(response, res);
    }

    // Handle non-streaming
    return handleNonStreamingResponse(response, res, model);

  } catch (error) {
    console.error('Proxy error:', error.message);
    
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error?.message || error.message || 'Internal server error';
    
    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: 'api_error',
        code: statusCode
      }
    });
  }
});

// Helper functions
function getModelMapping(model) {
  if (!model) {
    // Default model nếu không có model được chỉ định
    return 'deepseek-ai/deepseek-v4-flash';
  }
  
  // Kiểm tra trong MODEL_MAPPING
  const mapped = MODEL_MAPPING[model];
  if (mapped) return mapped;

  // Smart fallback với model mới
  const lower = model.toLowerCase();
  
  // Map các tên model phổ biến sang model mới
  if (lower.includes('deepseek') || lower.includes('v4') || lower.includes('flash')) {
    return 'deepseek-ai/deepseek-v4-flash';
  } else if (lower.includes('glm') || lower.includes('z-ai')) {
    return 'z-ai/glm-5.2';
  } else if (lower.includes('kimi') || lower.includes('moonshot')) {
    return 'moonshotai/kimi-k2.6';
  }
  
  // Fallback cuối cùng
  return 'deepseek-ai/deepseek-v4-flash';
}

function handleStreamingResponse(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let buffer = '';

  response.data.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    lines.forEach(line => {
      if (!line.startsWith('data: ')) return;
      
      if (line.includes('[DONE]')) {
        res.write('data: [DONE]\n\n');
        return;
      }

      try {
        const data = JSON.parse(line.slice(6));
        if (data.choices?.[0]?.delta) {
          const delta = data.choices[0].delta;
          
          // Chỉ giữ lại content
          if (delta.content) {
            delta.content = delta.content;
          } else {
            delta.content = '';
          }
          delete delta.reasoning_content;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        res.write(`${line}\n`);
      }
    });
  });

  response.data.on('end', () => res.end());
  response.data.on('error', (err) => {
    console.error('Stream error:', err);
    res.end();
  });
}

function handleNonStreamingResponse(response, res, originalModel) {
  const data = response.data;
  
  const transformed = {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: data.choices?.map(choice => {
      const content = choice.message?.content || '';
      
      return {
        index: choice.index || 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: content
        },
        finish_reason: choice.finish_reason || 'stop'
      };
    }) || [],
    usage: data.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  res.json(transformed);
}

// Catch-all cho 404
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// Export cho Vercel
module.exports = app;
