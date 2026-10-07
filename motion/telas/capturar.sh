#!/usr/bin/env bash
# Recaptura todas as telas reais usadas nos vídeos a partir de public/pages do sistema.
# Uso: bash telas/capturar.sh <pasta com as páginas, ex.: ../public/pages>
set -euo pipefail
SRC=$(cd "${1:?informe a pasta public/pages}" && pwd)
cd "$(dirname "$0")/.."
TAM=""
cap() { node telas/capturar.mjs "$SRC" "$1" "$2" "$3" "$4" $TAM; }
# Tailwind das telas que usam o Play CDN: compila com a mesma configuração da página
tw() { TW_CONTENT="$SRC/$1" npx -y tailwindcss@3.4.17 -c telas/libs/tailwind.config.js -i telas/libs/tailwind.in.css -o "telas/libs/tw-${1%.html}.css" >/dev/null 2>&1; }
B=telas/dados/base.js
mkdir -p telas/crm telas/chat telas/disparos

# CRM (1600×900)
cap "crm-etapas.html?quadroId=1" $B,telas/dados/crm.js telas/preparo/crm-quadro.js telas/crm/quadro.html

# Chat / multiatendimento (1366×768)
TAM="--w 1366 --h 768"
C=$B,telas/dados/chat.js
CC=$C,telas/dados/chat-carla.js
for s in aberto aguardando filtro detalhes transferir; do cap chat.html $C telas/preparo/chat-$s.js telas/chat/$s.html; done
cap chat.html $CC telas/preparo/chat-transferido.js telas/chat/transferido.html
cap chat.html $CC telas/preparo/chat-respostas.js telas/chat/respostas.html
cap chat.html $CC,telas/dados/chat-carla-respondeu.js telas/preparo/chat-enviada.js telas/chat/enviada.html
cap chat.html $C telas/preparo/chat-ia.js telas/chat/ia.html
cap chat.html $C,telas/dados/chat-ana-assumiu.js telas/preparo/chat-assumiu.js telas/chat/assumiu.html

# Disparos (1366×768)
K=$B,telas/dados/contatos.js
cap contatos.html $K telas/preparo/contatos-csv.js telas/disparos/contatos-csv.html
cap contatos.html $K telas/preparo/nada.js telas/disparos/contatos.html
cap disparos-apioficial.html $K,telas/dados/disparo-api.js telas/preparo/api-destino.js telas/disparos/api-destino.html
cap disparos-apioficial.html $K,telas/dados/disparo-api.js telas/preparo/api-template.js telas/disparos/api-template.html
cap disparos.html $K,telas/dados/disparos-lista.js telas/preparo/disparos-editar.js telas/disparos/editar.html
tw detalhes-disparo.html
TW_CSS=telas/libs/tw-detalhes-disparo.css cap "detalhes-disparo.html?id=1" $B,telas/dados/disparo-detalhes.js telas/preparo/nada.js telas/disparos/detalhes.html
