// src/whatsapp/bot.js — Bot WhatsApp Omega Painel
// Recebe documentos, extrai via Claude API, salva com codigo
// Envia PDFs e alertas quando automação termina
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.CLAUDE_API_KEY;
const GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'Omega Bot';
const IMPORT_DIR = path.join(__dirname, '..', '..', 'data', 'imports');
const DOWNLOAD_DIR = path.join(__dirname, '..', '..', 'downloads');
const SESSION_DIR = path.join(__dirname, '..', '..', 'data', 'wpp-session');

// Garante diretórios
[IMPORT_DIR, DOWNLOAD_DIR, SESSION_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══ Prompts de extração (mesmos do extraction.js) ═══
const PROMPTS = {
  crlv: 'Extraia do CRLV exatamente estes campos e retorne SOMENTE neste formato JSON sem mais nada:\n{"tipo":"crlv","placa":"VALOR","renavam":"VALOR","cpf_cnpj":"VALOR","nome":"VALOR"}\n\nRegras: placa sem traco, renavam so numeros, cpf_cnpj so numeros (11 ou 14 digitos), nome em maiusculas. Campo nao encontrado = vazio.',

  cnh: 'Extraia da CNH/RG exatamente estes campos e retorne SOMENTE neste formato JSON sem mais nada:\n{"tipo":"cnh","identidade":"VALOR","uf":"VALOR"}\n\nRegras: identidade so numeros/letras sem pontos. uf = sigla estado em maiusculas. Se nao encontrar identidade use "000000".',

  comprovante: 'Extraia do comprovante de endereco exatamente estes campos e retorne SOMENTE neste formato JSON sem mais nada:\n{"tipo":"comprovante","cep":"VALOR","logradouro":"VALOR","numero":"VALOR","complemento":"VALOR","bairro":"VALOR"}\n\nRegras: cep so 8 numeros. logradouro em maiusculas sem numero. numero do endereco (se nao achar use "0"). bairro em maiusculas (se nao achar use "0").',

  cartao_cnpj: 'Extraia do cartao CNPJ/Certificado MEI exatamente estes campos e retorne SOMENTE neste formato JSON sem mais nada:\n{"tipo":"cartao_cnpj","cep":"VALOR","logradouro":"VALOR","numero":"VALOR","complemento":"VALOR","bairro":"VALOR","telefone":"VALOR","email":"VALOR"}\n\nRegras: cep so 8 numeros. logradouro em maiusculas. telefone so numeros com DDD. email se encontrar. Campos nao encontrados = vazio.',

  cnh_socio: 'Extraia da CNH do socio exatamente este campo e retorne SOMENTE neste formato JSON sem mais nada:\n{"tipo":"cnh_socio","cpf_socio":"VALOR"}\n\nRegras: cpf_socio so 11 numeros sem pontos ou traco.'
};

// ═══ Estado temporário por grupo ═══
const pendingDocs = new Map(); // groupId -> { docs: [], timer: null }

// ═══ Inicializa cliente ═══
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

let targetGroupId = null;
let botReady = false;

client.on('qr', (qr) => {
  console.log('\n═══════════════════════════════════');
  console.log('  ESCANEIE O QR CODE COM O WHATSAPP');
  console.log('  (Configurações > Dispositivos vinculados)');
  console.log('═══════════════════════════════════\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('\n  ✓ WhatsApp Bot conectado!');

  // Encontra o grupo pelo nome
  const chats = await client.getChats();
  const group = chats.find(c => c.isGroup && c.name === GROUP_NAME);
  if (group) {
    targetGroupId = group.id._serialized;
    console.log('  ✓ Grupo "' + GROUP_NAME + '" encontrado: ' + targetGroupId);
  } else {
    console.log('  ✗ Grupo "' + GROUP_NAME + '" NAO encontrado!');
    console.log('    Crie um grupo com esse nome e adicione o bot.\n');
  }

  botReady = true;
  console.log('  ✓ Bot pronto e ouvindo mensagens.\n');
});

client.on('auth_failure', (msg) => {
  console.error('  ✗ Falha na autenticação:', msg);
});

client.on('disconnected', (reason) => {
  console.log('  ✗ Desconectado:', reason);
  // Tenta reconectar
  setTimeout(() => client.initialize(), 5000);
});

// ═══ Listener de mensagens ═══
// message_create lê TODAS as mensagens (incluindo as do próprio número)
client.on('message_create', async (msg) => {
  if (!botReady || !targetGroupId) return;

  // Só processa mensagens do grupo Omega Bot
  // message_create usa msg.from pra mensagens de outros e msg.to pro grupo
  const chatId = msg.fromMe ? msg.to : msg.from;
  if (chatId !== targetGroupId) return;

  // TRAVA ANTI-LOOP: ignora mensagens enviadas pelo proprio bot
  // O bot responde com reply(), que gera mensagens fromMe
  // Só processa fromMe se tiver mídia (documento enviado pelo número corporativo)
  // Ignora textos fromMe pra evitar loop
  if (msg.fromMe && !msg.hasMedia) return;

  try {
    // ── Documento recebido (PDF ou imagem) ──
    if (msg.hasMedia) {
      await handleMedia(msg);
      return;
    }

    // ── Comando de texto ──
    const text = (msg.body || '').trim();

    // Comando: CODIGO (salva documentos pendentes com esse codigo)
    if (text.match(/^[A-Z0-9]{3,30}$/i) && pendingDocs.has(targetGroupId)) {
      await saveWithCode(msg, text.toUpperCase());
      return;
    }

    // Comando: /status
    if (text.toLowerCase() === '/status') {
      await sendStatus(msg);
      return;
    }

    // Comando: /ajuda
    if (text.toLowerCase() === '/ajuda' || text.toLowerCase() === '/help') {
      await msg.reply(
        '*Omega Bot — Comandos*\n\n' +
        '📄 Envie documentos (CRLV, CNH, comprovante, cartão CNPJ)\n' +
        '🔤 Depois digite um CÓDIGO (ex: VALDIR1252) pra salvar\n' +
        '📋 /status — ver status da automação\n' +
        '❓ /ajuda — ver comandos\n\n' +
        '_O bot detecta automaticamente o tipo de documento._'
      );
      return;
    }

  } catch (err) {
    console.error('Erro ao processar mensagem:', err);
    await msg.reply('❌ Erro: ' + err.message);
  }
});

// ═══ Processa mídia recebida ═══
async function handleMedia(msg) {
  const media = await msg.downloadMedia();
  if (!media) {
    await msg.reply('❌ Não consegui baixar o arquivo.');
    return;
  }

  const isImage = media.mimetype.startsWith('image/');
  const isPdf = media.mimetype === 'application/pdf';
  if (!isImage && !isPdf) {
    await msg.reply('⚠️ Envie apenas imagens ou PDFs.');
    return;
  }

  await msg.reply('🔍 Extraindo dados...');

  // Detecta tipo e extrai via Claude API
  const result = await extractDocument(media.data, media.mimetype);

  if (!result) {
    await msg.reply('❌ Não consegui extrair dados desse documento.');
    return;
  }

  // Acumula no estado pendente
  if (!pendingDocs.has(targetGroupId)) {
    pendingDocs.set(targetGroupId, { docs: [], timer: null });
  }
  const state = pendingDocs.get(targetGroupId);
  state.docs.push(result);

  // Reset timer de 5 minutos (se não mandar codigo em 5min, limpa)
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    pendingDocs.delete(targetGroupId);
  }, 5 * 60 * 1000);

  // Responde com resumo
  const tipoLabel = {
    crlv: '🚗 CRLV',
    cnh: '🪪 CNH/RG',
    comprovante: '🏠 Comprovante',
    cartao_cnpj: '🏢 Cartão CNPJ',
    cnh_socio: '👤 CNH Sócio'
  };

  let resumo = tipoLabel[result.tipo] || '📄 Documento';
  resumo += ' — extraído!\n\n';

  for (const [k, v] of Object.entries(result)) {
    if (k === 'tipo') continue;
    if (v) resumo += `*${k}:* ${v}\n`;
  }

  resumo += '\n📝 Total: ' + state.docs.length + ' doc(s) pendente(s)';
  resumo += '\n\n_Digite um CÓDIGO pra salvar (ex: VALDIR1252)_';

  await msg.reply(resumo);
}

// ═══ Extrai documento via Claude API ═══
async function extractDocument(base64Data, mimetype) {
  if (!API_KEY) {
    console.error('CLAUDE_API_KEY não configurada');
    return null;
  }

  // Primeiro tenta detectar o tipo automaticamente
  const detectPrompt = 'Identifique o tipo deste documento brasileiro e retorne SOMENTE uma dessas palavras sem mais nada: crlv, cnh, comprovante, cartao_cnpj, cnh_socio\n\nDicas:\n- CRLV: Certificado de Registro e Licenciamento de Veiculo (tem placa, renavam)\n- CNH: Carteira Nacional de Habilitacao ou RG (tem numero registro, UF)\n- Comprovante: conta de luz/agua/gas/banco com endereco\n- Cartao CNPJ: comprovante de inscricao CNPJ da Receita (tem CNPJ, endereco empresa)\n- CNH Socio: CNH de socio de empresa (mesmo formato que CNH normal)';

  const isDoc = mimetype === 'application/pdf';

  try {
    // Detecta tipo
    const detectRes = await callClaude(base64Data, mimetype, isDoc, detectPrompt);
    let tipo = (detectRes || '').trim().toLowerCase().replace(/[^a-z_]/g, '');

    // Valida tipo
    if (!PROMPTS[tipo]) {
      // Fallback: tenta CRLV (mais comum)
      tipo = 'crlv';
    }

    // Extrai dados
    const extractRes = await callClaude(base64Data, mimetype, isDoc, PROMPTS[tipo]);
    if (!extractRes) return null;

    // Parseia JSON
    const clean = extractRes.replace(/```json|```/g, '').trim();
    try {
      const data = JSON.parse(clean);
      data.tipo = tipo; // garante tipo
      return data;
    } catch {
      // Tenta extrair manualmente se JSON falhou
      console.error('JSON parse falhou:', clean);
      return { tipo, raw: clean };
    }

  } catch (err) {
    console.error('Erro na extração:', err);
    return null;
  }
}

async function callClaude(base64Data, mimetype, isDoc, prompt) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: isDoc ? 'document' : 'image',
          source: { type: 'base64', media_type: mimetype, data: base64Data }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.error) {
    console.error('Claude API erro:', data.error.message);
    return null;
  }

  return data.content?.[0]?.text || null;
}

// ═══ Salva documentos com código ═══
async function saveWithCode(msg, code) {
  const state = pendingDocs.get(targetGroupId);
  if (!state || state.docs.length === 0) {
    await msg.reply('⚠️ Nenhum documento pendente pra salvar.');
    return;
  }

  // Monta objeto consolidado
  const consolidated = {};
  const veiculos = [];

  for (const doc of state.docs) {
    switch (doc.tipo) {
      case 'crlv':
        veiculos.push({
          placa: doc.placa || '',
          renavam: doc.renavam || '',
          cpf_cnpj: doc.cpf_cnpj || '',
          nome: doc.nome || '',
          tipo: 'terceiro' // padrão pra arrendamento
        });
        break;
      case 'cnh':
        consolidated.cnh = { identidade: doc.identidade || '', uf: doc.uf || '' };
        break;
      case 'comprovante':
        consolidated.comprovante = {
          cep: doc.cep || '', logradouro: doc.logradouro || '',
          numero: doc.numero || '', complemento: doc.complemento || '',
          bairro: doc.bairro || ''
        };
        break;
      case 'cartao_cnpj':
        consolidated.cartao_cnpj = {
          cep: doc.cep || '', logradouro: doc.logradouro || '',
          numero: doc.numero || '', complemento: doc.complemento || '',
          bairro: doc.bairro || '', telefone: doc.telefone || '',
          email: doc.email || ''
        };
        break;
      case 'cnh_socio':
        consolidated.cnh_socio = { cpf_socio: doc.cpf_socio || '' };
        break;
    }
  }

  if (veiculos.length > 0) consolidated.crlv = veiculos;

  // Salva no diretório de imports
  const filepath = path.join(IMPORT_DIR, code + '.json');
  fs.writeFileSync(filepath, JSON.stringify(consolidated, null, 2));

  // Agenda limpeza em 7 dias
  setTimeout(() => {
    try { fs.unlinkSync(filepath); } catch {}
  }, 7 * 24 * 60 * 60 * 1000);

  // Limpa estado
  if (state.timer) clearTimeout(state.timer);
  pendingDocs.delete(targetGroupId);

  // Responde
  let resumo = '✅ *Salvo com código: ' + code + '*\n\n';
  resumo += '📄 ' + state.docs.length + ' documento(s) processado(s)\n';
  if (consolidated.cnh) resumo += '🪪 CNH: identidade ' + consolidated.cnh.identidade + ', UF ' + consolidated.cnh.uf + '\n';
  if (consolidated.comprovante) resumo += '🏠 Endereço: CEP ' + consolidated.comprovante.cep + '\n';
  if (consolidated.cartao_cnpj) resumo += '🏢 CNPJ: CEP ' + consolidated.cartao_cnpj.cep + ', tel ' + consolidated.cartao_cnpj.telefone + '\n';
  if (consolidated.cnh_socio) resumo += '👤 Sócio: CPF ' + consolidated.cnh_socio.cpf_socio + '\n';
  if (veiculos.length > 0) resumo += '🚗 ' + veiculos.length + ' veículo(s): ' + veiculos.map(v => v.placa).join(', ') + '\n';
  resumo += '\n_Use o código *' + code + '* no painel Omega pra importar._';

  await msg.reply(resumo);
}

// ═══ Envia status da automação ═══
async function sendStatus(msg) {
  try {
    const res = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/automation/state');
    const data = await res.json();
    let text = '📊 *Status da automação*\n\n';
    text += 'Estado: ' + (data.status || 'idle') + '\n';
    if (data.currentStep) text += 'Etapa: ' + data.currentStep + '\n';
    if (data.error) text += '❌ Erro: ' + data.error.message + '\n';
    await msg.reply(text);
  } catch {
    await msg.reply('📊 Automação: idle (sem processo ativo)');
  }
}

// ═══ Funções exportadas pro servidor ═══

// Envia mensagem pro grupo
async function sendToGroup(text) {
  if (!botReady || !targetGroupId) return false;
  try {
    await client.sendMessage(targetGroupId, text);
    return true;
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    return false;
  }
}

// Envia arquivo (PDF) pro grupo
async function sendFileToGroup(filepath, caption) {
  if (!botReady || !targetGroupId) return false;
  try {
    if (!fs.existsSync(filepath)) return false;
    const media = MessageMedia.fromFilePath(filepath);
    await client.sendMessage(targetGroupId, media, { caption: caption || '' });
    return true;
  } catch (err) {
    console.error('Erro ao enviar arquivo:', err);
    return false;
  }
}

// Envia alerta de erro
async function sendError(message, step) {
  return sendToGroup('⚠️ *Erro na automação*\n\nEtapa: ' + (step || '?') + '\n' + message);
}

// Envia documentos finais (carteirinha + extrato)
async function sendDocuments() {
  const cart = path.join(DOWNLOAD_DIR, 'Carteirinha.pdf');
  const ext = path.join(DOWNLOAD_DIR, 'Extrato.pdf');
  let ok = true;
  if (fs.existsSync(cart)) {
    await sendFileToGroup(cart, '✅ Carteirinha RNTRC');
  } else ok = false;
  if (fs.existsSync(ext)) {
    await sendFileToGroup(ext, '✅ Extrato RNTRC');
  } else ok = false;
  if (!ok) await sendToGroup('⚠️ Alguns documentos não foram encontrados.');
  return ok;
}

// Inicia o bot
function startBot() {
  console.log('\n  Omega WhatsApp Bot');
  console.log('  Grupo alvo: ' + GROUP_NAME);
  console.log('  Iniciando...\n');
  client.initialize();
}

module.exports = { startBot, sendToGroup, sendFileToGroup, sendError, sendDocuments };
