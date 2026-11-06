# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) vindas de múltiplos provedores de jogos, por HTTP e por AWS SQS. Ele continua correto com mensagens duplicadas, entregues fora de ordem ou processadas em paralelo por várias instâncias.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 17 · MikroORM 7 · AWS SQS via LocalStack · Docker Compose · pino · Prometheus

> As decisões técnicas, os trade-offs, a taxonomia de erros e a análise do teste de carga estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Destaques

- **Dinheiro exato**: `Money` sobre `decimal.js`, sempre trafegado como string com escala 2 e persistido em `numeric(20,2)`. Nenhum `number` no caminho do dinheiro.
- **Invariantes no banco**: `CHECK`, `UNIQUE`, índice único parcial e triggers garantem saldo não negativo, ledger append-only e encadeado, coerência entre saldo e ledger no commit (triggers diferidos), estados terminais imutáveis e reversão única.
- **Concorrência**: `SELECT ... FOR UPDATE` por wallet (sem lock global), com `UPDATE ... WHERE version = ?` como segunda barreira e retry limitado.
- **Idempotência persistente**: `Idempotency-Key` com `UNIQUE` no banco, hash SHA-256 do JSON canônico do payload, replay com o saldo observado na época e 409 para payload divergente. Inbox `(consumerName, messageId)` no SQS.
- **Transactional outbox**: eventos gravados na mesma transação SQL do efeito financeiro, publicados por vários workers com `FOR UPDATE SKIP LOCKED` e `SendMessageBatch`.
- **Mensageria resiliente**: ack só depois do commit; erros de negócio, transitórios e permanentes tratados de formas diferentes; backoff, DLQ e shutdown gracioso no `SIGTERM`.
- **Testes reais**: 227 testes. Integração e concorrência rodam contra Postgres e LocalStack em containers, inclusive com 3 processos independentes, `SIGKILL` no meio do fluxo e reinício.

## Requisitos

- [Docker](https://docs.docker.com/get-docker/) com Docker Compose v2
- [Bun](https://bun.sh) 1.x, para rodar os testes e o teste de carga no host

## Subindo o ambiente

```bash
docker compose up -d --build
```

Sobem os seguintes serviços:

| Serviço | Descrição | Porta |
|---|---|---|
| `postgres` | PostgreSQL 17 (bancos `wagering` e `wagering_test`) | `55432` |
| `localstack` | SQS: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` | `4566` |
| `migrate` | aplica as migrations e termina | — |
| `api` | API HTTP | `3000` |
| `worker` ×3 | consumidor SQS, publisher da outbox e resolvedor de referências pendentes | `9100` (interna) |

```bash
curl localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para encerrar: `docker compose down`, ou `docker compose down -v` para apagar também os dados.

## Usando a API

```bash
# 1. Criar uma wallet (gera transação OPENING e lançamento CREDIT no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# 2. Submeter uma aposta
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# Reenviar a mesma requisição -> 200 com "idempotentReplay": true
```

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (409 se já existir para `playerId + currency`) |
| `GET` | `/wallets/:walletId` | consulta saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado com cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | compara o saldo armazenado com o saldo reconstruído do ledger |
| `POST` | `/wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (públicos) |
| `GET` | `/metrics` | métricas Prometheus |

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `WIN` e `LOSS` aceitam essa referência como opcional.

**Status HTTP**: 201 aplicada · 200 replay · 202 aguardando referência · 422 rejeição de negócio (com `failureCode`) · 400 payload inválido · 403 provedor fora do escopo · 409 conflito · 404 inexistente · 503 transitório (`Retry-After`). A tabela completa e os códigos de falha estão no [ARCHITECTURE.md](ARCHITECTURE.md#8-regras-de-negócio-e-interpretações-adotadas).

## Enviando pela fila SQS

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{
    "messageId": "msg-123",
    "type": "WagerTransactionRequested",
    "occurredAt": "2026-07-29T15:00:00.000Z",
    "data": {
      "providerId": "provider-a",
      "externalTransactionId": "transaction-124",
      "idempotencyKey": "provider-a:transaction-124",
      "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      "walletId": "<walletId>",
      "roundId": "round-987",
      "gameId": "fortune-chimp",
      "kind": "BET",
      "money": { "amount": "25.00", "currency": "BRL" }
    }
  }'

docker compose logs -f worker   # logs JSON com correlationId, messageId, transactionId, walletId e providerId
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference` e `WagerTransactionFailed`) são publicados em `wagering-events.fifo`.

## Testes

Os testes de integração e de concorrência usam o Postgres e o LocalStack do Compose (banco `wagering_test` e filas exclusivas criadas por cada teste):

```bash
bun install
docker compose up -d postgres localstack

bun run test               # unitários (domínio, Money, regras, hash)
bun run test:integration   # migrations, constraints, API, atomicidade, inbox, outbox, DLQ, referências
bun run test:concurrency   # corridas reais, 3+ processos, SIGKILL e reinício
bun run test:all           # unitários, integração e concorrência, em sequência
bun run test:resilience    # derruba Postgres e LocalStack de verdade (docker compose stop/pause)
bun run typecheck
```

As suítes de integração, concorrência e resiliência verificam ao final que **todas** as wallets criadas durante a execução têm `saldo == ledger`.

O `test:resilience` fica fora do `test:all` porque para o container do Postgres e congela o do LocalStack durante a execução. Todos os serviços são restaurados ao final, mesmo em caso de falha.

## Teste de carga

```bash
docker compose up -d --build
bun run test:load
```

| Variável | Padrão | Descrição |
|---|---|---|
| `BASE_URLS` | `http://localhost:3000` | uma ou mais APIs separadas por vírgula (round-robin) |
| `DURATION_SECONDS` | `20` | duração de cada cenário |
| `CONCURRENCY` | `32` | clientes concorrentes |
| `WALLETS` | `200` | wallets do cenário *spread* |
| `SCENARIO` | `all` | `spread`, `hot` ou `all` |
| `DATABASE_URL` | banco do Compose | usado para amostrar o lag da outbox |

O teste mostra throughput, p50/p95/p99, taxa de erro, conflitos de lock, retries, lag da outbox e o resultado da reconciliação de todas as wallets, e grava o relatório em `load-test-results/`. Os resultados e a análise estão na [seção 15 do ARCHITECTURE.md](ARCHITECTURE.md#15-teste-de-carga).

## Migrations

```bash
DATABASE_URL=postgres://wagering:wagering@localhost:55432/wagering bun run migrate:up
DATABASE_URL=postgres://wagering:wagering@localhost:55432/wagering bun run migrate:down
```

## Rodando fora do Docker

```bash
docker compose up -d postgres localstack
bun run migrate:up
bun run start:api      # ou start:worker, ou start:all
```

| Variável | Padrão |
|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:55432/wagering` |
| `PORT` / `OPS_PORT` | `3000` / `9100` |
| `AWS_ENDPOINT_URL` / `AWS_REGION` | `http://localhost:4566` / `us-east-1` |
| `SQS_REQUEST_TIMEOUT_MS` / `SQS_CONNECTION_TIMEOUT_MS` | `25000` / `3000` |
| `SQS_TRANSACTIONS_QUEUE` / `SQS_DLQ_QUEUE` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` |
| `DB_POOL_MAX` / `DB_LOCK_TIMEOUT_MS` | `20` / `5000` |
| `CONSUMER_MAX_ATTEMPTS` / `CONSUMER_CONCURRENCY` | `5` / `10` |
| `CONSUMER_ALLOWED_PROVIDERS` | `*` (lista separada por vírgula) |
| `CONSUMER_RETRY_BASE_DELAY_SECONDS` / `CONSUMER_RETRY_MAX_DELAY_SECONDS` | `2` / `60` |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_INTERVAL_MS` | `50` / `500` |
| `REFERENCE_MAX_ATTEMPTS` / `REFERENCE_BASE_DELAY_MS` / `REFERENCE_MAX_DELAY_MS` | `12` / `1000` / `300000` |
| `SHUTDOWN_TIMEOUT_MS` | `20000` |
| `LOG_LEVEL` | `info` |

## Estrutura

```
src/
├── domain/            Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras
├── application/       casos de uso e portas
├── infrastructure/    MikroORM (schemas, repositórios, migrations), SQS, observabilidade
├── interfaces/http/   controllers NestJS, filtro de erros, AuthGuard no-op, servidor operacional
├── container.ts       composition root
├── worker.ts          consumidor, publisher da outbox e resolvedor de referências
└── main.ts            bootstrap (api | worker | all) e shutdown gracioso
test/
├── unit/  integration/  concurrency/  load/  support/
docker/                init do Postgres e criação das filas no LocalStack
```

## Autenticação

Não implementei autenticação, por decisão documentada (ela não pontua e competiria por tempo com correção e concorrência). O ponto de extensão está no código: um `AuthGuard` global no-op e um `ProviderIdentityPort`. A validação do provedor fica no caso de uso e vale tanto para o HTTP quanto para a fila (`CONSUMER_ALLOWED_PROVIDERS`). O desenho com Keycloak (OIDC `client_credentials` por provedor, validação de JWT via JWKS e claim `provider_id`) está na [seção 13 do ARCHITECTURE.md](ARCHITECTURE.md#13-autenticação-decisão).
