#!/bin/bash
# Se mueve a la carpeta donde está este archivo, sin importar desde dónde se abra
cd "$(dirname "$0")"

PORT=8000

echo "======================================"
echo " Mundrabilla Roadhouse Roster Optimizer"
echo "======================================"
echo ""
echo "Iniciando servidor local en el puerto $PORT..."
echo "NO cierres esta ventana mientras uses la app."
echo ""

# Abre el navegador después de una breve pausa (para dar tiempo al servidor)
( sleep 1.5 && open "http://localhost:$PORT" ) &

# Intenta con python3, si no existe prueba con python
if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server $PORT
elif command -v python >/dev/null 2>&1; then
    python -m http.server $PORT
else
    echo "No se encontró Python instalado en este Mac."
    echo "Instala Python desde https://www.python.org/downloads/ e intenta de nuevo."
    read -p "Presiona Enter para cerrar..."
fi
