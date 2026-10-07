import { config } from '../../config.js';
import { ROTAS_PROTEGIDAS } from '../auth/autenticar.js';

/**
 * Script injetado no <head> de cada tela: toda chamada `fetch` para uma rota
 * protegida do backend sai com o header `X-Hub-Session: <token da sessão>`.
 * (Header próprio porque algumas telas já usam `Authorization` para outra
 * coisa — ex.: o PAT do Supabase na sincronização de SMTP.)
 * O token é lido de onde o supabase-js guarda a sessão (localStorage
 * `sb-<ref>-auth-token`). Se o servidor responder 401 (token acabou de
 * expirar), espera o supabase-js renovar e tenta mais uma vez.
 * Assim nenhuma das telas precisou ser alterada.
 */
export function buildAuthScript(backUrl) {
  const ref = new URL(config.supabaseUrl).hostname.split('.')[0];
  const cfg = JSON.stringify({
    key: `sb-${ref}-auth-token`,
    base: backUrl,
    paths: Object.keys(ROTAS_PROTEGIDAS),
  }).replace(/</g, '\\u003c');

  return `<script>(function(){
var C=${cfg};
var base;try{base=new URL(C.base);}catch(e){return;}
var prefixo=base.pathname.replace(/\\/+$/,'');
function protegida(url){try{var u=new URL(url,location.href);if(u.origin!==base.origin)return false;var p=u.pathname;if(prefixo&&p.indexOf(prefixo+'/')===0)p=p.slice(prefixo.length);return C.paths.indexOf(p.replace(/\\/+$/,''))>=0;}catch(e){return false;}}
function token(){try{var s=JSON.parse(localStorage.getItem(C.key)||'null');return (s&&(s.access_token||(s.currentSession&&s.currentSession.access_token)))||null;}catch(e){return null;}}
var original=window.fetch.bind(window);
window.fetch=function(input,init){
var url=typeof input==='string'?input:(input&&input.url)||String(input);
if(!protegida(url))return original(input,init);
function chamar(){var o=Object.assign({},init||{});var h=new Headers(o.headers||(input instanceof Request?input.headers:undefined));var t=token();if(t)h.set('X-Hub-Session',t);o.headers=h;return original(input,o);}
return chamar().then(function(r){if(r.status!==401)return r;return new Promise(function(ok){setTimeout(ok,1500);}).then(chamar);});
};
})();</script>`;
}

/** Coloca o script logo após a abertura do <head> (antes de qualquer outro script). */
export function injectAuthScript(html, script) {
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (!head) return script + html;
  const idx = head.index + head[0].length;
  return html.slice(0, idx) + script + html.slice(idx);
}
