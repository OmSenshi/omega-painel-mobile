// src/routes/automation.js — Rotas de controle da automação
const express = require('express');
const router = express.Router();
const AutomationEngine = require('../automation/engine');

// Estado global da automação ativa
let activeEngine = null;

// POST /api/automation/start — inicia automação com dados do painel
router.post('/start', async (req, res) => {
  if (activeEngine && activeEngine.status === 'running') {
    return res.status(409).json({ error: 'Já existe uma automação em andamento' });
  }

  const { tipo, credenciais, transportador, veiculos, cnpj_data } = req.body;
  const broadcast = req.app.get('broadcast');

  try {
    activeEngine = new AutomationEngine(broadcast);
    res.json({ success: true, message: 'Automação iniciada' });

    // Roda em background (não bloqueia a resposta)
    activeEngine.run({ tipo, credenciais, transportador, veiculos, cnpj_data })
      .catch(err => {
        broadcast({
          event: 'error_critical',
          message: 'Erro fatal: ' + err.message,
          checkpoint: activeEngine.checkpoint
        });
      });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/fix — corrige campo e retenta
router.post('/fix', async (req, res) => {
  if (!activeEngine || activeEngine.status !== 'paused') {
    return res.status(400).json({ error: 'Nenhuma automação pausada' });
  }

  const { field, value } = req.body;
  try {
    activeEngine.fix(field, value);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/resume — retoma automação pausada
router.post('/resume', (req, res) => {
  if (!activeEngine || activeEngine.status !== 'paused') {
    return res.status(400).json({ error: 'Nenhuma automação pausada' });
  }
  activeEngine.resume();
  res.json({ success: true });
});

// POST /api/automation/stop — para automação
router.post('/stop', async (req, res) => {
  if (!activeEngine) {
    return res.status(400).json({ error: 'Nenhuma automação ativa' });
  }
  await activeEngine.stop();
  const checkpoint = activeEngine.checkpoint;
  activeEngine = null;
  res.json({ success: true, checkpoint });
});

// GET /api/automation/state — estado atual
router.get('/state', (req, res) => {
  if (!activeEngine) {
    return res.json({ status: 'idle', checkpoint: null });
  }
  res.json({
    status: activeEngine.status,
    checkpoint: activeEngine.checkpoint,
    currentStep: activeEngine.currentStep,
    error: activeEngine.lastError
  });
});

module.exports = router;
