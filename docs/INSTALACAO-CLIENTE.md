# HubLabel Disparador — Instalação

Você vai precisar de:

- VPS com **Docker Swarm + Portainer + Traefik** já funcionando
- Seu projeto **Supabase** (URL e `service_role` key)
- O **e-mail usado na compra** (ele é a sua licença)

> A licença vale para **uma instalação**. Ela fica vinculada ao seu Supabase na primeira vez que o
> sistema sobe. Para mudar de Supabase, fale com o suporte.
> Trocar só de VPS, mantendo o mesmo Supabase, não exige nada.

## 1. Criar a stack

No Portainer → **Stacks → Add stack**, cole o modelo `portainer-stack.example.yml` que você recebeu.

Em **cada um dos 3 serviços** (`disparador-meta`, `disparador-evolution`, `disparador-inbound`), preencha:

```yaml
    environment:
      SUPABASE_URL: https://SEU-PROJETO.supabase.co
      SUPABASE_SERVICE_ROLE_KEY: sua_service_role_key
      LICENCA_EMAIL: seu-email@da-compra.com    # o e-mail usado na compra
```

Ajuste também:

- `networks`: o nome da rede do seu Traefik (no modelo: `RedeVictor`)
- os `Host(...)` do Traefik e a `BACK_URL` do serviço inbound: seu domínio de webhook
- Evolution e S3: os dados dos seus serviços

A imagem `ghcr.io/victoreder/hublabel-disparador:latest` é baixada sem precisar de login.

## 2. Subir e conferir

Clique em **Deploy the stack**. Nos logs de cada serviço (Portainer → Services → Logs) deve aparecer:

```
[INFO] Licença validada {"cliente":"...","servico":"meta"}
```

## Problemas comuns

| Mensagem no log | O que fazer |
|-----------------|-------------|
| `defina LICENCA_EMAIL` | Faltou a variável em algum dos 3 serviços. |
| `e-mail sem licença cadastrada` | Use exatamente o e-mail da compra. Se estiver certo, fale com o suporte. |
| `licença já ativada em outra instalação` | A licença já está em uso com outro Supabase. Fale com o suporte para transferir. |
| `licença suspensa` / `revogada` / `expirada` | Fale com o suporte. |
| `Servidor de licenças indisponível — nova tentativa em 30s` | A VPS precisa acessar a internet (HTTPS de saída). O sistema tenta de novo sozinho. |

## Atualizações

Portainer → Stack → **Update the stack** com **Re-pull image** marcado.
A licença continua a mesma.
