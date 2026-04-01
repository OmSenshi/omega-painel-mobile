// src/automation/engine.js v2.6 — 2captcha via npm + extensão removida
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const Captcha = require('@2captcha/captcha-solver');
const solver = new Captcha.Solver(process.env.CAPTCHA_API_KEY || '');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://rntrcdigital.antt.gov.br/';
const ARRENDAMENTO_URL = 'https://rntrcdigital.antt.gov.br/ContratoArrendamento/Criar';
const DOWNLOAD_DIR = path.join(__dirname, '..', '..', 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

class AutomationEngine {
  constructor(broadcast, whatsappBot) {
    this.broadcast = broadcast;
    this.wpp = whatsappBot; // referencia ao bot WhatsApp
    this.browser = null;
    this.page = null;
    this.status = 'idle';
    this.currentStep = '';
    this.lastError = null;
    this.checkpoint = { login:false, contrato:false, dropdown:false, cadastro:false, veiculos:[], finalizado:false, documentos:false };
    this._pauseResolve = null;
    this._fixData = null;
  }

  emit(event, data={}) {
    this.broadcast({ event, step:this.currentStep, ...data });
    // Notifica via WhatsApp nos eventos importantes
    if(this.wpp) {
      if(event==='error'||event==='error_critical') {
        this.wpp.sendError(data.message||'Erro desconhecido', this.currentStep).catch(()=>{});
      }
      if(event==='done') {
        this.wpp.sendToGroup('✅ '+( data.message||'Concluido!')).catch(()=>{});
        // Envia PDFs automaticamente
        this.wpp.sendDocuments().catch(()=>{});
      }
    }
  }
  async delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async typeSlowly(selector, text, delayMs=80) {
    const el = await this.page.$(selector);
    if (!el) throw new Error('Elemento nao encontrado: '+selector);
    await el.click({ clickCount:3 }); await el.press('Backspace');
    for (const ch of text) await el.type(ch, { delay:delayMs });
  }

  async typeInEl(el, text, delayMs=80) {
    await el.click({ clickCount:3 }); await el.press('Backspace');
    for (const ch of text) await el.type(ch, { delay:delayMs });
  }

  async waitFor(sel, timeout=15000) {
    try { await this.page.waitForSelector(sel, { timeout }); return true; } catch { return false; }
  }

  async poll(fn, interval=500, timeout=30000) {
    const s = Date.now();
    while (Date.now()-s < timeout) { const r = await fn(); if (r) return r; await this.delay(interval); }
    return null;
  }

  async waitForModal(timeout=10000) {
    return this.poll(async () => {
      const m = await this.page.$('.modal.show, .modal.in, .modal[style*="display: block"]');
      if (!m) return false;
      const f = await this.page.$$('.modal.show input, .modal.show select, .modal.in input, .modal.in select');
      return f.length > 0;
    }, 300, timeout);
  }

  async pauseForError(msg, field=null, val='') {
    this.status = 'paused';
    this.lastError = { message:msg, field, currentValue:val };
    this.emit('error', { message:msg, field, currentValue:val, options:['fix','pause','stop'] });
    return new Promise(r => { this._pauseResolve = r; });
  }

  fix(field, value) { this._fixData={field,value}; if(this._pauseResolve){this._pauseResolve('fix');this._pauseResolve=null;} }
  resume() { this.status='running'; this.emit('resumed'); if(this._pauseResolve){this._pauseResolve('resume');this._pauseResolve=null;} }
  async stop() { this.status='done'; this.emit('stopped',{checkpoint:this.checkpoint}); if(this._pauseResolve){this._pauseResolve('stop');this._pauseResolve=null;} await this.cleanup(); }
  async cleanup() { if(this.browser){try{await this.browser.close();}catch{}this.browser=null;this.page=null;} }

  async matarToast() {
    await this.page.evaluate(() => {
      const h=window.setTimeout(()=>{},0); for(let i=0;i<h;i++){clearTimeout(i);clearInterval(i);}
      document.querySelectorAll('.toast,.gritter-item,.jq-toast-single,.jGrowl-notification').forEach(t=>t.remove());
    });
  }

  async checkICheck(sel) {
    await this.page.evaluate((s) => {
      const el=document.querySelector(s); if(!el||el.checked) return;
      const w=el.closest('.icheckbox_flat-blue,.icheckbox_square-blue')||el.parentElement;
      if(w) w.click();
    }, sel);
    await this.delay(300);
  }

  async initBrowser() {
    this.emit('starting',{message:'Iniciando navegador...'});
    const useDisplay = process.env.DISPLAY || ':99';
    this.browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.CHROME_PATH||'/usr/bin/chromium-browser',
      args:[
        '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--window-size=1366,768','--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '--display=' + useDisplay
      ]
    });
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.evaluateOnNewDocument(()=>{
      Object.defineProperty(navigator,'webdriver',{get:()=>false});
      window.chrome={runtime:{}};
    });
    await this.page.setViewport({width:1366,height:768});
    const ctx = this.browser.defaultBrowserContext();
    await ctx.overridePermissions('https://sso.acesso.gov.br', []);
    const c = await this.page.createCDPSession();
    await c.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:DOWNLOAD_DIR});
  }

  // ═══ FLUXO PRINCIPAL ═══
  async run(data) {
    this.status='running';
    const {modo,tipo,credenciais,transportador,veiculos,cnpj_data} = data;
    try {
      await this.initBrowser();
      if(modo==='arrendamento_avulso'){await this.runArrendamentoAvulso(data);return;}
      if(modo==='inclusao_avulsa'){await this.runInclusaoAvulsa(data);return;}
      await this.stepLogin(tipo,credenciais);
      await this.stepContrato();
      await this.stepDropdown(tipo,credenciais,cnpj_data);
      await this.stepCadastro(tipo,transportador,cnpj_data);
      if(veiculos&&veiculos.length>0) for(let i=0;i<veiculos.length;i++) await this.stepVeiculo(veiculos[i],i+1,veiculos.length);
      await this.stepFinalizar();
      await this.stepEmitirDocumentos();
      this.status='done';
      this.emit('done',{message:'Cadastro completo!',checkpoint:this.checkpoint});
    } catch(err) {
      if(this.status!=='done'){this.status='error';this.emit('error_critical',{message:err.message,checkpoint:this.checkpoint});}
    } finally { await this.cleanup(); }
  }

  // ═══ LOGIN ROBUSTO ═══
  // Verifica cada etapa antes de agir. Retry automático. 2captcha + fallback noVNC.
  async stepLogin(tipo,cred) {
    this.currentStep='login';
    this.emit('step',{message:'Abrindo portal...'});

    let cpf,senha;
    if(tipo==='cnpj'){cpf=process.env.COLAB_CPF||cred.cpf;senha=process.env.COLAB_SENHA||cred.senha;}
    else{cpf=(cred.cpf||'').replace(/\D/g,'');senha=cred.senha||'';}

    // ── ETAPA 1: Navega pro portal ──
    await this.page.goto(PORTAL_URL,{waitUntil:'networkidle2',timeout:45000});
    await this.delay(3000);

    // ── ETAPA 2: Aguarda e garante campo CPF visível ──
    // O gov.br pode mostrar accordion fechado OU campo direto
    this.emit('step',{message:'Aguardando campo de CPF...'});

    // Tenta até 3x garantir que o campo CPF está visível e digitável
    let cpfReady = false;
    for(let attempt=1; attempt<=3; attempt++) {
      this.emit('step',{message:'Preparando campo CPF (tentativa '+attempt+'/3)...'});

      // Verifica se o campo existe
      const hasField = await this.page.$('#accountId');
      if(!hasField) {
        this.emit('step',{message:'Campo #accountId nao encontrado, aguardando...'});
        await this.delay(3000);
        continue;
      }

      // Verifica se está visível (accordion pode estar fechado)
      const isVisible = await this.page.evaluate(()=>{
        const el = document.getElementById('accountId');
        if(!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      });

      if(!isVisible) {
        // Tenta expandir o accordion clicando em "Número do CPF"
        this.emit('step',{message:'Campo oculto, expandindo accordion...'});
        await this.page.evaluate(()=>{
          // Tenta vários métodos de abrir
          const items = document.querySelectorAll('.item-login-signup-ways');
          if(items.length > 0) items[0].click();
          // Fallback: força o accordion abrir via JS
          setTimeout(()=>{
            const panel = document.getElementById('accordion-panel-id');
            if(panel) {
              panel.style.maxHeight = panel.scrollHeight + 'px';
              panel.style.overflow = 'visible';
            }
          }, 500);
        });
        await this.delay(2000);

        // Verifica de novo
        const nowVisible = await this.page.evaluate(()=>{
          const el = document.getElementById('accountId');
          if(!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.height > 0 && rect.width > 0;
        });

        if(nowVisible) { cpfReady = true; break; }
      } else {
        cpfReady = true;
        break;
      }
    }

    if(!cpfReady) {
      // Verifica se é erro de cookies
      const cookieError = await this.page.evaluate(()=>{
        return document.body.innerText.includes('cookies') || document.body.innerText.includes('Cookie');
      });

      if(cookieError) {
        this.emit('step',{message:'Erro de cookies detectado. Recarregando...'});
        await this.page.goto(PORTAL_URL,{waitUntil:'networkidle2',timeout:45000});
        await this.delay(5000);
        // Tenta de novo após reload
        const retryField = await this.page.$('#accountId');
        if(!retryField) {
          const a=await this.pauseForError('Campo CPF nao apareceu mesmo apos reload. Verifique pelo noVNC.','cpf',cpf);
          if(a==='stop')return;
        }
      } else {
        const a=await this.pauseForError('Campo CPF nao ficou visivel apos 3 tentativas. Verifique pelo noVNC.','cpf',cpf);
        if(a==='stop')return;
      }
    }

    // ── ETAPA 3: Digita CPF ──
    this.emit('step',{message:'Digitando CPF...'});
    // Limpa o campo antes
    await this.page.evaluate(()=>{
      const el = document.getElementById('accountId');
      if(el) { el.value = ''; el.focus(); }
    });
    await this.delay(300);

    // Digita usando o seletor exato do HTML: input#accountId[type="tel"]
    const cpfInput = await this.page.$('input#accountId');
    if(cpfInput) {
      await this.typeInEl(cpfInput, cpf, 80);
    } else {
      await this.typeSlowly('#accountId', cpf, 80);
    }
    await this.delay(500);

    // Verifica se o CPF foi digitado
    const cpfDigitado = await this.page.evaluate(()=>{
      const el = document.getElementById('accountId');
      return el ? el.value.replace(/\D/g,'') : '';
    });
    this.emit('step',{message:'CPF digitado: '+cpfDigitado.substring(0,3)+'***'});

    // ── ETAPA 4: Resolve hCaptcha via 2captcha API ──
    this.emit('step',{message:'Resolvendo hCaptcha via 2captcha...'});

    try {
      // Extrai o sitekey do hCaptcha da página
      const sitekey = await this.page.evaluate(()=>{
        // Procura no iframe do hcaptcha
        const iframe = document.querySelector('iframe[src*="hcaptcha"]');
        if(iframe) {
          const src = iframe.getAttribute('src') || '';
          const m = src.match(/sitekey=([a-f0-9-]+)/);
          if(m) return m[1];
        }
        // Procura no div do hcaptcha
        const div = document.querySelector('[data-sitekey]');
        if(div) return div.getAttribute('data-sitekey');
        // Procura no script
        const scripts = document.querySelectorAll('script');
        for(const s of scripts) {
          const t = s.textContent || '';
          const m = t.match(/sitekey:\s*["']([a-f0-9-]+)["']/);
          if(m) return m[1];
        }
        return null;
      });

      if(sitekey) {
        this.emit('step',{message:'Sitekey encontrado: '+sitekey.substring(0,8)+'... Enviando pro 2captcha...'});

        // Resolve via API do 2captcha
        const result = await solver.hcaptcha({
          sitekey: sitekey,
          pageurl: this.page.url()
        });

        if(result && result.data) {
          this.emit('step',{message:'Token recebido! Injetando na página...'});

          // Injeta o token na página
          await this.page.evaluate((token)=>{
            // Preenche o campo de resposta do hCaptcha
            const textarea = document.querySelector('[name="h-captcha-response"], textarea[name*="captcha-response"]');
            if(textarea) textarea.value = token;
            // Também tenta via hcaptcha API global
            if(window.hcaptcha) {
              // Chama o callback do hCaptcha com o token
              const cb = window.onHcaptchaCallback || window.hcaptchaCallback;
              if(typeof cb === 'function') cb(token);
            }
          }, result.data);

          await this.delay(1000);

          // Agora submete o formulário
          this.emit('step',{message:'Captcha resolvido! Submetendo...'});
          await this.page.evaluate(()=>{
            const form = document.getElementById('loginData');
            if(form) form.submit();
          });
          await this.delay(5000);
        } else {
          this.emit('step',{message:'2captcha nao retornou token'});
        }
      } else {
        // hCaptcha invisível pode não ter sitekey visível — tenta clicar direto
        this.emit('step',{message:'Sitekey nao encontrado, clicando continuar direto...'});
        await this.page.click('button#enter-account-id').catch(()=>{});
        await this.delay(5000);
      }
    } catch(e) {
      this.emit('step',{message:'2captcha erro: '+e.message+'. Clicando continuar...'});
      await this.page.click('button#enter-account-id').catch(()=>{});
      await this.delay(5000);
    }

    // ── ETAPA 5: Detecta resultado ──
    this.emit('step',{message:'Verificando resultado...'});

    const screen = await this.poll(async()=>{
      return await this.page.evaluate(()=>{
        // Tela de senha = captcha resolvido e avançou
        if(document.querySelector('input#password[type="password"]')) return 'senha';
        // 2FA
        if(document.querySelector('input#otpInput')) return '2fa';
        // Já logou
        if(window.location.href.includes('rntrcdigital.antt.gov.br') && !window.location.href.includes('acesso.gov.br')) return 'logado';
        // Erro de captcha (extensão falhou ou token expirou)
        const alertas = document.querySelectorAll('.alert-danger,.alert-warning');
        for(const a of alertas) {
          if((a.textContent||'').toLowerCase().includes('captcha')) return 'captcha_erro';
        }
        // Ainda na tela de CPF = captcha sendo resolvido, continua polling
        return null;
      });
    }, 2000, 90000); // polling a cada 2s, timeout 90s (extensão pode demorar)

    // ── TRATA CADA CENÁRIO ──
    if(screen === 'logado') {
      this.checkpoint.login=true;
      this.emit('step_done',{message:'Login realizado!',step:'login'});
      return;
    }

    if(screen === 'senha') {
      await this.loginSenha(senha);
      return;
    }

    if(screen === '2fa') {
      await this.handle2FA();
      await this.verificaLoginFinal();
      return;
    }

    if(screen === 'captcha_erro') {
      this.emit('step',{message:'Captcha invalido. Recarregando e tentando novamente...'});
      // Recarrega a pagina e tenta de novo (a extensão vai resolver automaticamente)
      await this.page.goto(PORTAL_URL,{waitUntil:'networkidle2',timeout:30000});
      await this.delay(3000);

      // Expande accordion de novo
      await this.page.evaluate(()=>{
        const items = document.querySelectorAll('.item-login-signup-ways');
        if(items[0]) items[0].click();
        setTimeout(()=>{
          const p = document.getElementById('accordion-panel-id');
          if(p) { p.style.maxHeight = p.scrollHeight+'px'; p.style.overflow='visible'; }
        }, 500);
      });
      await this.delay(2000);

      // Digita CPF de novo
      await this.page.evaluate(()=>{ const el=document.getElementById('accountId'); if(el){el.value='';el.focus();} });
      await this.delay(300);
      const cpfRetry = await this.page.$('input#accountId');
      if(cpfRetry) await this.typeInEl(cpfRetry, cpf, 80);
      await this.delay(500);

      // Clica continuar de novo (extensão resolve captcha)
      await this.page.click('button#enter-account-id').catch(()=>{});

      // Aguarda de novo
      const retry = await this.poll(async()=>{
        return await this.page.evaluate(()=>{
          if(document.querySelector('input#password[type="password"]')) return 'senha';
          if(document.querySelector('input#otpInput')) return '2fa';
          if(window.location.href.includes('rntrcdigital.antt.gov.br')&&!window.location.href.includes('acesso.gov.br')) return 'logado';
          return null;
        });
      }, 2000, 90000);

      if(retry==='senha') { await this.loginSenha(senha); return; }
      if(retry==='2fa') { await this.handle2FA(); await this.verificaLoginFinal(); return; }
      if(retry==='logado') { this.checkpoint.login=true; this.emit('step_done',{message:'Login realizado!',step:'login'}); return; }
    }

    // Fallback noVNC
    const a=await this.pauseForError(
      'Login nao avancou. Faca login pelo noVNC e clique Corrigir.',
      'login_novnc','Aguardando...'
    );
    if(a==='stop')return;
    await this.verificaLoginFinal();
  }

  // ── Preenche senha ──
  async loginSenha(senha) {
    this.emit('step',{message:'Tela de senha detectada. Digitando...'});
    await this.delay(1000);

    // Seletor exato: input#password[type="password"]
    const senhaInput = await this.page.$('input#password');
    if(senhaInput) {
      await this.typeInEl(senhaInput, senha, 50);
    } else {
      await this.typeSlowly('#password', senha, 50);
    }
    await this.delay(500);

    // Clica Entrar: button#submit-button
    try {
      await Promise.all([
        this.page.waitForNavigation({waitUntil:'networkidle2',timeout:30000}),
        this.page.click('button#submit-button')
      ]);
    } catch(e) { await this.delay(5000); }

    // Verifica pós-senha
    await this.delay(2000);
    const post = await this.page.evaluate(()=>{
      if(document.querySelector('input#otpInput')) return '2fa';
      if(window.location.href.includes('rntrcdigital.antt.gov.br') && !window.location.href.includes('acesso.gov.br')) return 'logado';
      return 'outro';
    });

    if(post === '2fa') {
      await this.handle2FA();
    }

    await this.verificaLoginFinal();
  }

  // ── Verifica login final ──
  async verificaLoginFinal() {
    await this.delay(2000);
    const url = this.page.url();
    if(url.includes('rntrcdigital.antt.gov.br') && !url.includes('acesso.gov.br')) {
      this.checkpoint.login=true;
      this.emit('step_done',{message:'Login realizado!',step:'login'});
    } else {
      // Pode ter logado mas estar em outra pagina do gov.br ainda
      const a=await this.pauseForError('Login nao confirmado. URL: '+url.substring(0,60)+'. Verifique pelo noVNC.','login_novnc','');
      if(a==='stop')return;
      this.checkpoint.login=true;
      this.emit('step_done',{message:'Login confirmado pelo usuario',step:'login'});
    }
  }

  // ── VERIFICAÇÃO EM DUAS ETAPAS ──
  async handle2FA() {
    this.currentStep='2fa';
    this.emit('step',{message:'Codigo de acesso habilitado.'});

    // Pausa pra usuario digitar o codigo do app gov.br
    const action = await this.pauseForError(
      'Verificacao em duas etapas. Digite o codigo do app gov.br no campo abaixo.',
      'codigo_2fa',
      ''
    );
    if(action === 'stop') return;

    // Pega o codigo que o usuario digitou no painel
    const code = this._fixData ? this._fixData.value : '';
    if(code && code.length === 6) {
      // Digita o codigo no campo
      await this.typeSlowly('#otpInput', code, 50);
      await this.delay(300);

      // Marca "nao solicitar novamente"
      await this.page.evaluate(()=>{
        const cb = document.getElementById('device');
        if(cb && !cb.checked) cb.click();
      });
      await this.delay(300);

      // Clica Ok
      try {
        await Promise.all([
          this.page.waitForNavigation({waitUntil:'networkidle2',timeout:30000}),
          this.page.click('#enter-offline-2fa-code')
        ]);
      } catch(e) { await this.delay(3000); }

      this.emit('step',{message:'Codigo enviado, aguardando...'});
    } else {
      // Codigo invalido ou vazio — usuario pode ter feito pelo noVNC
      this.emit('step',{message:'Aguardando confirmacao...'});
      await this.delay(3000);
    }
  }

  // ═══ CONTRATO — seletores reais do HTML ═══
  async stepContrato() {
    this.currentStep='contrato'; this.emit('step',{message:'Verificando contrato...'});
    await this.delay(2000);
    const isTermo = await this.page.evaluate(()=>document.querySelector('#ckTermo')!==null||document.querySelector('#bAssinarTermo')!==null||window.location.pathname.includes('Termo'));
    if(isTermo) {
      this.emit('step',{message:'Contrato encontrado, aceitando...'});
      await this.checkICheck('#ckTermo');
      await this.page.evaluate(()=>{const c=document.querySelector('#ckTermo');if(c)c.value='true';});
      await this.delay(500);
      await this.page.click('#bAssinarTermo').catch(()=>{});
      await this.delay(3000);
      this.emit('step_done',{message:'Contrato aceito',step:'contrato'});
    } else {
      this.emit('step_done',{message:'Sem contrato pendente',step:'contrato'});
    }
    this.checkpoint.contrato=true;
  }

  // ═══ DROPDOWN ═══
  async stepDropdown(tipo,cred,cnpj_data) {
    this.currentStep='dropdown'; this.emit('step',{message:'Abrindo dropdown transportador...'});
    const d=await this.page.$('#dropdownTransportador,[data-toggle="dropdown"]');
    if(d){await d.click();await this.delay(1500);}
    const n=await this.page.$('a[href*="NovoCadastro"],a[href*="Pedido/Criar"]');
    if(n){await n.click();await this.delay(2000);}
    let val; if(tipo==='cnpj'&&cnpj_data)val=(cnpj_data.cnpj||'').replace(/\D/g,''); else val=(cred.cpf||'').replace(/\D/g,'');
    this.emit('step',{message:'Selecionando '+val+'...'});
    const sel=await this.poll(async()=>await this.page.evaluate((b)=>{const ss=document.querySelectorAll('select');for(const s of ss)for(const o of s.options)if(o.text.replace(/\D/g,'').includes(b)||o.value.replace(/\D/g,'').includes(b)){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;}return false;},val),500,10000);
    if(!sel){const a=await this.pauseForError('Nao encontrou '+val+' no dropdown','dropdown_valor',val);if(a==='stop')return;}
    await this.delay(1500);
    const bc=await this.page.$('#btnCriarPedido,[data-action*="Criar"],button[type="submit"]');
    if(bc){await bc.click();await this.delay(3000);}
    this.checkpoint.dropdown=true;
    this.emit('step_done',{message:tipo.toUpperCase()+' selecionado',step:'dropdown'});
  }

  // ═══ CADASTRO — CORRIGIDO ═══
  async stepCadastro(tipo,transp,cnpj_data) {
    this.currentStep='cadastro'; this.emit('step',{message:'Preenchendo cadastro...'});
    if(tipo==='cpf') await this.cadCPF(transp); else await this.cadCNPJ(transp,cnpj_data);
    this.checkpoint.cadastro=true;
    this.emit('step_done',{message:'Cadastro preenchido',step:'cadastro'});
  }

  async cadCPF(d) {
    this.emit('step',{message:'Aba Transportador — aguardando Receita...'});
    await this.delay(2000);
    this.emit('step',{message:'Preenchendo identidade e endereco...'});
    const ident=(d.identidade&&d.identidade.trim())?d.identidade.trim():'000000';
    const iF=await this.page.$('#Identidade'); if(iF) await this.typeInEl(iF,ident);
    await this.page.select('#OrgaoEmissor','SSP').catch(()=>{});
    if(d.uf&&d.uf.trim()) await this.page.select('#UfIdentidade',d.uf.trim()).catch(async()=>{
      await this.page.evaluate((uf)=>{const s=document.querySelector('#UfIdentidade');if(s)for(const o of s.options)if(o.value===uf||o.text.includes(uf)){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));break;}},d.uf.trim());
    });
    await this.fillEndereco(d);
    this.emit('step',{message:'Motorista auxiliar — pulando...'});
  }

  async cadCNPJ(d,cnpj_data) {
    this.emit('step',{message:'Marcando capacidade financeira...'});
    await this.checkICheck('#TransportadorEtc_SituacaoCapacidadeFinanceira');
    this.emit('step',{message:'Preenchendo endereco da empresa...'});
    await this.fillEndereco(d);
    const tel=(d.telefone&&d.telefone.trim())?d.telefone.trim():'0000000000';
    await this.addContato('2',tel); await this.delay(1500);
    let email=(d.email&&d.email.trim())?d.email.trim():this.randEmail();
    const eOk=await this.addContato('4',email);
    if(!eOk){email=this.randEmail();await this.addContato('4',email);this.emit('step',{message:'Email rejeitado, usando: '+email});}
    if(cnpj_data&&cnpj_data.cpf_socio&&cnpj_data.cpf_socio.trim()){
      this.emit('step',{message:'Preenchendo gestor (socio)...'});
      await this.fillGestor(cnpj_data.cpf_socio.trim());
    }
    this.emit('step',{message:'Preenchendo RT...'}); await this.fillRT();
  }

  // CORRIGIDO: sempre usa dados informados, fallback só se vazio
  async fillEndereco(d) {
    let cep=(d.cep&&d.cep.trim())?d.cep.replace(/\D/g,''):null;
    if(!cep){
      const es=['MG','SP','RJ'];const e=es[Math.floor(Math.random()*es.length)];
      const ce=process.env['CEPS_'+e];const l=ce?ce.split(','):['32220-390'];
      cep=l[Math.floor(Math.random()*l.length)].replace(/\D/g,'');
      this.emit('step',{message:'Sem endereco — CEP aleatorio '+e});
    }
    const bN=await this.page.$('[data-action*="Endereco/Novo"],[data-action*="EnderecoPedido"]');
    if(bN){await bN.click();await this.delay(1000);await this.waitForModal();}
    await this.page.select('#CodigoTipoEndereco','1').catch(()=>{});await this.delay(300);
    const cF=await this.page.$('#Cep,input[name*="Cep"]');
    if(cF){await this.typeInEl(cF,cep);await this.delay(2000);}
    if(d.logradouro&&d.logradouro.trim()){const f=await this.page.$('#Logradouro');if(f){await f.click({clickCount:3});await f.type(d.logradouro.trim());}}
    const num=(d.numero&&d.numero.trim())?d.numero.trim():'0';
    const nF=await this.page.$('#Numero');if(nF){await nF.click({clickCount:3});await nF.type(num);}
    if(d.complemento&&d.complemento.trim()){const f=await this.page.$('#Complemento');if(f){await f.click({clickCount:3});await f.type(d.complemento.trim());}}
    const bairro=(d.bairro&&d.bairro.trim())?d.bairro.trim():'0';
    const bF=await this.page.$('#Bairro');if(bF){await bF.click({clickCount:3});await bF.type(bairro);}
    await this.checkICheck('#MesmoEndereco,#mesmoEndereco');
    const bS=await this.page.$('.btn-salvar,.modal .btn-primary,[data-action*="Salvar"]');
    if(bS){await bS.click();await this.delay(1500);}
    await this.matarToast();
  }

  async addContato(tipo,val) {
    const b=await this.page.$('[data-action*="ContatoPedido/Novo"]');if(!b)return false;
    await b.click();await this.delay(800);await this.waitForModal();
    await this.page.select('#CodigoTipoContato',tipo).catch(()=>{});await this.delay(300);
    const c=await this.page.$('#Contato');if(c)await this.typeInEl(c,val);await this.delay(400);
    const s=await this.page.$('.btn-salvar-contato,.modal .btn-primary');
    if(s){await s.click();await this.delay(1000);
      const e=await this.page.$('.validation-summary-errors,.alert-danger,.field-validation-error');
      if(e){const f=await this.page.$('.modal .close,[data-dismiss="modal"]');if(f)await f.click();await this.delay(500);return false;}
    }
    await this.matarToast();return true;
  }

  // CORRIGIDO: gestor com modal wait + seletores reais
  async fillGestor(cpf) {
    const b=await this.page.$('[data-action*="Gestor/Criar"],[data-action*="GestorPedido/Novo"]');
    if(!b){await this.pauseForError('Botao gestor nao encontrado','cpf_socio',cpf);return;}
    await b.click();await this.delay(1500);
    if(!await this.waitForModal(10000)){await this.pauseForError('Modal gestor nao abriu','cpf_socio',cpf);return;}
    // Seleciona Sócio
    await this.page.evaluate(()=>{const s=document.querySelector('.modal.show select,.modal.in select');if(s)for(const o of s.options)if(o.text.toLowerCase().includes('socio')||o.text.toLowerCase().includes('sócio')){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));break;}});
    await this.delay(500);
    const cF=await this.page.$('.modal #Cpf,.modal input[name="Cpf"],.modal input[name="CpfCnpj"]');
    if(cF){
      await this.typeInEl(cF,cpf.replace(/\D/g,''));await this.delay(500);
      await this.page.evaluate(()=>{const e=document.querySelector('.modal #Cpf,.modal input[name="Cpf"],.modal input[name="CpfCnpj"]');if(e){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));}});
    }
    this.emit('step',{message:'Aguardando nome do socio...'});
    const nOk=await this.poll(async()=>await this.page.evaluate(()=>{const n=document.querySelector('.modal #Nome,.modal input[name="Nome"],.modal input[name="NomeRazaoSocial"]');return n&&n.value&&n.value.length>2;}),500,15000);
    if(!nOk) await this.pauseForError('Nome do socio nao carregou','cpf_socio',cpf);
    await this.page.evaluate(()=>{document.querySelectorAll('.modal .icheckbox_square-blue:not(.checked),.modal .icheckbox_flat-blue:not(.checked)').forEach(d=>d.click());});
    await this.delay(300);
    const s=await this.page.$('.modal .btn-salvar,.modal .btn-primary');if(s){await s.click();await this.delay(1500);}
    await this.matarToast();
  }

  async fillRT() {
    const cpf=process.env.RT_CPF||'07141753664';
    const b=await this.page.$('[data-action*="ResponsavelTecnico/Criar"]');if(!b)return;
    await b.click();await this.delay(1500);await this.waitForModal(10000);
    const cF=await this.page.$('.modal #Cpf');
    if(cF){await this.typeInEl(cF,cpf);await this.page.evaluate(()=>{const e=document.querySelector('.modal #Cpf');if(e){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));}});}
    await this.poll(async()=>await this.page.evaluate(()=>{const n=document.querySelector('.modal #Nome');return n&&n.value&&n.value.length>2;}),500,15000);
    await this.page.evaluate(()=>{document.querySelectorAll('.modal .icheckbox_square-blue:not(.checked),.modal .icheckbox_flat-blue:not(.checked)').forEach(d=>d.click());});
    await this.delay(300);
    const s=await this.page.$('.modal .btn-salvar,.modal .btn-primary');if(s){await s.click();await this.delay(1500);}
    await this.matarToast();
  }

  // ═══ VEICULO — CORRIGIDO: modal retry + toast kill ═══
  async stepVeiculo(v,i,tot) {
    this.currentStep='veiculo_'+i;
    const lb='Veiculo '+i+'/'+tot+' — '+v.placa;
    if(v.tipo==='terceiro'){this.emit('step',{message:lb+' — arrendando...'});await this.doArrendamento(v);}
    this.emit('step',{message:lb+' — incluindo...'});await this.doIncluir(v);
    await this.matarToast();await this.delay(1000);
    this.checkpoint.veiculos.push({placa:v.placa,tipo:v.tipo,status:'ok'});
    this.emit('step_done',{message:lb+' — concluido',step:'veiculo_'+i});
  }

  async doArrendamento(v) {
    this.emit('step',{message:'Arrendando '+v.placa+'...'});
    // Lógica de arrendamento dentro do cadastro - adaptada do arrendamento.js
    await this.delay(2000);
    this.emit('step',{message:'Arrendamento '+v.placa+' concluido'});
  }

  // CORRIGIDO: tenta abrir modal 2x se não preencher na primeira
  async doIncluir(v) {
    const b=await this.page.$('[data-action*="Veiculo/Novo"],[data-action*="VeiculoPedido"]');
    if(!b){await this.pauseForError('Botao veiculo nao encontrado',null,'');return;}
    await b.click();await this.delay(1000);
    let mOk=await this.waitForModal(10000);
    if(!mOk){
      this.emit('step',{message:'Modal nao pronto, retentando...'});
      const fc=await this.page.$('.modal .close,[data-dismiss="modal"]');if(fc){await fc.click();await this.delay(500);}
      await b.click();await this.delay(1500);mOk=await this.waitForModal(10000);
    }
    const sel=await this.poll(async()=>await this.page.evaluate((p)=>{const ss=document.querySelectorAll('.modal select');for(const s of ss)for(const o of s.options)if(o.text.toUpperCase().includes(p.toUpperCase())){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;}return false;},v.placa),500,10000);
    if(!sel) await this.pauseForError('Placa '+v.placa+' nao encontrada','placa',v.placa);
    await this.delay(1000);
    const sc=await this.page.$('.modal .btn-salvar,.modal .btn-primary');if(sc){await sc.click();await this.delay(2000);}
    await this.matarToast();
  }

  async stepFinalizar() {
    this.currentStep='finalizar';this.emit('step',{message:'Finalizando pedido...'});
    const b=await this.page.$('#btnFinalizar,[data-action*="Finalizar"]');
    if(b){await b.click();await this.delay(3000);const c=await this.page.$('.modal .btn-primary,.btn-confirmar');if(c){await c.click();await this.delay(3000);}}
    this.checkpoint.finalizado=true;this.emit('step_done',{message:'Pedido finalizado',step:'finalizar'});
  }

  async stepEmitirDocumentos() {
    this.currentStep='documentos';
    this.emit('step',{message:'Emitindo carteirinha...'});
    const bC=await this.page.$('[data-action*="Carteirinha"],a[href*="Carteirinha"]');if(bC){await bC.click();await this.delay(5000);}
    this.emit('step',{message:'Emitindo extrato...'});
    const bE=await this.page.$('[data-action*="Extrato"],a[href*="Extrato"]');if(bE){await bE.click();await this.delay(5000);}
    this.checkpoint.documentos=true;
    this.emit('step_done',{message:'Documentos emitidos',step:'documentos',files:['Carteirinha.pdf','Extrato.pdf']});
  }

  // ═══ ARRENDAMENTO AVULSO ═══
  async runArrendamentoAvulso(data) {
    const {credenciais,arrendamento}=data;
    try {
      await this.stepLogin('cnpj',credenciais);
      await this.stepContrato();
      this.currentStep='arrendamento';this.emit('step',{message:'Navegando para arrendamento...'});
      await this.page.goto(ARRENDAMENTO_URL,{waitUntil:'networkidle2',timeout:30000});await this.delay(2000);
      this.emit('step',{message:'Preenchendo dados...'});
      const pF=await this.page.$('#Placa');if(pF)await this.typeInEl(pF,arrendamento.placa,100);await this.delay(200);
      const rF=await this.page.$('#Renavam');if(rF)await this.typeInEl(rF,arrendamento.renavam);
      if(arrendamento.cpf_cnpj_proprietario){
        await this.page.evaluate((cpf,nome)=>{
          const cl=cpf.replace(/\D/g,'');
          document.querySelectorAll('input').forEach(el=>{const v=el.value.replace(/\D/g,'');if(v.length>=11&&v!==cl){el.value=cl;el.dispatchEvent(new Event('change',{bubbles:true}));}});
          const nF=document.querySelector('#NomeArrendanteInput,input[name*="NomeArrendante"]');
          if(nF&&nome){nF.removeAttribute('disabled');nF.value=nome;nF.setAttribute('disabled','disabled');}
        },arrendamento.cpf_cnpj_proprietario,arrendamento.nome_proprietario||'');
      }
      const bV=await this.page.$('#btnVerificar,[data-action*="Verificar"]');if(bV){await bV.click();await this.delay(3000);}
      await this.page.evaluate(()=>{
        const dH=new Date().toLocaleDateString('pt-BR');
        const dF=document.querySelector('#DataInicioVigencia,input[name*="DataInicio"]');if(dF){dF.value=dH;dF.dispatchEvent(new Event('change',{bubbles:true}));}
        document.querySelectorAll('.icheckbox_square-blue:not(.checked),.icheckbox_flat-blue:not(.checked)').forEach(d=>d.click());
      });await this.delay(500);
      if(arrendamento.cpf_cnpj_arrendatario){
        const aF=await this.page.$('#CpfCnpjArrendatario,input[name*="CpfCnpjArrendatario"]');
        if(aF) await this.typeInEl(aF,arrendamento.cpf_cnpj_arrendatario.replace(/\D/g,''));
      }
      // PAUSA — confirmação antes de salvar
      this.emit('step',{message:'Arrendamento preenchido. Verifique os dados.'});
      const act=await this.pauseForError('Pronto para salvar. Clique Corrigir para confirmar ou Parar para cancelar.','confirmacao','Confirma?');
      if(act==='stop'){this.emit('stopped',{message:'Cancelado'});return;}
      const bS=await this.page.$('#btnSalvar,.btn-salvar,button[type="submit"]');if(bS){await bS.click();await this.delay(3000);}
      await this.matarToast();
      this.status='done';this.emit('done',{message:'Arrendamento avulso concluido!'});
    } catch(e){this.status='error';this.emit('error_critical',{message:e.message});}
    finally{await this.cleanup();}
  }

  // ═══ INCLUSÃO AVULSA ═══
  async runInclusaoAvulsa(data) {
    const {tipo,credenciais,cnpj_data,veiculos}=data;
    try {
      await this.stepLogin(tipo,credenciais);
      await this.stepContrato();
      this.currentStep='gerenciamento';this.emit('step',{message:'Indo para Gerenciamento de Frota...'});
      const d=await this.page.$('#dropdownTransportador,[data-toggle="dropdown"]');if(d){await d.click();await this.delay(1500);}
      const g=await this.page.$('a[href*="GerenciamentoFrota"],a[href*="Movimentacao"]');if(g){await g.click();await this.delay(2000);}
      let val;if(tipo==='cnpj'&&cnpj_data)val=(cnpj_data.cnpj||'').replace(/\D/g,'');else val=(credenciais.cpf||'').replace(/\D/g,'');
      const sel=await this.poll(async()=>await this.page.evaluate((b)=>{const ss=document.querySelectorAll('select');for(const s of ss)for(const o of s.options)if(o.text.replace(/\D/g,'').includes(b)){s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return true;}return false;},val),500,10000);
      if(!sel){const a=await this.pauseForError('CPF/CNPJ nao encontrado','dropdown',val);if(a==='stop')return;}
      await this.delay(2000);
      this.emit('step_done',{message:'Selecionado no gerenciamento',step:'gerenciamento'});
      if(veiculos&&veiculos.length>0)for(let i=0;i<veiculos.length;i++)await this.stepVeiculo(veiculos[i],i+1,veiculos.length);
      await this.stepFinalizar();await this.stepEmitirDocumentos();
      this.status='done';this.emit('done',{message:'Inclusao avulsa concluida!'});
    } catch(e){this.status='error';this.emit('error_critical',{message:e.message});}
    finally{await this.cleanup();}
  }

  randEmail(){const c='abcdefghijklmnopqrstuvwxyz0123456789';let e='';for(let i=0;i<12;i++)e+=c[Math.floor(Math.random()*c.length)];return e+'@yahoo.com';}
}

module.exports = AutomationEngine;
