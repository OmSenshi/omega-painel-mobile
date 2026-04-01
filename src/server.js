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

// ═══ HISTÓRICO DE CADASTROS (salvar/carregar, 7 dias) ═══
const HIST_DIR = path.join(__dirname, '..', 'data', 'historico');
const IMPORT_DIR = path.join(__dirname, '..', 'data', 'imports');
const fs = require('fs');
if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
if (!fs.existsSync(IMPORT_DIR)) fs.mkdirSync(IMPORT_DIR, { recursive: true });

// Salvar cadastro
app.post('/api/historico/salvar', (req, res) => {
  const { tipo, documento, dados } = req.body;
  const id = Date.now().toString();
  const entry = {
    id,
    tipo, // cpf ou cnpj
    documento, // numero do cpf ou cnpj
    dados,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(HIST_DIR, id + '.json'), JSON.stringify(entry, null, 2));
  res.json({ success: true, id });
});

// Listar histórico
app.get('/api/historico/listar', (req, res) => {
  const files = fs.readdirSync(HIST_DIR).filter(f => f.endsWith('.json'));
  const items = [];
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(HIST_DIR, file), 'utf8'));
      const age = now - new Date(data.created_at).getTime();
      if (age > SEVEN_DAYS) {
        // Apaga automaticamente após 7 dias
        fs.unlinkSync(path.join(HIST_DIR, file));
        continue;
      }
      items.push({ id: data.id, tipo: data.tipo, documento: data.documento, created_at: data.created_at });
    } catch {}
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ success: true, items });
});

// Carregar cadastro salvo
app.get('/api/historico/:id', (req, res) => {
  const file = path.join(HIST_DIR, req.params.id + '.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Nao encontrado' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json({ success: true, data: data.dados, tipo: data.tipo, documento: data.documento });
});

// ═══ IMPORTAR POR CÓDIGO (WhatsApp bot) ═══
app.get('/api/import/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const file = path.join(IMPORT_DIR, code + '.json');
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, error: 'Codigo nao encontrado: ' + code });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json({ success: true, data });
});

// Rota pra servir PDFs gerados (carteirinha e extrato)
app.use('/downloads', express.static(path.join(__dirname, '..', 'downloads')));

// Fallback pro SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Omega Painel Mobile v2.1`);
  console.log(`  Rodando em http://0.0.0.0:${PORT}`);
  console.log(`  Acesse do celular/tablet pelo IP da VPS\n`);
});
