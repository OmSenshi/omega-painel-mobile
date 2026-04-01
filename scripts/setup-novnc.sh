#!/bin/bash
# setup-novnc.sh — Instala Xvfb + x11vnc + noVNC na VPS
# Roda UMA VEZ e depois o noVNC fica disponivel na porta 6080

echo "=== Instalando Xvfb, x11vnc e noVNC ==="
apt update
apt install -y xvfb x11vnc novnc websockify

echo ""
echo "=== Criando servicos systemd ==="

# Xvfb — display virtual :99
cat > /etc/systemd/system/xvfb.service << 'SVC'
[Unit]
Description=Xvfb Virtual Display
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x768x24 -ac
Restart=always
[Install]
WantedBy=multi-user.target
SVC

# x11vnc — expoe o display via VNC
cat > /etc/systemd/system/x11vnc.service << 'SVC'
[Unit]
Description=x11vnc VNC Server
After=xvfb.service
Requires=xvfb.service
[Service]
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -nopw -rfbport 5900
Restart=always
[Install]
WantedBy=multi-user.target
SVC

# noVNC — proxy web na porta 6080
cat > /etc/systemd/system/novnc.service << 'SVC'
[Unit]
Description=noVNC Web Client
After=x11vnc.service
Requires=x11vnc.service
[Service]
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ 6080 localhost:5900
Restart=always
[Install]
WantedBy=multi-user.target
SVC

echo ""
echo "=== Iniciando servicos ==="
systemctl daemon-reload
systemctl enable xvfb x11vnc novnc
systemctl start xvfb x11vnc novnc

echo ""
echo "=== Liberando porta 6080 ==="
ufw allow 6080

echo ""
echo "=== Verificando ==="
systemctl status xvfb x11vnc novnc --no-pager

echo ""
echo "================================="
echo "  noVNC pronto!"
echo "  Acesse: http://SEU_IP:6080/vnc.html"
echo "================================="
