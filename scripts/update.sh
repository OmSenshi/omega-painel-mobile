#!/bin/bash
# update.sh — Atualiza o Omega Painel na VPS
# Uso: bash update.sh omega-v25-fix2.zip

ZIP_FILE="$1"

if [ -z "$ZIP_FILE" ]; then
  echo "Uso: bash update.sh ARQUIVO.zip"
  exit 1
fi

if [ ! -f "$ZIP_FILE" ]; then
  echo "Arquivo não encontrado: $ZIP_FILE"
  exit 1
fi

echo "=== Parando PM2 ==="
pm2 stop omega-painel 2>/dev/null

echo "=== Backup do .env ==="
cp /opt/omega-painel/.env /tmp/omega-env-backup 2>/dev/null

echo "=== Removendo arquivos antigos (exceto node_modules e data) ==="
cd /opt/omega-painel
rm -rf src/ public/ scripts/ docs/ package.json .env.example

echo "=== Extraindo zip ==="
cd /tmp
unzip -o "$ZIP_FILE"
cp -r /tmp/omega-painel-mobile/src /opt/omega-painel/
cp -r /tmp/omega-painel-mobile/public /opt/omega-painel/
cp -r /tmp/omega-painel-mobile/scripts /opt/omega-painel/ 2>/dev/null
cp -r /tmp/omega-painel-mobile/docs /opt/omega-painel/ 2>/dev/null
cp /tmp/omega-painel-mobile/package.json /opt/omega-painel/
cp /tmp/omega-painel-mobile/.env.example /opt/omega-painel/
cp /tmp/omega-painel-mobile/.gitignore /opt/omega-painel/ 2>/dev/null
rm -rf /tmp/omega-painel-mobile

echo "=== Restaurando .env ==="
cp /tmp/omega-env-backup /opt/omega-painel/.env 2>/dev/null

echo "=== Instalando dependências ==="
cd /opt/omega-painel
npm install

echo "=== Verificando engine.js ==="
grep -c "incognito" /opt/omega-painel/src/automation/engine.js
grep -c "item-login-signup" /opt/omega-painel/src/automation/engine.js
echo "Se ambos mostrarem números > 0, o arquivo está correto."

echo "=== Reiniciando PM2 ==="
pm2 restart omega-painel

echo ""
echo "✅ Atualização concluída!"
echo "   Verifique com: pm2 logs omega-painel"
