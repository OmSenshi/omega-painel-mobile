// src/server.js — Servidor principal Omega Painel Mobile
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const cors = require('cors');

const automationRoutes = require('./routes/automation');
const extractionRoutes = require('./routes/extraction');

const app = express();
const server = http.createServer(app);

// WebSocket simples via SSE (Server-Sent Events) — mais leve que socket.io
const clients = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Upload de documentos (CRLV, CNH, comprovante, cartão CNPJ)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// SSE — stream de status em tempo real pro celular
app.get('/api/status/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const clientId = Date.now().toString();
  clients.set(clientId, res);

  req.on('close', () => clients.delete(clientId));
});

// Função global pra enviar status pra todos os clientes conectados
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const [, res] of clients) {
    res.write(msg);
  }
}

// Disponibiliza broadcast pros módulos de automação
app.set('broadcast', broadcast);

// Rotas
app.use('/api/extract', upload.single('document'), extractionRoutes);
app.use('/api/automation', automationRoutes);

// Rota pra servir PDFs gerados (carteirinha e extrato)
app.use('/downloads', express.static(path.join(__dirname, '..', 'downloads')));

// Fallback pro SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Omega Painel Mobile v2.0`);
  console.log(`  Rodando em http://0.0.0.0:${PORT}`);
  console.log(`  Acesse do celular/tablet pelo IP da VPS\n`);
});
