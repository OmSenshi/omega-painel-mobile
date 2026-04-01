// src/routes/extraction.js — Extração de documentos via Claude API
const express = require('express');
const router = express.Router();

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.CLAUDE_API_KEY;

// Prompts especializados por tipo de documento
const PROMPTS = {
  crlv: `Extraia do CRLV exatamente estes 4 campos e retorne SOMENTE neste formato sem mais nada:
placa=VALOR|renavam=VALOR|cpf_cnpj=VALOR|nome=VALOR

Regras:
- placa: apenas letras e numeros sem traco (ex: ABC1D23)
- renavam: apenas numeros (ex: 00372703917)
- cpf_cnpj: apenas numeros sem pontos ou traco (11 digitos CPF, 14 digitos CNPJ)
- nome: nome completo em maiusculas
- Se nao encontrar algum campo, coloque vazio (ex: cpf_cnpj=)`,

  cnh: `Extraia da CNH/RG exatamente estes 2 campos e retorne SOMENTE neste formato sem mais nada:
identidade=VALOR|uf=VALOR

Regras:
- identidade: numero do RG ou registro da CNH, apenas numeros e letras sem pontos ou tracos
- uf: sigla do estado emissor em maiusculas (ex: RJ, SP, MG)
- Se nao encontrar a identidade, use 000000
- Se nao encontrar a UF, deixe vazio`,

  cnh_socio: `Extraia da CNH do socio exatamente este campo e retorne SOMENTE neste formato sem mais nada:
cpf_socio=VALOR

Regras:
- cpf_socio: numero do CPF apenas numeros sem pontos ou traco (11 digitos)
- Se nao encontrar, deixe vazio`,

  comprovante: `Extraia do comprovante de endereco exatamente estes 5 campos e retorne SOMENTE neste formato sem mais nada:
cep=VALOR|logradouro=VALOR|numero=VALOR|complemento=VALOR|bairro=VALOR

Regras:
- cep: apenas 8 numeros sem traco (ex: 32220390)
- logradouro: nome da rua/avenida em maiusculas SEM o numero (ex: RUA DAS FLORES)
- numero: numero do endereco. Se nao encontrar, use 0
- complemento: apto, bloco, sala. Se nao houver, deixe vazio
- bairro: nome do bairro em maiusculas. Se nao encontrar, use 0`,

  cartao_cnpj: `Extraia do cartao CNPJ/Certificado MEI exatamente estes 7 campos e retorne SOMENTE neste formato sem mais nada:
cep=VALOR|logradouro=VALOR|numero=VALOR|complemento=VALOR|bairro=VALOR|telefone=VALOR|email=VALOR

Regras:
- cep: apenas 8 numeros sem traco
- logradouro: nome da rua/avenida em maiusculas SEM o numero
- numero: numero do endereco. Se nao encontrar, use 0
- complemento: sala, andar. Se nao houver, deixe vazio
- bairro: nome do bairro em maiusculas. Se nao encontrar, use 0
- telefone: apenas numeros com DDD (ex: 31999998888). Se nao encontrar, deixe vazio
- email: endereco de email. Se nao encontrar, deixe vazio`
};

// POST /api/extract — recebe documento e retorna dados extraídos
router.post('/', async (req, res) => {
  try {
    const { type } = req.body; // crlv, cnh, cnh_socio, comprovante, cartao_cnpj
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'Nenhum documento enviado' });
    if (!PROMPTS[type]) return res.status(400).json({ error: 'Tipo inválido: ' + type });
    if (!API_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY não configurada' });

    const base64 = file.buffer.toString('base64');
    const mediaType = file.mimetype;
    const isDoc = mediaType === 'application/pdf';

    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          { type: 'text', text: PROMPTS[type] }
        ]
      }]
    };

    const response = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: 'API Claude: ' + data.error.message });
    }

    // Parseia resposta no formato campo=valor|campo=valor
    const texto = data.content?.[0]?.text?.trim() || '';
    const resultado = {};
    texto.split('|').forEach(par => {
      const [chave, ...valorParts] = par.split('=');
      if (chave) resultado[chave.trim()] = valorParts.join('=').trim();
    });

    // Contabiliza tokens usados
    const tokensIn = data.usage?.input_tokens || 0;
    const tokensOut = data.usage?.output_tokens || 0;

    res.json({
      success: true,
      type,
      data: resultado,
      raw: texto,
      usage: { input: tokensIn, output: tokensOut }
    });

  } catch (err) {
    console.error('Erro na extração:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

module.exports = router;
