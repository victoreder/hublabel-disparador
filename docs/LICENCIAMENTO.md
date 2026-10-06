# Licenciamento — guia do vendedor (uso interno, não envie ao cliente)

## Como funciona

```
Repositório GitHub (PRIVADO)  ── só você vê o código-fonte
        │ push na main
        ▼
GitHub Actions: bundle + ofuscação + chave pública/URL de licença embutidas
        │
        ▼
ghcr.io/victoreder/hublabel-disparador:latest (package PÚBLICO)
        │ cliente puxa a imagem sem token, mas ela não roda sem licença
        ▼
VPS do cliente ──► POST /v1/validar ──► Servidor de licenças (SEU, licenca.seudominio)
   LICENCA_CHAVE + LICENCA_EMAIL          confere chave + e-mail + instalação
                                          responde ASSINADO (Ed25519)
```

- **Repositório privado:** ninguém vê nem clona o fonte. A imagem contém só o código empacotado e ofuscado.
- **Package da imagem público:** o cliente instala no Portainer sem token do GitHub. A visibilidade do
  package é independente da do repositório.
- **1 licença = 1 instalação.** Na primeira validação, a licença é amarrada ao **Supabase do cliente**
  (hash do host do `SUPABASE_URL`). Qualquer outra instalação com a mesma chave é recusada:
  *"licença já ativada em outra instalação"*. O sistema inteiro depende desse banco, então
  copiar a chave para outro servidor com outro Supabase não funciona.
- **Respostas assinadas:** a imagem só aceita respostas assinadas com a sua chave privada. Apontar
  para um servidor falso ou adulterar a resposta não funciona.
- **Revalidação a cada 6h.** Se você revogar ou suspender a licença, os containers do cliente param
  na próxima revalidação (ou no próximo restart).
- **Tolerância:** se o *seu* servidor de licenças cair, o cliente segue rodando por até `GRACE_HOURS`
  (padrão 72h) desde a última validação. Ele não cai por causa de uma queda sua.

> **Limite honesto:** nenhuma proteção em JavaScript é inquebrável. Com tempo e conhecimento, alguém
> pode desofuscar o código e remover a trava. O objetivo é tornar a cópia trabalhosa demais para
> valer a pena, e saber quem está usando o quê (tabela `licenca_eventos`). O contrato de licença
> com o cliente continua sendo a proteção jurídica.

---

## Configuração (uma vez só, nesta ordem)

> ⚠️ **Antes de fazer merge disto na `main`:** a próxima imagem `latest` passa a exigir licença.
> As **suas próprias** instalações também. Siga os passos 1 a 6 antes de atualizar as suas stacks.

### 1. Gerar o par de chaves

```bash
cd license-server
node scripts/gerar-chaves.js
```

Ele imprime duas linhas base64:

- **LICENSE_PUBLIC_KEY** → vai para o GitHub (passo 3)
- **LICENSE_PRIVATE_KEY** → vai **somente** para a stack do servidor de licenças (passo 4). Guarde uma
  cópia em local seguro (gerenciador de senhas). Se perder, terá de gerar outro par, e todas as imagens já
  distribuídas param de validar até o cliente atualizar a imagem.

### 2. Criar as tabelas no SEU Supabase

Use o seu Supabase, não o de um cliente. No SQL Editor, rode `license-server/sql/001_licencas.sql`.

### 3. Variáveis no GitHub

Repositório → **Settings → Secrets and variables → Actions → aba Variables → New repository variable**:

| Nome | Valor |
|------|-------|
| `LICENSE_PUBLIC_KEY` | linha da chave pública do passo 1 |
| `LICENSE_SERVER_URL` | URL pública do servidor de licenças, ex.: `https://licenca.victoreder.com.br` |

> A `LICENSE_SERVER_URL` fica gravada dentro das imagens vendidas. Escolha um domínio que você vai manter.

### 4. Subir o servidor de licenças

1. Faça merge na `main` → o workflow **Build License Server Image** publica `ghcr.io/victoreder/hublabel-licenca`.
2. GitHub → seu perfil → **Packages → hublabel-licenca** → confirme que está **Private**.
3. Portainer → **Registries** → adicione `ghcr.io` com seu usuário GitHub e um token com `read:packages`.
4. Crie a stack com `license-server/portainer-stack.example.yml` (ajuste domínio, Supabase,
   `LICENSE_PRIVATE_KEY` e `ADMIN_TOKEN`).
5. Teste: `https://licenca.seudominio/health` → `{"ok":true}`.

### 5. Deixar o repositório privado e manter a imagem pública

1. GitHub → repositório **hublabel-disparador** → **Settings → General → Danger Zone → Change visibility → Private**.
2. GitHub → **Packages → hublabel-disparador → Package settings → Danger Zone → Change visibility → Public**.
   Confira se continua **Public** depois do passo anterior.
3. Opcional, mas recomendado: o fonte já ficou exposto enquanto o repositório era público, então
   versões antigas da imagem (sem trava) continuam baixáveis por tag/sha. Em **Packages →
   hublabel-disparador → Manage versions**, apague as versões anteriores a esta.

### 6. Criar a licença das SUAS instalações e atualizar as suas stacks

Crie uma licença para cada instalação sua (passo abaixo) e adicione `LICENCA_CHAVE` / `LICENCA_EMAIL`
nos 3 serviços das suas stacks **antes** de atualizar para a nova imagem.

---

## Operação do dia a dia

As rotas de administração exigem `Authorization: Bearer SEU_ADMIN_TOKEN`.

### Vender: criar licença

```bash
curl -X POST https://licenca.seudominio/admin/licencas \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"cliente@empresa.com","cliente":"Empresa X","observacao":"pedido #123"}'
```

Retorna a `chave` (ex.: `HL-7K3M-...`). Envie ao cliente a **chave + o e-mail** e o
`docs/INSTALACAO-CLIENTE.md`. Licença com prazo: inclua `"expira_em":"2027-12-31T23:59:59Z"`.

Também dá para criar direto no Table Editor do Supabase (tabela `licencas`). Só a chave precisa
ser única, e o formato é livre.

### Cliente trocou de VPS ou de Supabase

```bash
curl -X POST https://licenca.seudominio/admin/licencas/HL-XXXX-XXXX-XXXX-XXXX/resetar \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

A próxima instalação que validar a chave fica com ela.
No Supabase: limpe `fingerprint`, `instalacao` e `ativada_em`.

> Trocar só de VPS mantendo o mesmo Supabase **não** precisa de reset: a licença segue o Supabase.

### Suspender, revogar ou reativar (ex.: chargeback, inadimplência)

```bash
curl -X POST https://licenca.seudominio/admin/licencas/HL-XXXX-XXXX-XXXX-XXXX/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"revogada"}'      # ou "suspensa" / "ativa"
```

### Listar e auditar

```bash
curl https://licenca.seudominio/admin/licencas -H "Authorization: Bearer $ADMIN_TOKEN"
```

- Na tabela `licencas`: `ultimo_check_em`, `ultimo_ip`, `ultimo_hostname`, `versao` e `instalacao`.
- Na tabela `licenca_eventos`: ativações, recusas (inclusive tentativas de usar a chave em outra
  instalação, com IP) e mudanças de IP. Muitas recusas com IPs diferentes indicam que a chave
  foi compartilhada.

---

## Desenvolvimento

- `npm start`, `npm run dev*` e `npm test` rodam o fonte direto, **sem** licença.
- `npm run build` gera `dist/` ofuscado (precisa de `LICENSE_PUBLIC_KEY` e `LICENSE_SERVER_URL` no ambiente).
- `docker build` local precisa dos build args:

```bash
docker build \
  --build-arg LICENSE_PUBLIC_KEY="..." \
  --build-arg LICENSE_SERVER_URL="https://licenca.seudominio" \
  -t hublabel-disparador .
```
