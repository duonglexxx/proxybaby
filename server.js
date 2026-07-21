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

// Toggle features
const SHOW_REASONING = process.env.SHOW_REASONING === 'true' || false;
const ENABLE_THINKING_MODE = process.env.ENABLE_THINKING_MODE === 'true' || false;

// Model mapping with priority
const MODEL_MAPPING = {
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
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
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
    const { model, messages, temperature, max_tokens, stream, ...rest } = req.body;

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

    // Add thinking mode if enabled
    if (ENABLE_THINKING_MODE && supportsThinking(nimModel)) {
      nimRequest.extra_body = { chat_template_kwargs: { thinking: true } };
    }

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
  if (!model) return 'meta/llama-3.1-8b-instruct';
  
  const mapped = MODEL_MAPPING[model];
  if (mapped) return mapped;

  // Smart fallback
  const lower = model.toLowerCase();
  if (lower.includes('gpt-4') || lower.includes('claude-opus') || lower.includes('405b')) {
    return 'meta/llama-3.1-405b-instruct';
  } else if (lower.includes('claude') || lower.includes('gemini') || lower.includes('70b')) {
    return 'meta/llama-3.1-70b-instruct';
  }
  return 'meta/llama-3.1-8b-instruct';
}

function supportsThinking(model) {
  const thinkingModels = ['qwen/qwen3-next-80b-a3b-thinking', 'qwen/qwen3-coder-480b-a35b-instruct'];
  return thinkingModels.some(m => model.includes(m));
}

function handleStreamingResponse(response, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let buffer = '';
  let reasoningStarted = false;

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
          const reasoning = delta.reasoning_content;
          const content = delta.content;

          if (SHOW_REASONING && reasoning) {
            const formatted = reasoningStarted ? reasoning : `<think>\n${reasoning}`;
            reasoningStarted = true;
            delta.content = formatted;
            
            if (content) {
              delta.content += `</think>\n\n${content}`;
              reasoningStarted = false;
            }
          } else if (SHOW_REASONING && content && reasoningStarted) {
            delta.content = `</think>\n\n${content}`;
            reasoningStarted = false;
          } else if (content) {
            delta.content = content;
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
      let content = choice.message?.content || '';
      
      if (SHOW_REASONING && choice.message?.reasoning_content) {
        content = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${content}`;
      }

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

// Catch-all for 404
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// Export for Vercel
module.exports = app;