// Telas reais do sistema dentro do vídeo.
// Cada tela é um HTML capturado de public/pages (telas/capturar.mjs) e carregado num <iframe>
// da mesma origem; o vídeo anima o DOM dessa tela (sem transições CSS, tudo função de t).
(function () {
  /** Cria a moldura (janela arredondada) com a tela dentro. Retorna { box, frame, doc, scale, x, y }. */
  async function tela(container, src, { x = 180, y = 180, w = 1560, vw = 1600, vh = 900, id } = {}) {
    const scale = w / vw;
    const box = document.createElement('div');
    box.className = 'tela-box';
    if (id) box.id = id;
    box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${Math.round(vh * scale)}px;border-radius:22px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 60px 140px rgba(0,0,0,.6),0 0 120px rgba(37,211,102,.10);transform-origin:50% 50%;`;
    const frame = document.createElement('iframe');
    frame.style.cssText = `position:absolute;left:0;top:0;width:${vw}px;height:${vh}px;border:0;transform:scale(${scale});transform-origin:0 0;pointer-events:none;`;
    frame.setAttribute('scrolling', 'no');
    box.appendChild(frame);
    container.appendChild(box);
    await new Promise((ok) => { frame.onload = ok; frame.src = src; });
    const doc = frame.contentDocument;
    await doc.fonts.ready;
    // garante que as fontes de ícones carregaram antes de medir qualquer coisa
    await Promise.all([...doc.fonts].map((f) => f.load().catch(() => null)));
    return { box, frame, doc, win: frame.contentWindow, scale, x, y, w, h: Math.round(vh * scale) };
  }

  /** Retângulo de um elemento da tela em coordenadas do palco (1920×1080). */
  function rectOn(t, el) {
    const r = el.getBoundingClientRect();
    return { x: t.x + r.left * t.scale, y: t.y + r.top * t.scale, w: r.width * t.scale, h: r.height * t.scale };
  }
  /** Ponto (fx, fy ∈ 0..1) de um elemento da tela em coordenadas do palco. */
  function pointOn(t, el, fx = 0.5, fy = 0.5) {
    const r = rectOn(t, el);
    return [r.x + r.w * fx, r.y + r.h * fy];
  }
  /** Posição relativa a um ancestral, via getBoundingClientRect (layout da própria tela). */
  function relTo(el, anc) {
    const a = anc.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - a.left + anc.scrollLeft, y: r.top - a.top + anc.scrollTop, w: r.width, h: r.height };
  }
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }

  /** Troca entre estados (telas capturadas) com um corte suave: só um visível por vez. */
  function showOnly(list, idx, t, t0, d = 0.18) {
    list.forEach((tl, i) => {
      const on = i === idx;
      const prev = i === idx - 1;
      let o = on ? M.eOut(M.prog(t, t0, t0 + d)) : 0;
      if (prev && t < t0 + d) o = 1;
      tl.box.style.visibility = o > 0 ? 'visible' : 'hidden';
      tl.box.style.opacity = on ? Math.max(o, t0 <= 0 ? 1 : o).toFixed(3) : prev && t < t0 + d ? '1' : '0';
      tl.box.style.zIndex = on ? 2 : 1;
    });
  }

  window.MT = { tela, rectOn, pointOn, relTo, setText, showOnly };
})();
