# Implantação — HubLabel (sem n8n)

Tudo roda a partir de **uma imagem Docker**, gerada automaticamente a cada push na `main`:

```
ghcr.io/victoreder/hublabel-disparador:latest
```

A mesma imagem sobe **3 serviços**, mudando só o comando:

| Serviço | Comando | Função | Porta | Domínio |
|---|---|---|---|---|
| `disparador-meta` | *(padrão)* `node src/index.js` | Fila de disparos da API Oficial (Meta) | 3080 (só health) | não |
| `disparador-evolution` | `node src/workers/evolution.js` | Fila de disparos Evolution (individual/grupos) | — | não |
| `disparador-inbound` | `node src/inbound.js` | **Telas do sistema**, ações, webhooks Meta/Evolution, agente IA | 3090 | **sim** |

O n8n deixa de ser necessário para o sistema: telas, cadastro, upload, IA, página de vendas, personalização, webhook de leads (`/token`) e integração de pagamento (`/integracao`) estão no `disparador-inbound`.

---

## 1. Antes de subir (uma vez)

### 1.1 Banco (Supabase)
Rode **`scripts/migracao-n8n-telas-acoes.sql`** no *SQL Editor* do Supabase. Ele cria:
- `SAAS_Personalizacao` — nome, cor, telefone de suporte, logo e favicon (white-label);
- `SAAS_PaginaVendas` — HTML da página de vendas (`/pv`);
- 3 funções `f_hub_*` usadas pelo backend (envio de template, webhook de leads).

É idempotente: pode rodar de novo sem problema.

### 1.2 Supabase Auth
Em *Authentication → Rate Limits*: o login agora passa pelo servidor, então **todas as tentativas de login chegam ao Supabase com o IP da VPS**. Se muitos clientes logam ao mesmo tempo, aumente o limite de *sign-in* (ex.: 300 por 5 min).

### 1.3 Dados que você vai precisar
| O quê | Onde pegar |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → *Project Settings → API* |
| `EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY` | Sua Evolution API (apikey global) |
| `S3_*` | Seu MinIO/S3 (o mesmo que o n8n usava: bucket `n8n`) |
| `REDIS_URL` | Redis já existente na rede (ex.: `redis://redis:6379`) |
| Domínio | O domínio do sistema (hoje `webhook2.victoreder.com.br`) |

> Recomendado: troque a `service_role` do Supabase — a atual estava em texto puro no workflow do n8n.

---

## 2. Portainer (Docker Swarm + Traefik)

1. **Desligue o roteamento do n8n para o domínio do sistema.** O n8n e o inbound não podem ter um router Traefik para o mesmo `Host`. Se o n8n ainda for usado para outras coisas, deixe-o em outro domínio (ex.: `n8n2...`) e tire o domínio do sistema do router dele.
2. *Stacks → Add stack* (ou edite a stack atual) e cole **`portainer-stack.example.yml`**.
3. Troque o que está em MAIÚSCULAS. As variáveis repetidas (Supabase/Evolution) ficam no topo do arquivo, nas âncoras `x-supabase-env` e `x-evolution-env` — edite só ali.
4. *Deploy the stack*. Para atualizar depois: *Update the stack* com **Re-pull image** marcado.

### O que mudou no Traefik
Antes eram vários routers por caminho (`/webhook/meta-token`, `/webhook/eventsmeta`...) com StripPrefix. **Agora é um router só**, com o domínio inteiro:

```yaml
- traefik.http.routers.disparador_inbound.rule=Host(`SEU-DOMINIO`)
- traefik.http.routers.disparador_inbound.entrypoints=websecure
- traefik.http.routers.disparador_inbound.tls.certresolver=letsencryptresolver
- traefik.http.services.disparador_inbound.loadbalancer.server.port=3090
```

Não precisa de StripPrefix: o próprio app remove o caminho do `BACK_URL` (`/webhook`). Todas as URLs antigas continuam iguais (`https://dominio/webhook/login`, `/webhook/eventsmeta`, `/webhook/agente-no-whatsapp`...). Acessar só `https://dominio/` redireciona para o login.

---

## 3. Variáveis de ambiente

### Obrigatórias
| Variável | Serviços | Exemplo |
|---|---|---|
| `SUPABASE_URL` | todos | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | todos | `eyJ...` ou `sb_secret_...` |
| `EVOLUTION_BASE_URL` | evolution, inbound | `https://evolution2.victoreder.com.br` |
| `EVOLUTION_API_KEY` | evolution, inbound | apikey global da Evolution |
| `SUPABASE_ANON_KEY` | inbound | `eyJ...` (anon / publishable) |
| `BACK_URL` | inbound | `https://dominio/webhook` |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | inbound | MinIO/S3 |
| `REDIS_URL` | inbound | `redis://redis:6379` |

### Opcionais (inbound) — valores padrão entre parênteses
| Variável | Para quê |
|---|---|
| `S3_BUCKET` (`n8n`) | Bucket dos uploads |
| `HUB_API_KEY` (vazia) | Integração externa chamar rotas de admin com header `x-api-key` |
| `CADASTRO_GRATIS_ATIVO` (`true`), `PLANO_GRATIS_ID` (`2`), `PLANO_GRATIS_DIAS` (`2`) | Cadastro grátis em `/cadastrar` |
| `SENHA_PADRAO_INTEGRACAO` (`Padrao123456`) | Senha dos usuários criados pela integração de pagamento |
| `OPENAI_MODEL_PAGINA_VENDAS` (`gpt-5.3-codex`) | Modelo da IA que edita a página de vendas |
| `LOGIN_MAX_FALHAS` (5), `LOGIN_JANELA_MIN` (15), `LOGIN_BLOQUEIO_MIN` (15), `LOGIN_LIMITE_IP_MINUTO` (10) | Bloqueio de login |
| `JAIL_LIMITE_PONTOS` (30), `JAIL_JANELA_MIN` (10), `JAIL_BAN_MIN` (60) | Ban automático de IP ("fail2ban") |
| `SEGURANCA_IPS_LIBERADOS` | IPs nunca limitados/banidos (separados por vírgula) |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` se usar Cloudflare na frente |
| `API_LIMITE_MINUTO` (300), `IA_LIMITE_MINUTO` (10), `IA_CONCORRENCIA` (4), `UPLOAD_LIMITE_MINUTO` (30), `UPLOAD_CONCORRENCIA` (3), `UPLOAD_MAX_FILE_BYTES` (50 MB), `TESTE_EMAIL_LIMITE_HORA` (20), `CADASTRO_GRATIS_LIMITE_HORA` (5), `WEBHOOK_ENTRADA_LIMITE_MINUTO` (120) | Limites |
| `SOBRECARGA_LAG_MS` (250) | Acima disso o servidor recusa (503) o que não é essencial |
| `CORS_ORIGENS` | Outros domínios que podem chamar as ações pelo navegador |

---

## 4. Conferir depois de subir

1. `https://dominio/webhook/health` → `{"ok":true,...}`.
2. Abrir `https://dominio/webhook/login` e entrar. Se a tela abre mas o login falha, confira `SUPABASE_ANON_KEY`.
3. Logs do `disparador-inbound`:
   - `[paginas] telas registradas {"total":25,...}`;
   - **não** pode aparecer `SUPABASE_ANON_KEY ausente`;
   - nas linhas `[inbound] http` / `[rate-limit]`, os IPs devem ser **públicos e variados**. Se for sempre `10.x`/`172.x`, o Traefik não está repassando o IP real e os limites por IP não funcionam.
4. No admin: salvar a Personalização e ver o nome/cor mudarem ao recarregar qualquer tela.
5. Meta: o webhook continua `https://dominio/webhook/eventsmeta` (nada a mudar no painel da Meta).

---

## 5. EasyPanel

Funciona. O EasyPanel também roda Docker com Traefik por baixo; a diferença é que cada serviço é configurado pela interface em vez de um YAML.

No projeto, crie **3 serviços do tipo *App***:

| App | Source → *Docker Image* | Deploy → *Command* | Domínio |
|---|---|---|---|
| `disparador-meta` | `ghcr.io/victoreder/hublabel-disparador:latest` | *(vazio)* | nenhum |
| `disparador-evolution` | mesma imagem | `node src/workers/evolution.js` | nenhum |
| `disparador-inbound` | mesma imagem | `node src/inbound.js` | `seu-dominio` → porta **3090**, HTTPS ligado |

Em cada App, aba *Environment*, cole as variáveis da seção 3 (formato `NOME=valor`, uma por linha).

- **Redis**: crie um serviço *Redis* no mesmo projeto e use a URL interna que o EasyPanel mostra (algo como `redis://default:SENHA@projeto_redis:6379`) em `REDIS_URL`.
- **Domínio**: em *Domains* do `disparador-inbound`, aponte o domínio inteiro (path `/`) para a porta 3090. Não configure path `/webhook` — o app trata isso sozinho.
- **Atualizar**: botão *Deploy* do App puxa a imagem `latest` de novo. Também dá para usar *Source → GitHub* (o EasyPanel builda o `Dockerfile` do repositório a cada push), mas aí o repositório precisa estar conectado ao EasyPanel e cada App builda a imagem separadamente — com a imagem pronta do GHCR é mais rápido.
- **Recursos**: em *Resources* do inbound, deixe ao menos 1 GB de memória.
