// Biblioteca dos vídeos: tudo aqui é função pura do tempo t (segundos).
// Nada de transitions/animations CSS: o renderizador pede quadros fora de ordem.
(function () {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const prog = (t, a, b) => (a === Infinity ? 0 : b <= a ? (t >= a ? 1 : 0) : clamp((t - a) / (b - a)));
  const eOut = (p) => 1 - Math.pow(1 - p, 3);
  const eIn = (p) => p * p * p;
  const eInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const eBack = (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };

  /** Fator de presença: sobe em [tIn, tIn+dIn], desce em [tOut, tOut+dOut]. */
  const win = (t, tIn, tOut = Infinity, dIn = 0.4, dOut = 0.35) =>
    eOut(prog(t, tIn, tIn + dIn)) * (1 - eIn(prog(t, tOut, tOut + dOut)));

  const set = (el, o, tr) => {
    el.style.opacity = o.toFixed(3);
    if (tr !== undefined) el.style.transform = tr;
    el.style.visibility = o <= 0.001 ? 'hidden' : 'visible';
  };

  /** Entrada com "pop" (escala com overshoot) e saída opcional. */
  function pop(el, t, tIn, { tOut = Infinity, d = 0.45, from = 0.7, y = 24, x = 0, extra = '' } = {}) {
    const p = prog(t, tIn, tIn + d);
    const s = lerp(from, 1, eBack(p));
    const o = eOut(prog(t, tIn, tIn + d * 0.6)) * (1 - eIn(prog(t, tOut, tOut + 0.3)));
    set(el, o, `translate(${x * (1 - eOut(p))}px, ${y * (1 - eOut(p))}px) scale(${s}) ${extra}`);
    return p;
  }

  /** Título em que cada palavra sobe em sequência. Palavras: <span class="word">. */
  function headline(root, t, tIn, { tOut = Infinity, stagger = 0.07, d = 0.55, y = 50 } = {}) {
    const words = root.querySelectorAll('.word');
    words.forEach((w, i) => {
      const p = eOut(prog(t, tIn + i * stagger, tIn + i * stagger + d));
      const o = p * (1 - eIn(prog(t, tOut, tOut + 0.35)));
      w.style.opacity = o.toFixed(3);
      w.style.transform = `translateY(${(1 - p) * y}px)`;
      w.style.filter = `blur(${((1 - p) * 8).toFixed(1)}px)`;
    });
  }
  /** Quebra o texto de um elemento em .word (preserva <span class="hl">). */
  function splitWords(root) {
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(' '));
            else { const s = document.createElement('span'); s.className = 'word'; s.textContent = part; frag.appendChild(s); }
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && !n.classList.contains('word')) walk(n);
      });
    };
    walk(root);
  }

  /** Digitação: mostra text.slice(0, n) com cursor piscando enquanto digita. */
  function type(el, text, t, tIn, cps = 32, { caret = true, keepCaret = false } = {}) {
    const n = Math.floor(clamp((t - tIn) * cps, 0, text.length));
    const typing = t >= tIn && (n < text.length || keepCaret);
    const blink = Math.floor(t * 2.2) % 2 === 0;
    const c = caret && typing && (n < text.length || blink) ? '<span class="caret"></span>' : '';
    const html = escapeHtml(text.slice(0, n)) + c;
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
    return n / text.length;
  }
  const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /** Posição de el relativa a um ancestral posicionado (ignora transforms). */
  function offsetIn(el, container) {
    let x = 0, y = 0, n = el;
    while (n && n !== container) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  /** Caminho do cursor: keys = [[t, x, y, clique?], ...]. Retorna {x, y, click} */
  function cursorAt(keys, t) {
    let k = 0;
    while (k < keys.length - 1 && t >= keys[k + 1][0]) k++;
    const a = keys[k], b = keys[Math.min(k + 1, keys.length - 1)];
    const p = a === b ? 1 : eInOut(prog(t, a[0], b[0]));
    let click = 0;
    keys.forEach((kk) => { if (kk[3]) { const d = t - kk[0]; if (d >= 0 && d < 0.45) click = Math.max(click, 1 - d / 0.45); } });
    return { x: lerp(a[1], b[1], p), y: lerp(a[2], b[2], p), click };
  }
  function renderCursor(el, keys, t, show = 1) {
    const c = cursorAt(keys, t);
    el.style.transform = `translate(${c.x}px, ${c.y}px) scale(${1 - c.click * 0.12})`;
    el.style.opacity = show.toFixed(3);
    const ring = el.querySelector('.ring');
    if (ring) { ring.style.opacity = (c.click * 0.9).toFixed(3); ring.style.transform = `scale(${1.6 - c.click * 0.9})`; }
    return c;
  }

  /**
   * Celular: itens de conversa empilhados de baixo para cima.
   * items = [{ el, tIn, tOut? }]; a conversa "rola" conforme entram mensagens.
   */
  function buildPhone(feed, items, gap = 8) {
    items.forEach((it) => { it.h = it.el.offsetHeight; });
    return { feed, items, gap, viewH: feed.clientHeight };
  }
  function showItems(ph, t) {
    let y = 0;
    const pos = ph.items.map((it) => {
      const tOut = it.tOut ?? Infinity;
      const pres = eOut(prog(t, it.tIn, it.tIn + 0.35)) * (1 - eOut(prog(t, tOut, tOut + 0.3)));
      const at = y;
      y += (it.h + ph.gap) * pres;
      return { at, pres };
    });
    const scroll = Math.max(0, y + 10 - ph.viewH);
    ph.items.forEach((it, i) => {
      const { at, pres } = pos[i];
      const p = prog(t, it.tIn, it.tIn + 0.4);
      const fromRight = it.el.dataset.side === 'out';
      const s = lerp(0.82, 1, eBack(p));
      it.el.style.transformOrigin = fromRight ? '100% 100%' : '0% 100%';
      set(it.el, pres, `translateY(${at - scroll + (1 - eOut(p)) * 14}px) scale(${s})`);
    });
    return { scroll, contentH: y };
  }

  // Ícones (traço 24×24, estilo lucide), embutidos para não depender de rede.
  const P = {
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1.3" fill="currentColor"/><circle cx="15" cy="14" r="1.3" fill="currentColor"/><path d="M2 13v3M22 13v3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
    input: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 10v4M17 10h-4"/>',
    userCheck: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m16 11 2 2 4-4"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    sitemap: '<rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v5M5 17v-3h14v3"/>',
    columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
    sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 3v4M17 5h4"/>',
    clip: '<path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    chevDown: '<path d="m6 9 6 6 6-6"/>',
    arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checks: '<path d="M2 12.5 6.5 17 15 7.5"/><path d="M10 15.5 11.5 17 20 7.5"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
    play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M17 21h4v-4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    contacts: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    dots: '<circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    whatsapp: '<path d="M3 21l1.6-4.6A9 9 0 1 1 8 19.7z"/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-1 1c-1.2-.5-2.4-1.7-2.9-2.9l1-1-1-2z" fill="currentColor" stroke="none"/>',
    receipt: '<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    pix: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/><path d="M7.5 12 12 7.5 16.5 12 12 16.5z"/>',
  };
  function icon(name, cls = '', sw = 2) {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  }
  /** Substitui <i data-ic="nome"></i> por SVG. */
  function hydrateIcons(root = document) {
    root.querySelectorAll('i[data-ic]').forEach((i) => {
      const st = i.getAttribute('style');
      i.outerHTML = icon(i.dataset.ic, i.className, i.dataset.sw || 2).replace('<svg ', `<svg ${st ? `style="${st}" ` : ''}${i.id ? `id="${i.id}" ` : ''}`);
    });
  }

  /** Forma de onda determinística para notas de voz. */
  function buildWave(el, n = 34, seed = 7) {
    let s = seed;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    el.innerHTML = Array.from({ length: n }, (_, i) => {
      const env = Math.sin((i / n) * Math.PI) * 0.6 + 0.4;
      return `<b style="height:${Math.round(5 + rnd() * 22 * env)}px"></b>`;
    }).join('');
  }
  function renderWave(el, p) {
    const bars = el.children, on = Math.round(p * bars.length);
    for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('on', i < on);
  }

  window.M = { clamp, lerp, prog, eOut, eIn, eInOut, eBack, win, set, pop, headline, splitWords, type, offsetIn,
    cursorAt, renderCursor, buildPhone, showItems, icon, hydrateIcons, buildWave, renderWave };
})();
