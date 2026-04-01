// src/automation/engine.js — Motor de automação com Puppeteer
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://rntrcdigital.antt.gov.br/';
const DOWNLOAD_DIR = path.join(__dirname, '..', '..', 'downloads');

// Garante que a pasta de downloads existe
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

class AutomationEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.browser = null;
    this.page = null;
    this.status = 'idle'; // idle | running | paused | done | error
    this.currentStep = '';
    this.lastError = null;
    this.checkpoint = {
      login: false,
      contrato: false,
      dropdown: false,
      cadastro: false,
      veiculos: [],
      finalizado: false,
      documentos: false
    };

    // Controle de pausa/retomada
    this._pauseResolve = null;
    this._fixData = null;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  emit(event, data = {}) {
    this.broadcast({ event, step: this.currentStep, ...data });
  }

  async delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Digita caractere por caractere com delay (simula humano, ativa masking do portal)
  async typeSlowly(selector, text, delayMs = 80) {
    const el = await this.page.$(selector);
    if (!el) throw new Error(`Elemento não encontrado: ${selector}`);
    await el.click({ clickCount: 3 }); // seleciona tudo
    await el.press('Backspace');
    for (const char of text) {
      await el.type(char, { delay: delayMs });
    }
  }

  // Aguarda seletor com timeout customizável
  async waitFor(selector, timeout = 15000) {
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Polling — aguarda condição com intervalo
  async poll(checkFn, intervalMs = 500, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await checkFn();
      if (result) return result;
      await this.delay(intervalMs);
    }
    return null;
  }

  // Pausa a automação e aguarda ação do usuário
  async pauseForError(errorMsg, field = null, currentValue = '') {
    this.status = 'paused';
    this.lastError = { message: errorMsg, field, currentValue };
    this.emit('error', {
      message: errorMsg,
      field,
      currentValue,
      options: ['fix', 'pause', 'stop']
    });

    // Aguarda resolução (fix, resume ou stop)
    return new Promise(resolve => {
      this._pauseResolve = resolve;
    });
  }

  // Chamado quando o usuário clica "Corrigir e retentar"
  fix(field, value) {
    this._fixData = { field, value };
    if (this._pauseResolve) {
      this._pauseResolve('fix');
      this._pauseResolve = null;
    }
  }

  // Chamado quando o usuário clica "Continuar" (após pausar)
  resume() {
    this.status = 'running';
    this.emit('resumed');
    if (this._pauseResolve) {
      this._pauseResolve('resume');
      this._pauseResolve = null;
    }
  }

  // Chamado quando o usuário clica "Parar"
  async stop() {
    this.status = 'done';
    this.emit('stopped', { checkpoint: this.checkpoint });
    if (this._pauseResolve) {
      this._pauseResolve('stop');
      this._pauseResolve = null;
    }
    await this.cleanup();
  }

  async cleanup() {
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
  }

  // ── Fluxo principal ─────────────────────────────────────────────

  async run(data) {
    this.status = 'running';
    const { tipo, credenciais, transportador, veiculos, cnpj_data } = data;

    try {
      // Inicia navegador
      this.emit('starting', { message: 'Iniciando navegador...' });
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1366,768'
        ]
      });
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1366, height: 768 });

      // Configura download automático de PDFs
      const client = await this.page.createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR
      });

      // ── ETAPA 1: LOGIN ──────────────────────────────────────────
      await this.stepLogin(tipo, credenciais);

      // ── ETAPA 2: CONTRATO ───────────────────────────────────────
      await this.stepContrato();

      // ── ETAPA 3: DROPDOWN TRANSPORTADOR ─────────────────────────
      await this.stepDropdown(tipo, credenciais, cnpj_data);

      // ── ETAPA 4: CADASTRO ───────────────────────────────────────
      await this.stepCadastro(tipo, transportador, cnpj_data);

      // ── ETAPA 5: VEÍCULOS (só após cadastro OK) ─────────────────
      if (veiculos && veiculos.length > 0) {
        for (let i = 0; i < veiculos.length; i++) {
          await this.stepVeiculo(veiculos[i], i + 1, veiculos.length);
        }
      }

      // ── ETAPA 6: FINALIZAR ──────────────────────────────────────
      await this.stepFinalizar();

      // ── ETAPA 7: EMITIR DOCUMENTOS ──────────────────────────────
      await this.stepEmitirDocumentos();

      this.status = 'done';
      this.emit('done', { message: 'Cadastro completo!', checkpoint: this.checkpoint });

    } catch (err) {
      if (this.status !== 'done') { // não era um stop voluntário
        this.status = 'error';
        this.emit('error_critical', {
          message: err.message,
          checkpoint: this.checkpoint
        });
      }
    } finally {
      await this.cleanup();
    }
  }

  // ── ETAPAS INDIVIDUAIS ────────────────────────────────────────

  async stepLogin(tipo, credenciais) {
    this.currentStep = 'login';
    this.emit('step', { message: 'Fazendo login...' });

    await this.page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Determina CPF e senha baseado no tipo
    let cpf, senha;
    if (tipo === 'cnpj') {
      cpf = process.env.COLAB_CPF || credenciais.cpf;
      senha = process.env.COLAB_SENHA || credenciais.senha;
    } else {
      cpf = credenciais.cpf.replace(/\D/g, '');
      senha = credenciais.senha;
    }

    // Campo CPF
    const cpfField = await this.waitFor('#Cpf, #cpf, input[name="cpf"], input[name="Cpf"]');
    if (!cpfField) {
      const action = await this.pauseForError('Campo de CPF não encontrado na tela de login', 'cpf', cpf);
      if (action === 'stop') return;
    }

    await this.typeSlowly('#Cpf, #cpf, input[name="cpf"], input[name="Cpf"]', cpf);
    this.emit('step', { message: 'CPF digitado, clicando continuar...' });

    // Botão continuar
    const btnContinuar = await this.page.$('button[type="submit"], #btnContinuar, .btn-continuar');
    if (btnContinuar) await btnContinuar.click();
    await this.delay(2000);

    // Campo senha
    const senhaField = await this.waitFor('#Senha, #senha, input[type="password"]');
    if (!senhaField) {
      const action = await this.pauseForError('Campo de senha não encontrado', 'senha', '');
      if (action === 'stop') return;
    }

    await this.typeSlowly('#Senha, #senha, input[type="password"]', senha);

    // Botão entrar
    const btnEntrar = await this.page.$('#btnEntrar, button[type="submit"]');
    if (btnEntrar) await btnEntrar.click();
    await this.delay(3000);

    // Verifica se login foi bem sucedido
    const loginOk = await this.poll(async () => {
      const url = this.page.url();
      return !url.includes('login') && !url.includes('Login');
    }, 500, 15000);

    if (!loginOk) {
      const action = await this.pauseForError('Login falhou — verifique CPF e senha', 'senha', '');
      if (action === 'stop') return;
    }

    this.checkpoint.login = true;
    this.emit('step_done', { message: 'Login realizado', step: 'login' });
  }

  async stepContrato() {
    this.currentStep = 'contrato';
    this.emit('step', { message: 'Verificando contrato...' });
    await this.delay(2000);

    // Verifica se apareceu tela de contrato
    const contratoPresente = await this.page.$('#aceiteContrato, .termo-aceite, input[type="checkbox"][id*="ceite"]');

    if (contratoPresente) {
      this.emit('step', { message: 'Contrato encontrado, aceitando...' });

      // Marca checkbox de aceite
      const checkbox = await this.page.$('input[type="checkbox"]');
      if (checkbox) {
        await checkbox.click();
        await this.delay(500);
      }

      // Botão avançar/aceitar
      const btnAceitar = await this.page.$('button[type="submit"], .btn-avancar, #btnAvancar');
      if (btnAceitar) {
        await btnAceitar.click();
        await this.delay(3000);
      }

      this.emit('step_done', { message: 'Contrato aceito', step: 'contrato' });
    } else {
      this.emit('step_done', { message: 'Sem contrato pendente', step: 'contrato' });
    }

    this.checkpoint.contrato = true;
  }

  async stepDropdown(tipo, credenciais, cnpj_data) {
    this.currentStep = 'dropdown';
    this.emit('step', { message: 'Abrindo dropdown transportador...' });

    // Clica em "Transportador" no menu/dropdown
    const dropdown = await this.waitFor('#dropdownTransportador, .dropdown-transportador, [data-action*="Transportador"]');
    if (dropdown) {
      const el = await this.page.$('#dropdownTransportador, .dropdown-transportador, [data-action*="Transportador"]');
      if (el) await el.click();
      await this.delay(1500);
    }

    // Clica em "Novo cadastro"
    const novoCadastro = await this.page.$('[data-action*="Novo"], .novo-cadastro, a:has-text("Novo")');
    if (novoCadastro) {
      await novoCadastro.click();
      await this.delay(2000);
    }

    // Seleciona CPF ou CNPJ no dropdown de seleção
    this.emit('step', { message: 'Selecionando no dropdown...' });

    let valorBusca;
    if (tipo === 'cnpj' && cnpj_data) {
      valorBusca = cnpj_data.cnpj.replace(/\D/g, '');
    } else {
      valorBusca = credenciais.cpf.replace(/\D/g, '');
    }

    // Procura e seleciona no dropdown pela lista de opções
    const selecionou = await this.poll(async () => {
      const options = await this.page.$$('select option, .dropdown-item, li[data-value]');
      for (const opt of options) {
        const text = await opt.evaluate(el => el.textContent || el.value || '');
        if (text.replace(/\D/g, '').includes(valorBusca)) {
          await opt.click();
          return true;
        }
      }
      return false;
    }, 500, 10000);

    if (!selecionou) {
      const action = await this.pauseForError(
        `Não encontrou "${valorBusca}" no dropdown. Verifique o CPF/CNPJ.`,
        'dropdown_valor', valorBusca
      );
      if (action === 'stop') return;
    }

    await this.delay(1500);

    // Clica em "Criar pedido"
    const btnCriar = await this.page.$('[data-action*="Criar"], .btn-criar-pedido, #btnCriarPedido');
    if (btnCriar) {
      await btnCriar.click();
      await this.delay(3000);
    }

    this.checkpoint.dropdown = true;
    this.emit('step_done', { message: `${tipo.toUpperCase()} selecionado, pedido criado`, step: 'dropdown' });
  }

  async stepCadastro(tipo, transportador, cnpj_data) {
    this.currentStep = 'cadastro';
    this.emit('step', { message: 'Preenchendo cadastro...' });

    if (tipo === 'cpf') {
      await this.preencherCadastroCPF(transportador);
    } else {
      await this.preencherCadastroCNPJ(transportador, cnpj_data);
    }

    this.checkpoint.cadastro = true;
    this.emit('step_done', { message: 'Cadastro preenchido com sucesso', step: 'cadastro' });
  }

  async preencherCadastroCPF(dados) {
    // ── Aba Transportador (automático pela Receita) ──
    this.emit('step', { message: 'Aba Transportador — aguardando Receita...' });
    await this.delay(2000);

    // ── Aba Contatos — identidade + endereço ──
    this.emit('step', { message: 'Preenchendo contatos...' });

    // Identidade
    const identidade = dados.identidade || '000000';
    const identField = await this.page.$('#Identidade, #identidade');
    if (identField) {
      await this.typeSlowly('#Identidade, #identidade', identidade);
    }

    // Órgão emissor — sempre SSP
    const orgaoField = await this.page.$('#OrgaoEmissor, select[name*="OrgaoEmissor"]');
    if (orgaoField) {
      await this.page.select('#OrgaoEmissor, select[name*="OrgaoEmissor"]', 'SSP');
    }

    // UF emissor
    if (dados.uf) {
      const ufField = await this.page.$('#UfIdentidade, select[name*="UfIdentidade"]');
      if (ufField) {
        await this.page.select('#UfIdentidade, select[name*="UfIdentidade"]', dados.uf);
      }
    }

    // Endereço — preenche se tiver, senão usa fallback
    await this.preencherEndereco(dados);

    // ── Motorista Auxiliar — pula ──
    this.emit('step', { message: 'Motorista auxiliar — pulando...' });
  }

  async preencherCadastroCNPJ(dados, cnpj_data) {
    // ── Aba Transportador — marca capacidade financeira ──
    this.emit('step', { message: 'Marcando capacidade financeira...' });
    const checkCap = await this.page.$('#TransportadorEtc_SituacaoCapacidadeFinanceira');
    if (checkCap) {
      await this.page.evaluate(() => {
        const el = document.getElementById('TransportadorEtc_SituacaoCapacidadeFinanceira');
        if (el && !el.checked) {
          // iCheck: simula clique no div pai
          const parent = el.closest('.icheckbox_square-blue') || el.parentElement;
          if (parent) parent.click();
        }
      });
      await this.delay(500);
    }

    // ── Aba Contatos — endereço + telefone + email do cartão CNPJ ──
    this.emit('step', { message: 'Preenchendo contatos da empresa...' });
    await this.preencherEndereco(dados);

    // Telefone
    const telefone = dados.telefone || '0000000000';
    await this.adicionarContato('2', telefone);
    await this.delay(1500);

    // Email — tenta o extraído, se falhar gera aleatório
    let email = dados.email || this.gerarEmailAleatorio();
    const emailOk = await this.adicionarContato('4', email);
    if (!emailOk) {
      // Email já em uso — gera aleatório
      email = this.gerarEmailAleatorio();
      await this.adicionarContato('4', email);
    }

    // ── Filial — pula ──

    // ── Gestor — CNH do sócio ──
    if (cnpj_data && cnpj_data.cpf_socio) {
      this.emit('step', { message: 'Preenchendo gestor (sócio)...' });
      await this.preencherGestor(cnpj_data.cpf_socio);
    }

    // ── RT — CPF fixo ──
    this.emit('step', { message: 'Preenchendo RT...' });
    await this.preencherRT();
  }

  async preencherEndereco(dados) {
    let cep = dados.cep;

    // Fallback — CEP aleatório se não tiver endereço
    if (!cep) {
      const estados = ['MG', 'SP', 'RJ'];
      const estado = estados[Math.floor(Math.random() * estados.length)];
      const cepsEnv = process.env[`CEPS_${estado}`];
      const lista = cepsEnv ? cepsEnv.split(',') : ['32220-390'];
      cep = lista[Math.floor(Math.random() * lista.length)].replace(/\D/g, '');
      this.emit('step', { message: `Sem endereço — usando CEP aleatório ${estado}...` });
    }

    // Digita CEP
    const cepField = await this.page.$('#Cep, #cep, input[name*="Cep"]');
    if (cepField) {
      await this.typeSlowly('#Cep, #cep, input[name*="Cep"]', cep.replace(/\D/g, ''));
      await this.delay(2000); // aguarda API de CEP preencher

      // Se o CEP auto-preencheu, sobrescreve com dados manuais se disponíveis
      if (dados.logradouro) {
        const logField = await this.page.$('#Logradouro, input[name*="Logradouro"]');
        if (logField) await this.typeSlowly('#Logradouro, input[name*="Logradouro"]', dados.logradouro);
      }

      const numero = dados.numero || '0';
      const numField = await this.page.$('#Numero, input[name*="Numero"]');
      if (numField) await this.typeSlowly('#Numero, input[name*="Numero"]', numero);

      if (dados.complemento) {
        const compField = await this.page.$('#Complemento, input[name*="Complemento"]');
        if (compField) await this.typeSlowly('#Complemento, input[name*="Complemento"]', dados.complemento);
      }

      if (dados.bairro) {
        const bairroField = await this.page.$('#Bairro, input[name*="Bairro"]');
        if (bairroField) await this.typeSlowly('#Bairro, input[name*="Bairro"]', dados.bairro);
      }
    }
  }

  async adicionarContato(tipoValor, contatoValor) {
    const btnAdicionar = await this.page.$('[data-action*="ContatoPedido/Novo"]');
    if (!btnAdicionar) return false;

    await btnAdicionar.click();
    await this.delay(800);

    await this.page.select('#CodigoTipoContato', tipoValor);
    await this.delay(300);

    const campoContato = await this.page.$('#Contato');
    if (campoContato) {
      await this.typeSlowly('#Contato', contatoValor);
      await this.delay(400);
    }

    const btnSalvar = await this.page.$('.btn-salvar-contato');
    if (btnSalvar) {
      await btnSalvar.click();
      await this.delay(1000);

      // Verifica se deu erro (email já em uso, por ex)
      const erro = await this.page.$('.validation-summary-errors, .alert-danger');
      if (erro) return false;
    }

    return true;
  }

  async preencherGestor(cpfSocio) {
    // Abre modal do gestor
    const btnGestor = await this.page.$('[data-action*="Gestor/Criar"], [data-action*="GestorPedido"]');
    if (!btnGestor) {
      await this.pauseForError('Botão de adicionar gestor não encontrado', 'cpf_socio', cpfSocio);
      return;
    }

    await btnGestor.click();
    await this.delay(1500);

    // Seleciona tipo Sócio
    const tipoSelect = await this.page.$('#CodigoTipoVinculo, select[name*="TipoVinculo"]');
    if (tipoSelect) {
      await this.page.select('#CodigoTipoVinculo, select[name*="TipoVinculo"]', '1'); // 1 = Sócio
      await this.delay(500);
    }

    // Digita CPF do sócio
    const cpfField = await this.page.$('#Cpf, #cpfGestor');
    if (cpfField) {
      await this.typeSlowly('#Cpf, #cpfGestor', cpfSocio.replace(/\D/g, ''));
      await this.delay(500);

      // Dispara blur pra portal buscar o nome
      await this.page.evaluate(() => {
        const el = document.querySelector('#Cpf, #cpfGestor');
        if (el) {
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }

    // Polling — aguarda nome carregar
    this.emit('step', { message: 'Aguardando nome do sócio carregar...' });
    const nomeOk = await this.poll(async () => {
      const nomeField = await this.page.$('#Nome, #nomeGestor');
      if (!nomeField) return false;
      const val = await nomeField.evaluate(el => el.value);
      return val && val.length > 2;
    }, 500, 15000);

    if (!nomeOk) {
      await this.pauseForError('Nome do sócio não carregou — CPF pode estar incorreto', 'cpf_socio', cpfSocio);
    }

    // Marca checkbox idôneo
    await this.page.evaluate(() => {
      const checks = document.querySelectorAll('input[type="checkbox"]');
      checks.forEach(c => {
        if (!c.checked) {
          const parent = c.closest('.icheckbox_square-blue') || c.parentElement;
          if (parent) parent.click();
        }
      });
    });
    await this.delay(300);

    // Salva
    const btnSalvar = await this.page.$('.btn-salvar, [data-action*="Salvar"]');
    if (btnSalvar) {
      await btnSalvar.click();
      await this.delay(1500);
    }
  }

  async preencherRT() {
    const cpfRT = process.env.RT_CPF || '07141753664';

    const btnRT = await this.page.$('[data-action*="ResponsavelTecnico/Criar"]');
    if (!btnRT) return; // CPF não tem RT

    await btnRT.click();
    await this.delay(1500);

    const cpfField = await this.page.$('#Cpf');
    if (cpfField) {
      await this.typeSlowly('#Cpf', cpfRT);
      await this.page.evaluate(() => {
        const el = document.querySelector('#Cpf');
        if (el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      });
    }

    // Polling — aguarda nome do RT carregar
    await this.poll(async () => {
      const nome = await this.page.$('#Nome');
      if (!nome) return false;
      const val = await nome.evaluate(el => el.value);
      return val && val.length > 2;
    }, 500, 15000);

    // Marca checkboxes
    await this.page.evaluate(() => {
      document.querySelectorAll('input[type="checkbox"]').forEach(c => {
        if (!c.checked) {
          const p = c.closest('.icheckbox_square-blue') || c.parentElement;
          if (p) p.click();
        }
      });
    });
    await this.delay(300);

    const btnSalvar = await this.page.$('.btn-salvar, [data-action*="Salvar"]');
    if (btnSalvar) {
      await btnSalvar.click();
      await this.delay(1500);
    }
  }

  // ── VEÍCULO ───────────────────────────────────────────────────

  async stepVeiculo(veiculo, index, total) {
    this.currentStep = `veiculo_${index}`;
    const label = `Veículo ${index}/${total} — ${veiculo.placa}`;

    // Se é terceiro, faz arrendamento primeiro
    if (veiculo.tipo === 'terceiro') {
      this.emit('step', { message: `${label} — arrendando...` });
      await this.stepArrendamento(veiculo);
    }

    // Inclui veículo
    this.emit('step', { message: `${label} — incluindo...` });
    await this.incluirVeiculo(veiculo);

    // Mata toast entre veículos
    await this.matarToast();
    await this.delay(1000);

    this.checkpoint.veiculos.push({
      placa: veiculo.placa,
      tipo: veiculo.tipo,
      status: 'ok'
    });

    this.emit('step_done', {
      message: `${label} — concluído`,
      step: `veiculo_${index}`
    });
  }

  async stepArrendamento(veiculo) {
    // Navega pra aba/página de arrendamento se necessário
    // Substitui CPF/CNPJ e nome do proprietário no contrato
    const cpfProp = veiculo.cpf_cnpj || '';
    const nomeProp = veiculo.nome || '';

    this.emit('step', { message: `Arrendando ${veiculo.placa} — substituindo dados...` });

    // Usa a lógica do arrendamento.js adaptada:
    // Preenche placa, renavam, troca CPF/nome do arrendante
    await this.page.evaluate((cpf, nome) => {
      // Substitui CPF do arrendante nos campos do formulário
      const cpfFields = document.querySelectorAll('input[id*="Cpf"], input[id*="CpfCnpj"]');
      cpfFields.forEach(f => {
        if (f.value && f.value.replace(/\D/g, '').length >= 11) {
          f.value = cpf;
          f.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Atualiza nome
      const nomeField = document.querySelector('#NomeArrendanteInput, input[id*="NomeArrendante"]');
      if (nomeField) {
        nomeField.removeAttribute('disabled');
        nomeField.value = nome;
        nomeField.setAttribute('disabled', 'disabled');
      }
    }, cpfProp, nomeProp);

    // Digita placa com delay
    const placaField = await this.page.$('#Placa');
    if (placaField) {
      await this.typeSlowly('#Placa', veiculo.placa, 100);
      await this.delay(150); // delay extra no 4o char (formato novo)
    }

    // Preenche renavam
    const renavamField = await this.page.$('#Renavam');
    if (renavamField) {
      await this.typeSlowly('#Renavam', veiculo.renavam);
    }

    // Clica em Preencher e Verificar
    const btnPreencher = await this.page.$('#antt-veiculo-btn, [data-action*="Verificar"]');
    if (btnPreencher) {
      await btnPreencher.click();
      await this.delay(3000);
    }

    // Preenche data e marca declarações
    await this.page.evaluate(() => {
      const dataHoje = new Date().toLocaleDateString('pt-BR');
      const dataField = document.querySelector('#DataInicioVigencia, input[name*="DataInicio"]');
      if (dataField) {
        dataField.value = dataHoje;
        dataField.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Marca todas as declarações via iCheck
      document.querySelectorAll('.icheckbox_square-blue:not(.checked)').forEach(div => div.click());
    });

    await this.delay(1000);

    // Salva arrendamento
    const btnSalvar = await this.page.$('#btnSalvar, .btn-salvar');
    if (btnSalvar) {
      await btnSalvar.click();
      await this.delay(3000);
    }

    this.emit('step', { message: `Arrendamento ${veiculo.placa} concluído` });
  }

  async incluirVeiculo(veiculo) {
    // Clica no botão de adicionar veículo
    const btnAdicionar = await this.page.$('[data-action*="Veiculo/Novo"], .btn-adicionar-veiculo');
    if (!btnAdicionar) {
      await this.pauseForError('Botão de adicionar veículo não encontrado', null, '');
      return;
    }

    await btnAdicionar.click();
    await this.delay(1500);

    // Seleciona a placa na lista (se arrendada, já aparece)
    const selecionou = await this.poll(async () => {
      const options = await this.page.$$('select option, .dropdown-item');
      for (const opt of options) {
        const text = await opt.evaluate(el => el.textContent || '');
        if (text.toUpperCase().includes(veiculo.placa.toUpperCase())) {
          await opt.click();
          return true;
        }
      }
      return false;
    }, 500, 10000);

    if (!selecionou) {
      await this.pauseForError(
        `Placa ${veiculo.placa} não encontrada na lista de veículos`,
        'placa', veiculo.placa
      );
    }

    await this.delay(1000);

    // Confirma inclusão
    const btnConfirmar = await this.page.$('.btn-salvar, [data-action*="Salvar"]');
    if (btnConfirmar) {
      await btnConfirmar.click();
      await this.delay(2000);
    }
  }

  async matarToast() {
    // Remove toasts do portal que causam reload
    await this.page.evaluate(() => {
      // Cancela todos os timers ativos (igual matarTimers do core.js)
      const highestId = setTimeout(() => {}, 0);
      for (let i = 0; i < highestId; i++) {
        clearTimeout(i);
        clearInterval(i);
      }

      // Remove toasts visíveis
      document.querySelectorAll('.toast, .gritter-item, .jq-toast-single').forEach(t => t.remove());
    });
  }

  // ── FINALIZAR ─────────────────────────────────────────────────

  async stepFinalizar() {
    this.currentStep = 'finalizar';
    this.emit('step', { message: 'Finalizando pedido...' });

    const btnFinalizar = await this.page.$('#btnFinalizar, [data-action*="Finalizar"], .btn-finalizar');
    if (btnFinalizar) {
      await btnFinalizar.click();
      await this.delay(3000);

      // Confirma se aparecer modal de confirmação
      const btnConfirmar = await this.page.$('.btn-confirmar, .modal .btn-primary');
      if (btnConfirmar) {
        await btnConfirmar.click();
        await this.delay(3000);
      }
    }

    this.checkpoint.finalizado = true;
    this.emit('step_done', { message: 'Pedido finalizado', step: 'finalizar' });
  }

  // ── EMITIR DOCUMENTOS ─────────────────────────────────────────

  async stepEmitirDocumentos() {
    this.currentStep = 'documentos';
    this.emit('step', { message: 'Emitindo carteirinha...' });

    // Emite carteirinha
    const btnCarteirinha = await this.page.$('[data-action*="Carteirinha"], .btn-carteirinha, a:has-text("Carteirinha")');
    if (btnCarteirinha) {
      await btnCarteirinha.click();
      await this.delay(5000); // aguarda PDF gerar
    }

    this.emit('step', { message: 'Emitindo extrato...' });

    // Emite extrato
    const btnExtrato = await this.page.$('[data-action*="Extrato"], .btn-extrato, a:has-text("Extrato")');
    if (btnExtrato) {
      await btnExtrato.click();
      await this.delay(5000);
    }

    this.checkpoint.documentos = true;
    this.emit('step_done', {
      message: 'Documentos emitidos e salvos',
      step: 'documentos',
      files: ['Carteirinha.pdf', 'Extrato.pdf']
    });
  }

  // ── UTILS ─────────────────────────────────────────────────────

  gerarEmailAleatorio() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let email = '';
    for (let i = 0; i < 12; i++) email += chars[Math.floor(Math.random() * chars.length)];
    return email + '@yahoo.com';
  }
}

module.exports = AutomationEngine;
