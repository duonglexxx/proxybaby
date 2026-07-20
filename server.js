// server.js - OpenAI to NVIDIA NIM API Proxy (Optimized)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createServer } = require('http');

class NIMProxyServer {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.port = process.env.PORT || 3000;
    this.nimApiBase = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
    this.nimApiKey = process.env.NIM_API_KEY;
    this.modelMapping = {
      'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
      'glm-5.2': 'z-ai/glm-5.2',
      'kimi-k2.6': 'moonshotai/kimi-k2.6'
    };
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
    }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Logging middleware
    this.app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'operational',
        service: 'openai-nim-proxy',
        version: '1.0.0',
        uptime: process.uptime(),
        models: Object.keys(this.modelMapping),
        endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/']
      });
    });

    // Models listing
    this.app.get('/v1/models', (req, res) => {
      const modelList = Object.entries(this.modelMapping).map(([proxyModel, nimModel]) => ({
        id: proxyModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-nim',
        root: nimModel
      }));
      
      res.json({
        object: 'list',
        data: modelList
      });
    });

    // Support GET requests to root (for Janitor AI)
    this.app.get('/', (req, res) => {
      // Janitor AI might expect a response with available endpoints
      res.json({
        message: 'OpenAI to NVIDIA NIM Proxy',
        documentation: 'Use POST /v1/chat/completions or POST /',
        models: Object.keys(this.modelMapping),
        endpoints: {
          'POST /v1/chat/completions': 'Main chat completions endpoint',
          'POST /': 'Alias for chat completions',
          'GET /health': 'Health check',
          'GET /v1/models': 'List available models'
        }
      });
    });

    // Handle root POST requests (for chat completions)
    this.app.post('/', this.handleChatCompletion.bind(this));

    // Handle root POST with different paths that Janitor might use
    this.app.post('/v1', this.handleChatCompletion.bind(this));
    this.app.post('/v1/chat', this.handleChatCompletion.bind(this));
    this.app.post('/chat/completions', this.handleChatCompletion.bind(this));

    // Main chat completions endpoint
    this.app.post('/v1/chat/completions', this.handleChatCompletion.bind(this));

    // Handle OPTIONS preflight requests
    this.app.options('*', (req, res) => {
      res.status(204).send();
    });

    // 404 handler
    this.app.use((req, res) => {
      console.log(`404: ${req.method} ${req.path}`);
      res.status(404).json({
        error: {
          message: `Endpoint ${req.method} ${req.path} not found`,
          type: 'not_found_error',
          code: 404
        }
      });
    });

    // Global error handler
    this.app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 500
        }
      });
    });
  }

  async handleChatCompletion(req, res) {
    try {
      // Parse body - support both JSON and form data
      let body = req.body;
      if (req.method === 'GET') {
        // If it's a GET request, try to parse query params
        body = req.query;
      }

      const { 
        model, 
        messages, 
        temperature = 0.7, 
        max_tokens = 4096, 
        stream = false,
        seed = 0,
        top_p = 1
      } = body;

      // Input validation
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Invalid messages array. Expected non-empty array of messages.',
            type: 'validation_error',
            code: 400,
            received: messages
          }
        });
      }

      // Get NIM model mapping
      const nimModel = this.modelMapping[model] || model || 'moonshotai/kimi-k2.6';
      
      // Build NIM request payload
      const nimRequestPayload = {
        model: nimModel,
        messages: this.cleanMessages(messages),
        temperature: Math.min(Math.max(parseFloat(temperature) || 0.7, 0), 1),
        max_tokens: Math.min(Math.max(parseInt(max_tokens) || 4096, 1), 16384),
        stream: Boolean(stream),
        seed: parseInt(seed) || 0,
        top_p: Math.min(Math.max(parseFloat(top_p) || 1, 0), 1)
      };

      console.log(`[${new Date().toISOString()}] 🚀 ${model || 'default'} → ${nimModel}`);
      console.log(`Messages: ${messages.length}, Tokens: ${max_tokens}, Stream: ${stream}`);

      // Forward to NIM API
      const startTime = Date.now();
      const response = await this.forwardToNIM(nimRequestPayload, stream);

      if (stream) {
        await this.handleStreamResponse(response, res);
      } else {
        await this.handleNonStreamResponse(response, res, model || nimModel, startTime);
      }

    } catch (error) {
      this.handleError(error, res);
    }
  }

  cleanMessages(messages) {
    return messages.map(msg => ({
      role: msg.role || 'user',
      content: String(msg.content || '')
    })).filter(msg => msg.content.trim().length > 0);
  }

  async forwardToNIM(payload, stream) {
    const headers = {
      'Authorization': `Bearer ${this.nimApiKey}`,
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json'
    };

    console.log(`📤 Forwarding to NIM API: ${this.nimApiBase}/chat/completions`);
    console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));

    return await axios.post(
      `${this.nimApiBase}/chat/completions`,
      payload,
      {
        headers: headers,
        responseType: stream ? 'stream' : 'json',
        timeout: 120000,
        maxRedirects: 3
      }
    );
  }

  async handleStreamResponse(response, res) {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = response.data;
      let buffer = '';

      stream.on('data', (chunk) => {
        try {
          const chunkStr = chunk.toString();
          const lines = chunkStr.split('\n').filter(line => line.trim() !== '');
          
          lines.forEach(line => {
            if (line.startsWith('data: ')) {
              const data = line.substring(6);
              if (data === '[DONE]') {
                res.write(line + '\n\n');
                return;
              }
              res.write(line + '\n\n');
            } else if (line.trim() === '') {
              // Keep empty lines for SSE format
              res.write('\n');
            }
          });
        } catch (err) {
          console.error('Stream processing error:', err);
        }
      });

      stream.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        res.write('event: error\ndata: {"error": "Stream interrupted"}\n\n');
        res.end();
      });

    } catch (error) {
      console.error('Stream handling error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: 'Stream processing failed', type: 'server_error', code: 500 }
        });
      }
    }
  }

  async handleNonStreamResponse(response, res, model, startTime) {
    const nimData = response.data;
    
    const formattedResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: nimData.choices?.map((choice, index) => ({
        index: index,
        message: {
          role: choice.message?.role || 'assistant',
          content: choice.message?.content || ''
        },
        finish_reason: choice.finish_reason || 'stop'
      })) || [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'No response from NIM API'
        },
        finish_reason: 'error'
      }],
      usage: {
        prompt_tokens: nimData.usage?.prompt_tokens || 0,
        completion_tokens: nimData.usage?.completion_tokens || 0,
        total_tokens: nimData.usage?.total_tokens || 0
      },
      system_fingerprint: `nim_${Date.now()}`
    };

    res.json(formattedResponse);
    console.log(`✅ Response sent in ${Date.now() - startTime}ms`);
  }

  handleError(error, res) {
    console.error(`[${new Date().toISOString()}] ❌ Error:`, error.message);
    
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      
      console.error(`Status: ${status}`);
      console.error('Response:', JSON.stringify(data, null, 2));
      
      if (status === 429) {
        return res.status(429).json({
          error: {
            message: 'Rate limit exceeded. Please try again later.',
            type: 'rate_limit_error',
            code: 429,
            retry_after: 30
          }
        });
      }
      
      if (status === 401) {
        return res.status(401).json({
          error: {
            message: 'Invalid NVIDIA API key. Please check your NIM_API_KEY environment variable.',
            type: 'authentication_error',
            code: 401
          }
        });
      }
      
      if (status === 403) {
        return res.status(403).json({
          error: {
            message: 'Access forbidden. Please check your API key permissions.',
            type: 'authorization_error',
            code: 403
          }
        });
      }
      
      return res.status(status).json({
        error: {
          message: data.error?.message || data.message || 'NIM API error',
          type: 'nim_api_error',
          code: status,
          details: data
        }
      });
    }
    
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({
        error: {
          message: 'Gateway timeout: NIM API took too long to respond (120s)',
          type: 'timeout_error',
          code: 504
        }
      });
    }
    
    if (error.code === 'ENOTFOUND') {
      return res.status(503).json({
        error: {
          message: 'Cannot reach NVIDIA NIM API. Check your network connection.',
          type: 'network_error',
          code: 503
        }
      });
    }
    
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        code: 500
      }
    });
  }

  start() {
    this.server.listen(this.port, () => {
      console.log('╔══════════════════════════════════════════╗');
      console.log('║   OpenAI to NVIDIA NIM Proxy v1.0.0    ║');
      console.log('╚══════════════════════════════════════════╝');
      console.log(`🚀 Server running on port ${this.port}`);
      console.log(`📍 Health: http://localhost:${this.port}/health`);
      console.log(`🤖 Models: ${Object.keys(this.modelMapping).join(', ')}`);
      console.log(`🔑 NIM API: ${this.nimApiKey ? '✅ Configured' : '❌ Missing'}`);
      console.log(`📡 NIM Base: ${this.nimApiBase}`);
      console.log('────────────────────────────────────────────');
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
  }

  shutdown(signal) {
    console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
    this.server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  }
}

// Initialize and start server
if (require.main === module) {
  const proxy = new NIMProxyServer();
  proxy.start();
}

module.exports = NIMProxyServer;