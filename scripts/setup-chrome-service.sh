#!/bin/bash
# setup-chrome-service.sh — Configura Chrome como serviço independente pra Puppeteer conectar
# Uso: sudo bash setup-chrome-service.sh

set -e

echo "=== 1. Instalando Google Chrome Stable ==="
if ! command -v google-chrome &> /dev/null; then
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt install -y /tmp/chrome.deb || apt --fix-broken install -y
  rm /tmp/chrome.deb
  echo "  ✓ Google Chrome instalado"
else
  echo "  ✓ Google Chrome já instalado"
fi

echo "  Versão: $(google-chrome --version)"

echo ""
echo "=== 2. Instalando Xvfb ==="
apt install -y xvfb
echo "  ✓ Xvfb instalado"

echo ""
echo "=== 3. Criando usuário omegauser ==="
if ! id "omegauser" &>/dev/null; then
  useradd -m -s /bin/bash omegauser
  echo "  ✓ Usuário omegauser criado"
else
  echo "  ✓ Usuário omegauser já existe"
fi

echo ""
echo "=== 4. Criando diretório do perfil Chrome ==="
mkdir -p /home/omegauser/chrome-profile
chown -R omegauser:omegauser /home/omegauser/chrome-profile

echo ""
echo "=== 5. Criando script de inicialização do Chrome ==="
cat > /opt/omega-painel/scripts/start-chrome.sh << 'CHREOF'
#!/bin/bash
# Inicia Chrome com Xvfb (tela virtual) e remote debugging
export DISPLAY=:99

# Inicia Xvfb se não tiver rodando
if ! pgrep -x Xvfb > /dev/null; then
  Xvfb :99 -screen 0 1920x1080x24 -ac &
  sleep 2
fi

# Inicia Chrome com perfil persistente
exec google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/omegauser/chrome-profile \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --disable-gpu \
  --disable-dev-shm-usage \
  --window-size=1366,768 \
  --start-maximized \
  --display=:99 \
  about:blank
CHREOF
chmod +x /opt/omega-painel/scripts/start-chrome.sh
chown omegauser:omegauser /opt/omega-painel/scripts/start-chrome.sh

echo ""
echo "=== 6. Registrando no PM2 ==="
# Para o Chrome se já tiver rodando
su - omegauser -c "pm2 delete omega-chrome 2>/dev/null || true"
su - omegauser -c "pm2 start /opt/omega-painel/scripts/start-chrome.sh --name omega-chrome"
su - omegauser -c "pm2 save"
sleep 5

echo ""
echo "=== 7. Verificando ==="
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "  ✓ Chrome rodando na porta 9222!"
  curl -s http://127.0.0.1:9222/json/version | head -5
else
  echo "  ✗ Chrome não respondeu na porta 9222"
  echo "  Tente: su - omegauser -c 'bash /opt/omega-painel/scripts/start-chrome.sh &'"
  echo "  Depois: curl http://127.0.0.1:9222/json/version"
fi

echo ""
echo "=========================================="
echo "  Chrome configurado como serviço!"
echo "=========================================="
echo ""
echo "  O Chrome roda como 'omegauser' (não root)"
echo "  Sem flags de automação — indetectável"
echo "  Perfil persistente em /home/omegauser/chrome-profile"
echo ""
echo "  PRÓXIMO PASSO:"
echo "  1. Acesse http://SEU_IP:6080 (noVNC)"
echo "  2. Abra chrome://extensions no Chrome"
echo "  3. Instale a extensão 2captcha-solver manualmente"
echo "  4. Configure sua API key na extensão"
echo "  5. Ative auto-solve pra hCaptcha"
echo "  6. Feche a aba de extensões"
echo "  7. A extensão fica salva no perfil persistente"
echo "=========================================="
