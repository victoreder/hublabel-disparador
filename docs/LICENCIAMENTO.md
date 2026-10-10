# Licenciamento — guia do vendedor (uso interno, não envie ao cliente)

## Como funciona

```
Stack do CLIENTE ──(LICENCA_EMAIL)──► licenca.seudominio ──consulta──► Supabase de LICENÇAS
(usa o Supabase dele)                 (stack no SEU Portainer)          (seu, separado: tabela licencas)
                 ◄──── "liberado" / "bloqueado" (resposta assinada) ────
```

- **Repositório privado:** ninguém vê o código-fonte. A imagem só tem código empacotado e ofuscado.
- **Package da imagem público:** o cliente instala no Portainer sem token do GitHub.
- **Licença = e-mail da compra.** O cliente coloca só `LICENCA_EMAIL` na stack. Se o e-mail estiver na
  tabela `licencas` do seu Supabase de licenças, o sistema libera.
- **1 licença = 1 instalação.** Na primeira validação, a licença fica presa ao **Supabase do cliente**.
  O mesmo e-mail em outra instalação é recusado: *"licença já ativada em outra instalação"*.
- **O link do servidor de licenças vai numa variável do GitHub** (`LICENSE_SERVER_URL`) e fica gravado
  na imagem durante o build. O cliente não configura isso.
- **Revalida a cada 6h.** Revogou, o sistema do cliente para. Se o *seu* servidor de licenças cair,
  o cliente continua rodando por até 72h.

> **Limites:** nenhuma proteção em JavaScript é inquebrável: alguém experiente pode desofuscar e remover
> a trava. E como o e-mail não é segredo, alguém que saiba o e-mail de um comprador poderia ativar a
> licença antes dele; nesse caso você usa o *reset* (abaixo) e o comprador ativa de novo.

---

## Configuração (uma vez só, nesta ordem)

### 1. Gerar as chaves de segurança

No terminal da sua VPS:

```bash
docker run --rm node:22-alpine node -e 'const c=require("crypto");const k=c.generateKeyPairSync("ed25519");console.log("PUBLICA:\n"+Buffer.from(k.publicKey.export({type:"spki",format:"pem"})).toString("base64")+"\n\nPRIVADA:\n"+Buffer.from(k.privateKey.export({type:"pkcs8",format:"pem"})).toString("base64")+"\n\nADMIN_TOKEN:\n"+c.randomBytes(32).toString("hex"))'
```

Guarde os 3 valores (**PUBLICA**, **PRIVADA**, **ADMIN_TOKEN**) num lugar seguro. Não troque depois de
vender: a PUBLICA vai gravada nas imagens.

### 2. Criar o Supabase de licenças

1. supabase.com → **New project** (ex.: `hublabel-licencas`). Projeto **novo**, só para isso.
2. **SQL Editor** → cole o conteúdo de `license-server/sql/001_licencas.sql` → **Run**.
3. **Project Settings → API** → copie a **Project URL** e a **service_role key** (usadas no passo 5).

### 3. Variáveis no GitHub (antes do merge)

Repositório → **Settings** (aba no topo) → menu lateral **Secrets and variables → Actions** →
aba **Variables** → **New repository variable**. Crie duas:

| Nome | Valor |
|------|-------|
| `LICENSE_SERVER_URL` | `https://licenca.SEUDOMINIO.com.br` (o subdomínio que você vai usar no passo 4) |
| `LICENSE_PUBLIC_KEY` | a **PUBLICA** do passo 1 |

### 4. Merge do PR e subdomínio

1. Faça o merge do PR. O GitHub gera **sozinho** as duas imagens: a dos clientes (já com o link e a
   chave pública dentro) e a do servidor de licenças (`ghcr.io/victoreder/hublabel-licenca`).
   Acompanhe na aba **Actions** do repositório (bolinha verde = pronto).
2. No seu DNS, crie um registro **A**: `licenca` → IP da sua VPS.

> ⚠️ Não atualize as **suas** stacks do disparador ainda: a imagem nova já exige licença (passo 6).

### 5. Stack do servidor de licenças no Portainer

**Stacks → Add stack** → nome `hublabel-licenca` → cole `license-server/portainer-stack.example.yml`,
troque domínio, rede, e preencha:

| Variável | Valor |
|----------|-------|
| `LICENCAS_SUPABASE_URL` | Project URL do passo 2 |
| `LICENCAS_SUPABASE_SERVICE_ROLE_KEY` | service_role do passo 2 |
| `LICENSE_PRIVATE_KEY` | **PRIVADA** do passo 1 |
| `ADMIN_TOKEN` | **ADMIN_TOKEN** do passo 1 |

Deploy. Teste: `https://licenca.SEUDOMINIO.com.br/health` → `{"ok":true,...}`.

Se o Portainer não conseguir baixar a imagem: GitHub → **Packages → hublabel-licenca → Package settings →
Change visibility → Public** (não há segredo nela; os segredos ficam nas variáveis da stack).

### 6. Liberar as SUAS instalações

1. Supabase de licenças → **Table Editor → licencas → Insert row** → `email`: o seu e-mail → Save.
   (Uma linha por instalação; cada instalação precisa de um e-mail diferente.)
2. Nas suas stacks do disparador, adicione nos 3 serviços `LICENCA_EMAIL: seu@email.com`.
3. Atualize com **Re-pull image**. No log: `Licença validada`.

### 7. Fechar o repositório

1. GitHub → **Settings → General → Danger Zone → Change visibility → Private**.
2. **Packages → hublabel-disparador → Package settings** → confirme que continua **Public**.
3. Recomendado: em **Manage versions**, apague as versões antigas da imagem (sem trava).

---

## Dia a dia

### Vender (manual ou automático)

Insira uma linha na tabela `licencas` com o `email` do comprador. Só isso. O e-mail é salvo sempre em
minúsculo, então maiúsculas não atrapalham.

Para automatizar pelo checkout (Hotmart, Kiwify, n8n...), faça um `insert` na tabela `licencas`
pela API do Supabase de licenças, ou chame:

```bash
curl -X POST https://licenca.SEUDOMINIO.com.br/admin/licencas \
  -H "Authorization: Bearer SEU_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"cliente@empresa.com","cliente":"Empresa X"}'
```

Campos opcionais: `cliente`, `observacao`, `expira_em` (ex.: `"2027-12-31T23:59:59Z"`; vazio = vitalícia).

### Cliente trocou de Supabase (ou alguém ativou antes dele)

No Table Editor, limpe `fingerprint`, `instalacao` e `ativada_em` da linha dele. Ou:

```bash
curl -X POST https://licenca.SEUDOMINIO.com.br/admin/licencas/cliente@empresa.com/resetar \
  -H "Authorization: Bearer SEU_ADMIN_TOKEN"
```

Trocar só de VPS, mantendo o mesmo Supabase, não precisa de nada.

### Suspender, revogar ou reativar

Mude a coluna `status` para `suspensa`, `revogada` ou `ativa`. Ou:

```bash
curl -X POST https://licenca.SEUDOMINIO.com.br/admin/licencas/cliente@empresa.com/status \
  -H "Authorization: Bearer SEU_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"revogada"}'
```

### Auditar

- `licencas`: `ultimo_check_em`, `ultimo_ip`, `ultimo_hostname`, `versao`, `instalacao`.
- `licenca_eventos`: ativações, recusas (tentativas em outra instalação, com IP) e mudanças de IP.

---

## Desenvolvimento

- `npm start`, `npm run dev*` e `npm test` rodam o fonte direto, **sem** licença.
- `npm run build` gera `dist/` ofuscado (precisa de `LICENSE_PUBLIC_KEY` e `LICENSE_SERVER_URL` no ambiente).
- Para gerar a imagem de novo sem novo commit: aba **Actions** → **Build and Push Docker Image** (lista
  à esquerda) → botão **Run workflow** (à direita) → **Run workflow**.
