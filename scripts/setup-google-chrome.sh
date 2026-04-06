#!/bin/bash
# setup-google-chrome.sh — Instala Google Chrome Stable (não Chromium)
# Uso: sudo bash setup-google-chrome.sh

echo "=== Removendo Chromium Snap (se existir) ==="
snap remove chromium 2>/dev/null
apt remove -y chromium-browser chromium 2>/dev/null

echo "=== Baixando Google Chrome Stable ==="
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

echo "=== Instalando ==="
apt install -y /tmp/chrome.deb || apt --fix-broken install -y
rm /tmp/chrome.deb

echo "=== Verificando ==="
CHROME_PATH=$(which google-chrome-stable || which google-chrome)
if [ -n "$CHROME_PATH" ]; then
  echo "  ✓ Google Chrome instalado: $CHROME_PATH"
  $CHROME_PATH --version
  
  # Atualiza .env
  if [ -f /opt/omega-painel/.env ]; then
    grep -q "CHROME_PATH" /opt/omega-painel/.env || echo "CHROME_PATH=$CHROME_PATH" >> /opt/omega-painel/.env
    sed -i "s|CHROME_PATH=.*|CHROME_PATH=$CHROME_PATH|" /opt/omega-painel/.env
    echo "  ✓ .env atualizado com CHROME_PATH=$CHROME_PATH"
  fi
else
  echo "  ✗ Falha na instalação"
  exit 1
fi

echo ""
echo "✅ Google Chrome instalado!"
echo "   Reinicie: pm2 restart omega-painel"
