# Motion graphics em código

Os vídeos institucionais e de anúncio são feitos só com código. Cada vídeo é uma página HTML em que a animação é uma função pura do tempo (`window.render(t)`). O Chromium (Playwright) captura a página quadro a quadro e o ffmpeg monta o MP4. A trilha e os efeitos são sintetizados com numpy (`sfx.py`), sem bancos de áudio.

```
render.mjs              # renderizador genérico (Playwright + ffmpeg)
assets/motion-base.css  # tokens, tipografia, pílulas, legendas, celular estilo WhatsApp
assets/motion-lib.js    # easing, pop/headline, digitação, cursor, buildPhone/showItems, cenas, contador, ícones
assets/motion-app.css   # peças do sistema (janela, sidebar, cards, kanban) para os vídeos de funcionalidade
assets/plus-jakarta-sans.woff2  # fonte do sistema (OFL), local para não depender de rede
sfx.py                  # instrumentos/efeitos sintetizados + Mix + groove() (trilha padrão)
anuncio-agente-ia.html  # vídeo do Agente de IA (cenas + render(t))
sons_agente-ia.py       # trilha do vídeo, com os tempos espelhando o HTML
ROTEIRO-agente-ia.md    # roteiro, tabela de tempos e cuidados de copy
anuncio-disparos.html / sons_disparos.py        → hublabel-disparos.mp4
anuncio-crm.html / sons_crm.py                  → hublabel-crm.mp4
anuncio-atendimento.html / sons_atendimento.py  → hublabel-atendimento.mp4
anuncio-admin.html / sons_admin.py              → hublabel-admin.mp4
hublabel-agente-ia.mp4  # saída
```

## Telas reais do sistema

Os vídeos de Disparos, CRM, Multiatendimento e Painel administrativo mostram as **telas reais** de `public/pages`, não recriações.
`telas/capturar.mjs` abre cada página com os scripts dela, troca o Supabase por um falso
(`telas/fake-supabase.js`) que responde com os dados de exemplo de `telas/dados/*.js`, executa um preparo
(`telas/preparo/*.js`: abrir conversa, modal, aba…) e salva o HTML resultante, sem scripts, com fontes locais
(`telas/vendor`) e sem transições. O vídeo carrega essas telas em `<iframe>` (`assets/motion-tela.js`) e anima o
DOM delas: move os cards reais, troca de estado no clique, preenche selects, rola modais.

Quando o front mudar, recapture tudo:

```bash
bash telas/capturar.sh ../public/pages
```

Páginas com Tailwind (Play CDN) são compiladas automaticamente com o `tailwind.config` da própria página.
Para capturar com a marca de um revendedor (white-label), use `HUB_COR=7C3AED HUB_NOME="Aurora CRM"`.

Para descobrir o que uma tela consulta, rode `node telas/capturar.mjs <pasta> <pagina> <dados.js> <preparo.js> <saida.html> --log`.

## Renderizar

Requisitos: Node 18+, Python 3 com numpy, ffmpeg e Chromium do Playwright.

```bash
cd motion
npm install            # só o playwright
python3 sons_agente-ia.py
node render.mjs anuncio-agente-ia.html hublabel-agente-ia.mp4 --audio sons_agente-ia.wav

# Para conferir quadros estáticos sem renderizar tudo:
node render.mjs anuncio-agente-ia.html quadros --frames 4.4,10.9,25.3,33.4
```

Os outros vídeos seguem o mesmo padrão: `python3 sons_<nome>.py && node render.mjs anuncio-<nome>.html hublabel-<nome>.mp4 --audio sons_<nome>.wav`.

Para mudar o tempo de uma cena, altere o objeto `T` no HTML **e** o dicionário `T` em `sons_agente-ia.py`.
