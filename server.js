// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 Toggles
const SHOW_REASONING = false;  // Bật để xem thinking
const ENABLE_THINKING_MODE = false;  // Bật thinking cho DeepSeek

// 🔥 Model Mapping - Chỉ giữ DeepSeek và GLM
const MODEL_MAPPING = {
  'deepseek-v4': 'deepseek-ai/deepseek-v4-flash',
  'glm-5.2': 'z-ai/glm-5.2'
};

// ============================================
// 🔥 FIX CHO JANITOR AI - Redirect root → /v1/chat/completions
// ============================================
app.post('/', (req, res, next) => {
  console.log('🔄 Redirect POST / → /v1/chat/completions');
  req.url = '/v1/chat/completions';
  next('route');
});

app.post('/v1', (req, res, next) => {
  console.log('🔄 Redirect POST /v1 → /v1/chat/completions');
  req.url = '/v1/chat/completions';
  next('route');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    models: Object.keys(MODEL_MAPPING)
  });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ============================================
// 🔥 MAIN CHAT COMPLETIONS ENDPOINT
// ============================================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Chọn model
    let nimModel = MODEL_MAPPING[model] || 'deepseek-ai/deepseek-v4-flash';
    
    // Cấu hình riêng cho từng model
    let config = {
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 8192,
    };

    if (nimModel === 'deepseek-ai/deepseek-v4-flash') {
      config = {
        ...config,
        temperature: temperature || 1.0,
        max_tokens: max_tokens || 16384,
        top_p: 0.95,
        chat_template_kwargs: { thinking: true, reasoning_effort: "high" }
      };
    } else if (nimModel === 'z-ai/glm-5.2') {
      config = {
        ...config,
        temperature: temperature || 0.8,
        max_tokens: max_tokens || 8192,
        top_p: 0.9,
        chat_template_kwargs: { enable_thinking: true }
      };
    }

    // Build request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      top_p: config.top_p || 0.95,
      ...(config.chat_template_kwargs && { chat_template_kwargs: config.chat_template_kwargs }),
      stream: stream || false
    };

    console.log(`📤 ${model} → ${nimModel}`);

    // Gọi NVIDIA API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (stream) {
      // Xử lý stream (giữ nguyên)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '🧠 Thinking:\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  if (content && reasoningStarted) {
                    combinedContent += '\n\n💬 Response:\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  data.choices[0].delta.content = content || '';
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Non-streaming
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '🧠 Thinking:\n' + choice.message.reasoning_content + '\n\n💬 Response:\n' + fullContent;
          }
          return {
            index: choice.index,
            message: { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all
app.all('*', (req, res) => {
  res.status(404).json({
    error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`🧠 Reasoning: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🤖 Models: DeepSeek-V4-Flash & Z.AI GLM-5.2`);
});