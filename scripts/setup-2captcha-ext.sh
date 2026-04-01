#!/bin/bash
# setup-2captcha-ext.sh — Baixa e configura a extensão 2captcha-solver pro Chromium
# Uso: bash setup-2captcha-ext.sh SUA_API_KEY_2CAPTCHA

API_KEY="$1"
if [ -z "$API_KEY" ]; then
  echo "Uso: bash setup-2captcha-ext.sh SUA_API_KEY_2CAPTCHA"
  exit 1
fi

EXT_DIR="/opt/omega-painel/extensions/2captcha-solver"

echo "=== Baixando extensão 2captcha-solver ==="
cd /tmp
# Baixa a versão mais recente do GitHub
wget -q https://github.com/2captcha/solver-extension/releases/latest/download/2captcha-solver.zip -O 2captcha-solver.zip
mkdir -p "$EXT_DIR"
unzip -o 2captcha-solver.zip -d "$EXT_DIR"

echo "=== Configurando API key ==="
# Configura a chave API e auto-resolve no config.js
CONFIG_FILE="$EXT_DIR/common/config.js"
if [ -f "$CONFIG_FILE" ]; then
  # Substitui apiKey
  sed -i "s/apiKey: ''/apiKey: '$API_KEY'/" "$CONFIG_FILE"
  sed -i "s/apiKey: \"\"/apiKey: \"$API_KEY\"/" "$CONFIG_FILE"

  # Ativa auto-solve para hCaptcha
  sed -i 's/autoSolveHCaptcha: false/autoSolveHCaptcha: true/' "$CONFIG_FILE"
  sed -i 's/autoSolveRecaptchaV2: false/autoSolveRecaptchaV2: true/' "$CONFIG_FILE"

  echo "  ✓ API key configurada"
  echo "  ✓ Auto-solve hCaptcha ativado"
else
  echo "  ✗ config.js não encontrado. Verifique o download."
  exit 1
fi

# Desabilita abertura da pagina de configurações na instalação
MANIFEST="$EXT_DIR/manifest.json"
if [ -f "$MANIFEST" ]; then
  # Remove options_ui que abre aba de config automaticamente
  python3 -c "
import json
with open('$MANIFEST','r') as f: m=json.load(f)
m.pop('options_ui',None)
with open('$MANIFEST','w') as f: json.dump(m,f,indent=2)
" 2>/dev/null || sed -i '/"options_ui"/,/}/d' "$MANIFEST"
  echo "  ✓ Auto-open de configurações desabilitado"
fi

echo ""
echo "✅ Extensão 2captcha-solver configurada em: $EXT_DIR"
echo "   Reinicie o omega-painel: pm2 restart omega-painel"
