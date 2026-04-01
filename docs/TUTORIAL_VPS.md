# Omega Painel Mobile — Tutorial de Configuração VPS

## O que é uma VPS?

VPS (Virtual Private Server) é um computador virtual na nuvem que fica ligado 24h.
Você acessa ele de qualquer lugar pelo celular/tablet. É onde o Omega Painel vai rodar.

---

## Passo 1: Escolher e contratar uma VPS

### Opções recomendadas (mais baratas e confiáveis)

**Hostinger VPS** (melhor custo-benefício para o Brasil)
- Plano KVM 1: ~R$25/mês
- 1 vCPU, 4GB RAM, 50GB SSD
- Servidor em São Paulo (menor latência)
- Site: https://www.hostinger.com.br/servidor-vps

**Contabo** (mais barato, servidor na Europa)
- Plano VPS S: ~€5/mês (~R$28)
- 4 vCPU, 8GB RAM, 200GB SSD
- Site: https://contabo.com/en/vps/

**DigitalOcean** (mais profissional)
- Droplet Basic: $6/mês (~R$33)
- 1 vCPU, 1GB RAM, 25GB SSD
- Site: https://www.digitalocean.com

**Oracle Cloud** (GRÁTIS para sempre!)
- ARM Ampere: 4 OCPU, 24GB RAM
- Plano Always Free — não cobra nada
- Site: https://cloud.oracle.com
- Obs: o cadastro pede cartão mas não cobra. Processo é mais complicado.

### Minha recomendação

Para começar rápido: **Hostinger VPS** (servidor em SP, painel fácil, suporte em PT-BR).
Para não gastar nada: **Oracle Cloud** (precisa mais paciência no setup).

### Na hora de contratar

- Sistema operacional: **Ubuntu 22.04 ou 24.04**
- Localização: **São Paulo** (ou mais próximo do Brasil)
- Mínimo: 1 vCPU, 2GB RAM (Puppeteer precisa de pelo menos 1GB livre)

---

## Passo 2: Acessar a VPS

Após contratar, você recebe:
- **IP** do servidor (ex: 201.123.45.67)
- **Senha de root** ou chave SSH

### Pelo celular

Instale o app **Termius** (Android/iOS) — é um terminal SSH gratuito.
1. Abra o Termius
2. Toque em "+" > "New Host"
3. Hostname: cole o IP da VPS
4. Username: `root`
5. Password: cole a senha que recebeu
6. Toque em "Connect"

### Pelo computador

Abra o terminal (CMD no Windows, Terminal no Mac/Linux):
```bash
ssh root@SEU_IP_DA_VPS
```
Digite a senha quando pedir.

---

## Passo 3: Instalar tudo na VPS

Copie e cole esses comandos um por um no terminal SSH:

### Atualizar o sistema
```bash
apt update && apt upgrade -y
```

### Instalar Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

### Instalar dependências do Puppeteer (Chrome headless)
```bash
apt install -y wget gnupg ca-certificates \
  fonts-liberation libappindicator3-1 libasound2 \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
  libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  xdg-utils libxss1 libxtst6 lsb-release
```

### Instalar o Chromium do sistema (mais estável que o bundled)
```bash
apt install -y chromium-browser || apt install -y chromium
```

### Criar pasta do projeto
```bash
mkdir -p /opt/omega-painel
cd /opt/omega-painel
```

---

## Passo 4: Subir o código

### Opção A: Via GitHub (recomendado)

No seu computador, suba o projeto pro GitHub:
```bash
cd omega-painel-mobile
git init
git add .
git commit -m "v2.0 - painel mobile"
git remote add origin https://github.com/OmSenshi/omega-painel-mobile.git
git push -u origin main
```

Na VPS:
```bash
cd /opt/omega-painel
git clone https://github.com/OmSenshi/omega-painel-mobile.git .
```

### Opção B: Upload direto (sem GitHub)

No seu computador, compacta a pasta:
```bash
zip -r omega-painel-mobile.zip omega-painel-mobile/
```

Depois envia pra VPS (pelo terminal do seu PC):
```bash
scp omega-painel-mobile.zip root@SEU_IP:/opt/omega-painel/
```

Na VPS:
```bash
cd /opt/omega-painel
unzip omega-painel-mobile.zip
mv omega-painel-mobile/* .
```

---

## Passo 5: Configurar e rodar

### Instalar dependências do Node
```bash
cd /opt/omega-painel
npm install
```

### Configurar variáveis de ambiente
```bash
cp .env.example .env
nano .env
```

Preencha:
```
PORT=3000
CLAUDE_API_KEY=sk-ant-api03-SUA_CHAVE_AQUI
COLAB_CPF=07141753664
COLAB_SENHA=SUA_SENHA_DO_PORTAL
RT_CPF=07141753664
```

Salve com: Ctrl+O, Enter, Ctrl+X

### Testar
```bash
node src/server.js
```

Se aparecer "Rodando em http://0.0.0.0:3000" — está funcionando!
Acesse pelo celular: `http://SEU_IP:3000`

### Parar o teste
Ctrl+C

---

## Passo 6: Manter rodando 24h (PM2)

O PM2 mantém o servidor rodando mesmo se a VPS reiniciar.

```bash
npm install -g pm2

cd /opt/omega-painel
pm2 start src/server.js --name omega-painel
pm2 save
pm2 startup
```

### Comandos úteis do PM2
```bash
pm2 status          # ver se está rodando
pm2 logs omega-painel  # ver logs em tempo real
pm2 restart omega-painel  # reiniciar
pm2 stop omega-painel     # parar
```

---

## Passo 7: Segurança (IMPORTANTE)

### Firewall — liberar apenas as portas necessárias
```bash
ufw allow 22      # SSH
ufw allow 3000    # Omega Painel
ufw enable
```

### Criar usuário não-root (recomendado)
```bash
adduser omega
usermod -aG sudo omega
```

Depois acesse com: `ssh omega@SEU_IP`

### (Opcional) HTTPS com domínio gratuito

Se quiser acessar por um nome bonito (ex: omega.seudominio.com):

1. Registre um domínio gratuito no https://freenom.com ou use um subdomínio do no-ip.com
2. Aponte o DNS pro IP da sua VPS
3. Instale o Nginx + Certbot:

```bash
apt install -y nginx certbot python3-certbot-nginx

# Configuração do Nginx
cat > /etc/nginx/sites-available/omega << 'EOF'
server {
    listen 80;
    server_name SEU_DOMINIO;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

ln -s /etc/nginx/sites-available/omega /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL grátis
certbot --nginx -d SEU_DOMINIO
```

Agora acessa via `https://SEU_DOMINIO` com cadeado verde.

---

## Passo 8: Atualizar o código

Quando fizer mudanças no projeto:

### Se usa GitHub:
```bash
cd /opt/omega-painel
git pull
npm install
pm2 restart omega-painel
```

### Se envia manual:
Sobe o zip novo, descompacta, e roda:
```bash
pm2 restart omega-painel
```

---

## Resumo — o que acessar do celular

1. **Painel**: `http://SEU_IP:3000` (ou `https://SEU_DOMINIO`)
2. **Terminal SSH** (se precisar): app Termius no celular
3. **Logs**: `pm2 logs` via Termius

---

## Troubleshooting

**Puppeteer não abre o Chrome:**
```bash
# Verifica se o Chromium está instalado
which chromium-browser || which chromium

# Se não tiver, instala:
apt install -y chromium-browser

# No engine.js, adiciona o path:
# executablePath: '/usr/bin/chromium-browser'
```

**Erro de memória:**
```bash
# Veja quanta RAM está livre
free -h

# Se tiver menos de 500MB livre, cria swap:
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Porta 3000 não abre no celular:**
```bash
# Verifica se o firewall está liberando
ufw status

# Se não aparecer 3000, libera:
ufw allow 3000
```

**Página em branco no celular:**
- Verifique se digitou o IP correto
- Verifique se o PM2 está rodando: `pm2 status`
- Veja os logs: `pm2 logs omega-painel`
