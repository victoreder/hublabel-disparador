# Motion graphics em código

Os vídeos institucionais e de anúncio são feitos só com código. Cada vídeo é uma página HTML em que a animação é uma função pura do tempo (`window.render(t)`). O Chromium (Playwright) captura a página quadro a quadro e o ffmpeg monta o MP4. A trilha e os efeitos são sintetizados com numpy (`sfx.py`), sem bancos de áudio.

```
render.mjs              # renderizador genérico (Playwright + ffmpeg)
assets/motion-base.css  # tokens, tipografia, pílulas, legendas, celular estilo WhatsApp
assets/motion-lib.js    # easing, pop/headline, digitação, cursor, buildPhone/showItems, ícones
assets/plus-jakarta-sans.woff2  # fonte do sistema (OFL), local para não depender de rede
sfx.py                  # instrumentos/efeitos sintetizados + Mix
anuncio-agente-ia.html  # vídeo do Agente de IA (cenas + render(t))
sons_agente-ia.py       # trilha do vídeo, com os tempos espelhando o HTML
ROTEIRO-agente-ia.md    # roteiro, tabela de tempos e cuidados de copy
hublabel-agente-ia.mp4  # saída
```

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

Para mudar o tempo de uma cena, altere o objeto `T` no HTML **e** o dicionário `T` em `sons_agente-ia.py`.
