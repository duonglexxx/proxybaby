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

// Model mapping - Chính xác theo từng model
const MODEL_MAPPING = {
  'step-3.7-flash': 'stepfun-ai/step-3.7-flash',
  'glm-5.2': 'z-ai/glm-5.2',
  'minimax-m3': 'minimaxai/minimax-m3',
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
    const { model, messages, temperature, max_tokens, stream, top_p, frequency_penalty, presence_penalty } = req.body;

    // Validate API key
    if (!NIM_API_KEY) {
      throw new Error('NIM_API_KEY is not configured');
    }

    // Validate model
    if (!model) {
      throw new Error('Model is required');
    }

    // Lấy đúng model mapping, không fallback
    const nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      throw new Error(`Model "${model}" is not supported. Available models: ${Object.keys(MODEL_MAPPING).join(', ')}`);
    }

    // Transform request với các tham số tối ưu
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.8,
      max_tokens: Math.min(max_tokens || 8192, 32768),
      top_p: top_p || 0.95,
      frequency_penalty: frequency_penalty !== undefined ? frequency_penalty : 0.1,
      presence_penalty: presence_penalty !== undefined ? presence_penalty : 0.1,
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
        timeout: 180000,
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