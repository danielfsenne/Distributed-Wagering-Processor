# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas. O objetivo do serviço é processar transações de apostas vindas de múltiplos provedores e continuar correto com entregas duplicadas, fora de ordem, concorrentes, com várias instâncias e com falhas de processo, Postgres ou SQS.

A regra que guiou todo o desenho: **o banco é a fonte da verdade das invariantes**. Código de aplicação, ordenação do SQS FIFO e deduplicação do broker são otimizações. Unicidade, imutabilidade, não-negatividade e coerência entre saldo e ledger são garantidas por constraints, índices e triggers no PostgreSQL.

---

## 1. Visão geral

```
               ┌──────────────┐        ┌──────────────────────────┐
  Provedor ───▶│  API (Nest)  │──┐     │  wager-transactions.fifo │◀── Provedor
   HTTP        └──────────────┘  │     └────────────┬─────────────┘
                                 │                  │ long polling
                                 ▼                  ▼
                      ┌────────────────────────────────────┐
                      │   SubmitWagerTransaction (use case)│  ← mesmo caso de uso
                      └─────────────────┬──────────────────┘
                                        │ 1 transação SQL
         ┌──────────────┬───────────────┼───────────────┬──────────────┐
         ▼              ▼               ▼               ▼              ▼
      wallets   wager_transactions  wallet_ledger   inbox_messages  outbox_messages
                                     _entries
                                                                       │
                       Worker (N réplicas)                             │ FOR UPDATE SKIP LOCKED
                       ├─ consumidor SQS ──────────────────────────────┘
                       ├─ publisher da outbox ──────▶ wagering-events.fifo
                       └─ resolvedor de PENDING_REFERENCE
```

O mesmo binário roda em três modos (`bun src/main.ts api|worker|all`):

| Modo | Responsabilidade |
|---|---|
| `api` | HTTP: wallets, transações, consultas, reconciliação, health e métricas |
| `worker` | consumidor SQS, publisher da outbox, resolvedor de referências pendentes, e servidor operacional em `:9100` com `/metrics` e `/health/*` |
| `all` | os dois juntos (conveniente para desenvolvimento) |

O Docker Compose sobe 1 API e 3 workers. A correção não depende do número de réplicas.

## 2. Camadas e fronteiras

```
src/
├── domain/          regras puras: sem NestJS, sem ORM, sem I/O
│   ├── shared/      Money, erros de domínio, geração de ids
│   ├── wallet/      Wallet (aggregate root), WalletLedgerEntry, LedgerDirection
│   ├── wagering/    WagerTransaction, WagerSettlement (serviço de domínio), FailureCode, ReferenceRetryPolicy
│   └── messaging/   InboxMessage, OutboxMessage, IntegrationEvent e eventos concretos
├── application/     casos de uso + portas (interfaces)
│   ├── ports.ts     UnitOfWork, repositórios, EventPublisher, Metrics, Logger, Clock
│   ├── wagering/    SubmitWagerTransaction, ResolvePendingReferences, WagerProcessor, parsing do payload
│   ├── wallets/     OpenWallet, ReconcileWallet, WalletQueries
│   └── outbox/      PublishOutbox
├── infrastructure/  adaptadores
│   ├── persistence/ MikroORM: EntitySchema, mappers, repositórios, UnitOfWork, migrations
│   ├── messaging/   SQS: consumidor, publisher, resolução de filas
│   ├── observability/ pino + AsyncLocalStorage, prom-client
│   └── scheduling/  loop periódico com parada graciosa
├── interfaces/http/ controllers NestJS, filtro de erros, AuthGuard, servidor operacional
├── container.ts     composition root (montagem explícita das dependências)
├── worker.ts        orquestra consumidor, publisher e resolvedor
└── main.ts          bootstrap, modos de execução e shutdown gracioso
```

- O domínio não conhece NestJS, MikroORM nem SQS. `Money` usa `decimal.js` e os ids usam UUID v7; essas são as únicas dependências externas.
- A aplicação depende apenas de portas. HTTP e SQS chamam **o mesmo** `SubmitWagerTransaction`; a única diferença é o contexto opcional de inbox.
- As dependências são montadas num composition root explícito (`container.ts`). O NestJS fica restrito à borda HTTP, onde recebe o container por `useValue`. Isso mantém o worker livre do ciclo de vida do Nest e deixa os testes de integração montarem a mesma árvore de objetos sem mocks.

## 3. Modelo de domínio

Todas as entidades têm construtor `private`, factories estáticas (`create`, `open`, `from`, `enqueue` e `receive`) e `rehydrate`. A `rehydrate` só reconstrói estado persistido, sem revalidar transições.

### 3.1 Money

- Valor em `Decimal` (decimal.js, precisão 40, arredondamento `ROUND_HALF_EVEN` configurado explicitamente), mais a moeda ISO-4217.
- **Nenhuma operação arredonda**: as entradas são restritas a no máximo 2 casas decimais, e soma e subtração em escala 2 são exatas. Por isso o resultado nunca precisa de arredondamento, e os testes cobrem `0.10 + 0.20 = 0.30` e somas de 1000 × `0.01`.
- `Money.from` é o parser dos contratos de entrada. Rejeita `NaN`, `Infinity`, notação científica, string vazia, sinais (`+` e `-`), espaços, vírgula, zeros à esquerda, mais de 2 casas decimais, mais de 18 dígitos inteiros (limite de `numeric(20,2)`) e moeda que não seja `^[A-Z]{3}$`.
- `Money.fromSigned` aceita valores negativos e serve só para valores internos, como a diferença da reconciliação e a reidratação.
- A serialização tem sempre escala fixa (`"25.00"`), e zero nunca sai como `"-0.00"`.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda (a wallet é única por `playerId + currency`) e os conflitos de moeda são testados.

### 3.2 Wallet (aggregate root)

- O saldo só muda por `debit` e `credit`, e os dois **retornam o `WalletLedgerEntry`** correspondente. Não existe mudança de saldo sem lançamento.
- `version` começa em 1 e só incrementa quando o saldo muda. O lançamento carrega `walletVersion`, que é a versão resultante.
- Se o saldo inicial for positivo, `Wallet.open` produz o lançamento de abertura (`CREDIT`, versão 1). O caso de uso cria a transação interna `OPENING` na mesma transação SQL.
- Um débito acima do saldo lança erro e não altera o estado. A validação acontece antes da mutação.

### 3.3 WagerTransaction e transições

```
                 ┌──────────────────────────────┐
                 │                              ▼
   create ──▶ PENDING ──▶ PENDING_REFERENCE ──(reprocesso)──▶ PENDING_REFERENCE
                 │               │
                 ├──▶ PROCESSED ◀┤
                 ├──▶ REJECTED  ◀┤
                 └──▶ FAILED    ◀┘
```

| De | Para |
|---|---|
| `PENDING` | `PROCESSED`, `PENDING_REFERENCE`, `REJECTED`, `FAILED` |
| `PENDING_REFERENCE` | `PROCESSED`, `PENDING_REFERENCE` (nova tentativa), `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | nenhuma: estados terminais |

- Tentar transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação). O banco repete essa regra com o trigger `wager_transactions_guard_update`.
- `PENDING` existe só em memória: o settlement sempre leva a transação a outro estado antes de persistir.
- `resultBalance` guarda o saldo observado no momento da decisão, e é o que o replay devolve.
- `OPENING` só nasce por `WagerTransaction.opening`. `create` rejeita esse kind, o parser de entrada não o aceita e o banco exige `provider_id = 'internal'` exatamente para `OPENING`.

### 3.4 WagerSettlement (serviço de domínio)

As regras de BET, WIN, LOSS, REFUND e ROLLBACK ficam num único serviço de domínio puro, testável sem banco. Recebe a transação, a wallet já travada, a referência resolvida (se houver), a informação de que a referência já foi revertida e a política de retry. Muta a transação e a wallet e devolve o lançamento, se houver.

A ordem de avaliação é: wallet e jogador → moeda → referência (existência, status, kind permitido, mesmo contexto, valor, reversão única) → saldo.

### 3.5 WalletLedgerEntry

Imutável estruturalmente: todos os campos são `readonly`, a instância é congelada com `Object.freeze` e não há métodos de transição. A factory valida `balanceBefore ± money = balanceAfter`, valor positivo e saldos não negativos.

### 3.6 Inbox, outbox e eventos

- `IntegrationEvent<T>` é abstrata. Cada evento concreto (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged` e `WagerTransactionFailed`) define `eventType` e `version` no próprio tipo.
- O `data` carrega `MoneyProps` (string decimal), nunca uma instância de `Money`.
- `OutboxMessage.enqueue(event)` serializa o envelope (`toJSON`). O `id` da mensagem é o `eventId`, o que mantém o id estável entre republicações.

## 4. Persistência: MikroORM

### 4.1 Por que MikroORM

MikroORM é a opção preferencial do desafio e entrega o que importa aqui: `EntityManager.transactional()`, `LockMode.PESSIMISTIC_WRITE`, `PESSIMISTIC_READ` e `PESSIMISTIC_PARTIAL_WRITE` (SKIP LOCKED), migrations versionadas e tradução de erros do driver. A versão usada é a 7, sobre Kysely.

### 4.2 Como foi usada (e por que não o change tracking implícito)

- **`EntitySchema` sem decorators.** Os registros de persistência (`records.ts`) são separados das entidades de domínio. Os mappers fazem a tradução nos dois sentidos, o que mantém o domínio livre de ORM.
- **Cada caso de uso roda num `em.fork().transactional()`** com `READ COMMITTED`. No início da transação são aplicados `lock_timeout` e `statement_timeout` com `set_config(..., true)`, que valem só para ela.
- **Escritas financeiras explícitas**: `em.insert` e `em.nativeUpdate` com condição. Não uso o flush automático do Unit of Work nas tabelas financeiras. A ordem dos comandos importa (transação → ledger → wallet, por causa dos triggers), e a condição de cada `UPDATE` (`WHERE version = ?`, `WHERE status = ? AND reference_attempts = ?`) faz parte da garantia de concorrência. Com o flush implícito, isso viraria detalhe interno do ORM.
- **Leituras com `disableIdentityMap: true`**: dentro da mesma transação uma linha pode ser relida depois de um lock, e o identity map devolveria uma cópia desatualizada.
- **SQL nativo onde o ORM não expressa bem**: `INSERT ... ON CONFLICT DO NOTHING RETURNING` (inbox) e `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` (claim de referências pendentes). O claim da outbox é um `SELECT ... FOR UPDATE SKIP LOCKED`.

### 4.3 Mapeamento do Money

- O valor fica em `numeric(20,2)` e a moeda em `char(3)`, em colunas separadas. Essa representação é exata no banco.
- O ORM devolve `numeric` como **string**, nunca como `number`. O mapper normaliza a string e reidrata com `Money.fromSigned`. Uma escala inesperada vinda do banco gera erro em vez de truncamento silencioso.
- Na escrita, o valor sai por `money.amount` (string com 2 casas). Nenhum `number` participa do caminho do dinheiro.

### 4.4 Migrations

- As migrations são escritas à mão em SQL, versionadas e reversíveis (`up` e `down`), e registradas explicitamente em `migrationsList`, sem descoberta por arquivo, o que evita surpresas no bundling com Bun.
- `bun run migrate:up` e `migrate:down`. No Compose, um serviço `migrate` roda antes da API e dos workers.
- O teste `migrations.test.ts` faz up, down e up num banco temporário e verifica as tabelas criadas e removidas.

## 5. Schema: onde cada invariante é garantida

| Invariante | Domínio | Banco |
|---|---|---|
| Uma wallet por `playerId + currency` | — | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `Wallet.debit` | `CHECK (balance >= 0)`; `CHECK` em `balance_before` e `balance_after` |
| Toda mudança de saldo tem lançamento | `debit`/`credit` retornam o lançamento | constraint trigger diferido `wallets_require_ledger_entry`: o commit falha se não existir um lançamento com `wallet_version = version` e `balance_after = balance` |
| Todo lançamento corresponde a uma mudança de saldo | — | `UNIQUE (wallet_id, wallet_version)`; trigger `wallet_ledger_entries_guard_insert` exige o encadeamento `balance_before = balance_after` da versão anterior, mesma moeda da wallet e transação `PROCESSED`, não `LOSS`, com mesmo valor e mesma wallet |
| `version` só muda com o saldo, sempre +1 | `Wallet.move` | trigger `wallets_guard_update` |
| Lançamento aritmeticamente correto | `WalletLedgerEntry.create` | `CHECK` de `balance_after = balance_before ± amount` |
| Ledger imutável | entidade congelada | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| No máximo um lançamento por transação e wallet | — | `UNIQUE (transaction_id, wallet_id)` |
| Transação processada que afeta saldo tem lançamento | `WagerProcessor` | constraint trigger diferido `wager_transactions_require_ledger_entry` |
| Idempotência persistente | — | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Estados terminais imutáveis; colunas de negócio imutáveis | `transitionTo` | trigger `wager_transactions_guard_update`; `DELETE` bloqueado |
| Reversão única por referência | `WagerSettlement` | índice único parcial `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Coerência de status | — | `CHECK`s: `failure_code` existe exatamente em `REJECTED`/`FAILED`; `processed_at` exatamente nos terminais; `PENDING_REFERENCE` tem agendamento; `reference_transaction_id` só em `PROCESSED`; `REFUND`/`ROLLBACK` exigem referência; valor `> 0`, exceto `LOSS = 0` |
| Inbox deduplicada | — | `PRIMARY KEY (consumer_name, message_id)` |

Índices de apoio:

- `wager_transactions_pending_reference_due_idx`: parcial, sobre `next_reference_attempt_at`, apenas para `PENDING_REFERENCE`.
- `wager_transactions_pending_reference_lookup_idx`: parcial, para acordar dependentes.
- `wallet_ledger_entries (wallet_id, sequence)`: paginação por cursor.
- `outbox_messages (next_attempt_at, sequence) WHERE published_at IS NULL`: claim da outbox.

Os triggers de coerência entre saldo e ledger são `DEFERRABLE INITIALLY DEFERRED`: rodam no commit, depois que a transação, o lançamento e a wallet já foram escritos. Assim a ordem natural das escritas funciona, e o commit ainda falha se faltar alguma peça. O teste `schema-constraints.test.ts` exercita cada uma dessas regras com SQL direto, sem passar pelo domínio.

## 6. Concorrência

### 6.1 Estratégia: lock pessimista por wallet e update condicional como segunda barreira

A unidade de concorrência é a `walletId`. O fluxo de uma transação:

1. `BEGIN` (`READ COMMITTED`), com `lock_timeout = 5s` e `statement_timeout = 15s` locais.
2. (SQS) `INSERT` na inbox com `ON CONFLICT DO NOTHING`.
3. `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`: **serializa só as operações da mesma wallet**.
4. Busca por `idempotency_key` **depois** do lock. Em `READ COMMITTED` cada comando vê o que já foi commitado, então uma requisição gêmea que esperou o lock enxerga a primeira e vira replay.
5. Resolução da referência, verificação de reversão, settlement no domínio.
6. `INSERT` da transação → `INSERT` do lançamento → `UPDATE wallets ... WHERE id = ? AND version = ?` (falha se zero linhas forem afetadas) → `INSERT` na outbox → marca a inbox → acorda dependentes.
7. `COMMIT`. Os triggers diferidos validam saldo e ledger.

**Por que pessimista.** Em iGaming, *hot wallets* são o caso normal: um jogador com várias rodadas simultâneas e provedores mandando WIN e BET juntos. Com optimistic locking puro, N requisições concorrentes na mesma wallet geram até N-1 conflitos por rodada e retries em cascata, com latência imprevisível e risco de esgotar as tentativas. Com `FOR UPDATE`, as requisições entram na fila do próprio Postgres, cada uma espera a anterior e todas terminam, sem trabalho desperdiçado. O teste de carga confirma: **0 conflitos e 0 retries** nos dois cenários.

**Por que a versão continua lá.** O `UPDATE ... WHERE version = ?` é a segunda barreira. Se algum caminho de código futuro esquecer o lock, o update condicional detecta o *lost update* e o retry limitado entra em ação. Os triggers de versão e saldo são a terceira barreira.

**Sem lock global.** Os locks são de linha (uma wallet). O teste `a locked hot wallet does not block other wallets` segura o lock de uma wallet numa transação aberta e mostra outra wallet sendo processada em menos de 1 s enquanto isso.

**Deadlocks.** A ordem de aquisição é sempre wallet → linhas da transação. O resolvedor de referências relê a transação depois do lock da wallet. Deadlocks (`40P01`), serialização (`40001`), timeout de lock (`55P03`), conflito de versão e violação de unicidade em corrida entram num **retry limitado**: 5 tentativas com backoff exponencial e jitter (`withTransactionRetry`). Esgotado o limite, a falha vira `TRANSIENT_FAILURE`: 503 no HTTP, ou retry/DLQ no SQS.

### 6.2 Cenário obrigatório

Saldo de 100.00 e duas apostas de 80.00 simultâneas: uma `PROCESSED` (201) e outra `REJECTED / INSUFFICIENT_FUNDS` (422). Saldo final de 20.00 e exatamente um `DEBIT` no ledger. Repetições das duas requisições devolvem replay sem novo débito. Ver `test/concurrency/hot-wallet.test.ts`.

### 6.3 Várias instâncias

Nenhum estado de correção vive em memória: locks, idempotência, inbox, outbox e agendamento de referências estão todos no Postgres. Os testes em `test/concurrency/multi-process.test.ts` sobem **processos Bun separados**:

- 3 APIs recebendo 300 requisições (150 chaves, cada uma enviada a duas instâncias diferentes) na mesma wallet: exatamente 100 processadas, saldo 0.00 e nenhum lançamento duplicado.
- 3 workers consumindo a mesma fila com mensagens duplicadas e WINs entregues antes das BETs.
- workers mortos com `SIGKILL` no meio do fluxo, substituição por outros, depois parada com `SIGTERM` e reinício completo. Ao final, a reconciliação de todas as wallets dá consistente e cada mensagem foi aplicada exatamente uma vez.

## 7. Idempotência

- O header **`Idempotency-Key` é obrigatório e é a fonte da verdade.** Pelo SQS, a chave vem em `data.idempotencyKey`. O formato recomendado é `{providerId}:{externalTransactionId}`, mas não é imposto.
- **`payloadHash` = SHA-256 (hex) do JSON canônico** do subconjunto de negócio:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}` e `referenceExternalTransactionId` quando presente.
  - Canonização: chaves ordenadas recursivamente, campos `undefined` omitidos, UUIDs em minúsculas e `amount` normalizado para escala 2 antes do hash. Por isso `"25"` e `"25.00"` são o mesmo payload.
  - **Ficam fora do hash**: o header `Idempotency-Key`, `messageId`, `occurredAt`, `correlationId` e qualquer metadado de transporte.
- **Mesma chave e mesmo hash**: replay da resposta original, com o mesmo `transactionId`, status, `failureCode` e **saldo observado naquele momento** (`result_balance` persistido), mais `idempotentReplay: true`.
- **Mesma chave e hash diferente**: `409 IDEMPOTENCY_KEY_CONFLICT`. Nunca é replay.
- **Mesmo `(providerId, externalTransactionId)` com outra chave**: `409 EXTERNAL_TRANSACTION_CONFLICT`. A identidade de negócio também é única.
- **Corrida entre requisições gêmeas**: na mesma wallet, o lock serializa e a segunda vira replay. Em wallets diferentes (payload conflitante), a constraint única derruba uma das duas, o retry roda de novo e cai no caminho de conflito.
- **Inbox SQS** em `(consumerName, messageId)`, na mesma transação do efeito financeiro. Uma redelivery encontra a inbox e devolve replay. Um `messageId` reaproveitado para outra chave vira `MESSAGE_ID_CONFLICT` e vai para a DLQ.
- **Nada de cache em memória** participa da idempotência.

Para `PENDING_REFERENCE`, o replay devolve o status **atual** da transação. Se ela já foi resolvida, devolve `PROCESSED` com o saldo daquele momento; enquanto pendente, devolve o saldo atual da wallet. Com isso o provedor pode consultar o andamento reenviando a mesma requisição.

## 8. Regras de negócio e interpretações adotadas

| Operação | Efeito | Ledger | Referência |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | — |
| `WIN` | crédito | 1 `CREDIT` | opcional; se informada, deve ser uma `BET` |
| `LOSS` | nenhum | nenhum | opcional; se informada, deve ser uma `BET`. Valor pode ser `0.00` |
| `REFUND` | crédito | 1 `CREDIT` | obrigatória, deve ser `BET` `PROCESSED` |
| `ROLLBACK` | inverso da referência | 1 lançamento invertido | obrigatória: `BET` (credita), `WIN` (debita) ou `REFUND` (debita) |

Interpretações adicionais:

1. **A referência precisa pertencer ao mesmo contexto**: mesmo provider (garantido pela busca), jogador, wallet, moeda e rodada. Caso contrário, `REFERENCE_MISMATCH`.
2. **Reversão única por referência, qualquer que seja o tipo.** O enunciado proíbe reverter duas vezes com o mesmo tipo. Adotei a regra mais estrita (uma referência aceita no máximo um `REFUND` **ou** um `ROLLBACK` processado), porque `REFUND` e depois `ROLLBACK` da mesma `BET` creditariam o valor duas vezes. Desfazer um `REFUND` continua possível com `ROLLBACK` do próprio `REFUND`, que é outra referência.
3. **Reversão parcial não é suportada**: o valor de `REFUND`/`ROLLBACK` deve ser igual ao da referência (`REFERENCE_AMOUNT_MISMATCH`).
4. **Uma referência `REJECTED` ou `FAILED`** gera `REFERENCE_NOT_PROCESSED`. Se a própria referência ainda está `PENDING_REFERENCE`, a dependente também espera.
5. **Uma reversão que deixaria o saldo negativo** (por exemplo `ROLLBACK` de um `WIN` já gasto) é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`, código distinto do `INSUFFICIENT_FUNDS` de uma aposta. A transação fica persistida e auditável como `REJECTED`.
6. **`BET` de valor zero é inválida** (400); só `LOSS` aceita `0.00`.
7. **Uma transação não pode referenciar a si mesma** (400).
8. **Wallet inexistente** gera `404 WALLET_NOT_FOUND` sem persistir nada, porque não há wallet para associar e o resultado é determinístico em reenvios. No SQS, isso vai para a DLQ.
9. **Jogador diferente do dono da wallet** gera `REJECTED / PLAYER_WALLET_MISMATCH`, persistido.
10. **WIN depois de uma BET já revertida** não é bloqueado; a regra de negócio do provedor decide. Fica registrado como limitação.

### 8.1 Códigos de falha (`failureCode`)

| Código | Quando | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | Não reenviar; resultado terminal |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de crédito já consumido | Não reenviar; requer tratamento operacional |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | Corrigir o payload e reenviar com **outra** chave |
| `PLAYER_WALLET_MISMATCH` | jogador não é dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de tentativas | Investigar; reenviar com nova chave se a referência existir |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada ou falhou | Não reenviar |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: `REFUND` de um `WIN` | Corrigir o payload |
| `REFERENCE_MISMATCH` | referência de outra rodada, jogador ou wallet | Corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente da referência | Corrigir o payload |
| `ALREADY_REVERSED` | referência já revertida | Não reenviar |
| `PROCESSING_ERROR` | transação pendente que falhou de forma permanente no reprocessamento (`FAILED`) | Escalar; é auditável |

### 8.2 Mapeamento HTTP

O status HTTP basta para o provedor decidir se reenvia, sem interpretar mensagens de erro:

| Situação | HTTP | `error.code` | Reenviar? |
|---|---|---|---|
| Transação aplicada (primeira vez) | **201** | — | — |
| Replay de transação aplicada | **200** (`idempotentReplay: true`) | — | — |
| Aceita, aguardando referência | **202** (`PENDING_REFERENCE`) | — | Pode reenviar para consultar o status |
| Rejeição de regra de negócio | **422** com `status` e `failureCode` | — | Não, com a mesma chave |
| Payload inválido | **400** | `INVALID_PAYLOAD`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_CURSOR`, `INVALID_LIMIT` | Só depois de corrigir |
| Provedor fora do escopo do principal | **403** | `PROVIDER_NOT_ALLOWED` | Não |
| Conflito | **409** | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` | Não |
| Recurso inexistente | **404** | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | Não |
| Falha transitória (Postgres ou lock) | **503** + `Retry-After` | `TRANSIENT_FAILURE` (`retryable: true`) | **Sim**, com a mesma chave |
| Erro inesperado | **500** | `INTERNAL_ERROR` | Sim, com a mesma chave |

O replay devolve o mesmo status da resposta original: 422 para rejeitada, 202 para pendente e 200 para processada. Os erros seguem um formato único: `{ "error": { "code", "message", "retryable", "issues"? } }`.

## 9. Referências fora de ordem

- Uma transação cuja referência não existe (ou ainda está pendente) é persistida como `PENDING_REFERENCE`, com `reference_attempts` e `next_reference_attempt_at`, e publica `WagerTransactionPendingReference`.
- **Resolvedor** (`ResolvePendingReferences`, em todo worker):
  1. faz o claim de um lote com `UPDATE ... SET next_reference_attempt_at = now() + lease WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. O lease de 30 s distribui o trabalho entre os workers, e um worker que morre só atrasa o item até o lease vencer;
  2. para cada item: lock da wallet → releitura da transação → settlement. O `UPDATE` exige `status` e `reference_attempts` iguais aos lidos, então dois workers nunca aplicam o mesmo item.
- **Backoff exponencial**: `1s × 2^(n-1)`, limitado a 5 min, com **máximo de 12 tentativas**. A transação é rejeitada cerca de **18,5 minutos** depois da chegada (1+2+4+…+256+300+300 = 1111 s).
  - *Justificativa*: entregas fora de ordem costumam se resolver em segundos (corrida entre filas e partições do provedor). Retentativas curtas no início dão baixa latência no caso comum. O teto de 5 min e o total de cerca de 18 min cobrem atrasos maiores (filas do provedor reprocessando) sem manter pendências por horas, o que atrapalharia a reconciliação com o provedor. Tudo é configurável (`REFERENCE_MAX_ATTEMPTS`, `REFERENCE_BASE_DELAY_MS`, `REFERENCE_MAX_DELAY_MS`).
- **Esgotado o limite**: `REJECTED / REFERENCE_NOT_FOUND`, com evento `WagerTransactionRejected`.
- **Atalho**: quando uma transação chega a um estado terminal, o processador antecipa (`next_reference_attempt_at = now()`) as dependentes que esperam por ela (`wakePendingDependents`), então a resolução não espera o backoff.
- **Falha permanente** no reprocessamento (erro não transitório, como violação de invariante): a transação vai para `FAILED / PROCESSING_ERROR`, terminal e auditável, com evento `WagerTransactionFailed`.

## 10. Processamento por SQS

- **Filas**: `wager-transactions.fifo` e `wager-transactions-dlq.fifo`, criadas no LocalStack por `docker/localstack/init-queues.sh`. A fila principal tem `RedrivePolicy` com `maxReceiveCount = 10` como rede de segurança do broker.
- **`MessageGroupId = walletId`**: o FIFO entrega em ordem por wallet e evita que dois workers peguem a mesma wallet ao mesmo tempo. É **só otimização**: a correção vem do lock e das constraints, e os testes enviam duplicatas e mensagens fora de ordem.
- **Consumidor** (`SqsWagerConsumer`):
  - long polling; mensagens de grupos diferentes em paralelo, do mesmo grupo em sequência;
  - parse e validação do envelope, depois o **mesmo** `SubmitWagerTransaction` da API, com `inbox = { consumerName, messageId, sha256(body) }`;
  - **ack (`DeleteMessage`) só depois do commit**: se o processo morrer entre o commit e o ack, a redelivery encontra a inbox e vira replay;
  - classificação de erros:
    | Tipo | Exemplos | Ação |
    |---|---|---|
    | Negócio (terminal) | `REJECTED`, `PENDING_REFERENCE`, replay | **ack** |
    | Permanente | JSON inválido, payload inválido, conflito de idempotência, `MESSAGE_ID_CONFLICT`, `PROVIDER_NOT_ALLOWED`, wallet inexistente | **DLQ imediata** com `reason` |
    | Transitório | Postgres fora, timeout de lock, conflitos esgotados | **retry** com `ChangeMessageVisibility` em backoff exponencial (2 s × 2^(n-1), teto de 60 s); depois de `CONSUMER_MAX_ATTEMPTS = 5` recebimentos, **DLQ** com `reason = retries_exhausted` |
  - mover para a DLQ significa `SendMessage` na DLQ (com `reason`, `originalMessageId` e `receiveCount` como atributos) seguido de `DeleteMessage`. Se o processo morrer entre os dois, a mensagem volta e é reenviada à DLQ, e o `MessageDeduplicationId` (o `MessageId` original) evita a duplicata dentro da janela do FIFO.
- **SIGTERM**: o consumidor para de buscar (aborta o long poll), espera as mensagens em andamento até o timeout e devolve a visibilidade (`VisibilityTimeout = 0`) das que foram recebidas mas não iniciadas, que vão logo para outra instância.

## 11. Transactional outbox

- Os eventos entram em `outbox_messages` **na mesma transação SQL** do efeito financeiro e da inbox. Não há publicação antes do commit: o publisher só enxerga linhas commitadas.
- **Publisher** (`PublishOutbox`, em todo worker):
  1. `BEGIN`; `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY sequence LIMIT n FOR UPDATE SKIP LOCKED`. Vários publishers pegam lotes **disjuntos**;
  2. publica com `SendMessageBatch` (10 por chamada; `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`);
  3. marca as publicadas com um único `UPDATE ... WHERE id IN (...)`; as que falharam ganham `attempts + 1`, `next_attempt_at` com backoff (1 s × 2^(n-1), teto de 60 s) e `last_error`;
  4. `COMMIT`.
- **Cenários de falha** (cobertos em `outbox.test.ts`):
  - *commit no Postgres e o processo morre antes de publicar*: as linhas ficam pendentes e outra instância (outro pool, outro container) as publica;
  - *publicou no SQS e morreu antes do commit da marcação*: o lock é liberado pelo rollback, outra instância republica **com o mesmo `eventId`** e o mesmo payload. É at-least-once: o consumidor deduplica pelo `eventId`, e o FIFO deduplica na janela de 5 min;
  - *SQS indisponível*: retry com backoff, sem perder eventos.
- **Garantia oferecida**: nenhum evento confirmado se perde, e a duplicação é limitada às janelas de crash. Não é "exactly once"; o contrato com os consumidores é idempotência por `eventId`.
- **Trade-off**: o lote fica travado enquanto o publisher chama o SQS (transação aberta durante I/O de rede). A alternativa seria um lease em coluna (`locked_until`), que libera a conexão mas exige ajustar bem o tempo do lease. Com lotes pequenos e timeouts do cliente SQS, o lock por linha com `SKIP LOCKED` ficou mais simples e já resolve publishers concorrentes.
- **Ordem**: dentro de um lote, a ordem é por `sequence`. Entre publishers concorrentes, eventos do mesmo agregado podem sair fora de ordem, então os consumidores devem usar `walletVersion` (presente em `WalletBalanceChanged`) para ordenar.

## 12. Observabilidade

- **Logs JSON (pino)** com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, propagados por `AsyncLocalStorage`. O `correlationId` vem do header `x-correlation-id` (ou é gerado) e é devolvido na resposta. No SQS, vem do envelope ou do `messageId`.
- **Sem dados sensíveis**: os logs não incluem payloads, e o pino aplica `redact` em `money`, `balance`, `payload`, `body`, `data` e `authorization`. Um log de divergência na reconciliação registra só a diferença.
- **Métricas Prometheus** em `/metrics` (API na `:3000`, workers na `:9100`):

| Métrica | Tipo |
|---|---|
| `wagering_transactions_total{status,kind,source}` | counter (transações por status) |
| `wagering_duplicates_detected_total{source}` | counter (replays via HTTP, SQS e inbox) |
| `wagering_retries_total{component,reason}` | counter |
| `wagering_lock_conflicts_total{reason}` | counter (lock timeout, deadlock, versão, status) |
| `wagering_dlq_messages_total{reason}` | counter |
| `wagering_processing_duration_seconds{source}` | histogram (latência) |
| `wagering_outbox_pending_messages` / `wagering_outbox_lag_seconds` | gauge (lag da outbox: idade da mais antiga não publicada) |
| `wagering_outbox_published_total` / `wagering_outbox_publish_failures_total` | counter |
| `wagering_reconciliation_divergences_total` | counter |

- **Health**: `/health/live` (processo vivo) e `/health/ready` (Postgres e SQS alcançáveis, timeout de 2 s, responde 503 se algum estiver fora). Os dois são abertos. O Compose usa o `ready` como healthcheck da API e dos workers.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): com a wallet em `FOR SHARE`, que bloqueia escritas concorrentes durante a leitura, compara o saldo armazenado com a soma do ledger. Divergências **não são corrigidas**: são logadas em `error`, contadas em métrica e sinalizadas com `consistent: false`. Como os triggers impedem criar uma divergência pelo caminho normal, o teste desliga os triggers apenas na sua sessão (`session_replication_role = replica`) para corromper o saldo e exercitar esse caminho.

## 13. Autenticação: decisão

**Não implementei autenticação real.** Ela vale 0 ponto e competiria por tempo com correção, concorrência e idempotência. O ponto de extensão está explícito no código:

- `AuthGuard` global (`APP_GUARD`) com decorator `@Public()`. Health e métricas são públicos.
- `ProviderIdentityPort.resolve(request): ProviderPrincipal`, atendido hoje por `NoopProviderIdentity`, que devolve um principal anônimo com acesso a todos os provedores.
- **A validação da identidade do provedor fica no caso de uso, não na borda.** O `SubmitWagerCommand` exige um `principal`, e o `SubmitWagerTransaction` chama `assertMayActFor(principal, providerId)` antes de qualquer efeito. Assim HTTP e fila passam pela **mesma** regra:
  - no HTTP, o principal vem do `ProviderIdentityPort`; um provedor fora do escopo recebe `403 PROVIDER_NOT_ALLOWED`. A consulta por `providerId` aplica a mesma checagem;
  - na fila, tratada como canal interno confiável, o principal é o do consumidor, configurado por `CONSUMER_ALLOWED_PROVIDERS` (padrão `*`). Uma mensagem de provedor fora da lista é erro permanente e vai para a DLQ com `reason = provider_not_allowed`.

**Desenho que eu adotaria:**

1. **Keycloak** no Compose, com um realm `wagering` e um *client* confidencial por provedor (fluxo `client_credentials`). Cada client recebe um *mapper* que coloca o claim `provider_id` no token.
2. Uma implementação `JwtProviderIdentity` do `ProviderIdentityPort` valida o JWT (`iss`, `aud`, `exp` e assinatura) pelo JWKS do Keycloak, com cache de chaves e rotação. Extrai `sub` e `provider_id` para o `Principal`.
3. O `Principal` resultante carrega o `provider_id` do token, e o `assertMayActFor` que já existe no caso de uso passa a rejeitar com 403 qualquer `providerId` diferente, sem mudança no fluxo.
4. Endpoints administrativos (abertura de wallet, reconciliação) exigiriam um *role* separado (`wallet-admin`).
5. Nada de tabela de usuários ou hash de senha no serviço.

## 14. Estratégia de testes

Os testes não substituem Postgres nem SQS por mocks: integração e concorrência rodam contra o Postgres e o LocalStack dos containers. Mocks aparecem só para **injetar falhas** em pontos específicos, como uma `UnitOfWork` que derruba a transação depois do envio ou um publisher que falha.

| Exigência | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `test/unit/money.test.ts` |
| Invariantes da Wallet e do ledger | `test/unit/wallet.test.ts` |
| Regras de BET, WIN, LOSS, REFUND e ROLLBACK; conflito de moeda | `test/unit/wager-settlement.test.ts`, `wager-transaction.test.ts` |
| Idempotency key com payload divergente | `test/unit/payload-hash.test.ts`, `test/integration/http-api.test.ts` |
| Migrations e constraints | `test/integration/migrations.test.ts`, `schema-constraints.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/integration/atomicity.test.ts` |
| Inbox e redelivery; retry e DLQ; SIGTERM | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes; crash antes e depois de publicar | `test/integration/outbox.test.ts` |
| Referências fora de ordem; resolvedores concorrentes | `test/integration/pending-references.test.ts` |
| Reconciliação: divergência sinalizada, logada e contada em métrica, sem correção silenciosa | `test/integration/reconciliation.test.ts` |
| Validação do provedor no HTTP (403) e na fila (DLQ) | `test/integration/http-api.test.ts`, `sqs-consumer.test.ts`, `test/unit/provider-access.test.ts` |
| 50 envios paralelos da mesma aposta; cenário 100/80/80; wallets em paralelo; sem lock global | `test/concurrency/hot-wallet.test.ts` |
| ≥ 3 processos; worker morto depois do commit e antes do ack; SIGKILL e reinício com consistência | `test/concurrency/multi-process.test.ts`, `sqs-consumer.test.ts` |

A invariante `wallet.balance == saldo reconstruído pelo ledger` (e `wallet.version == última versão do ledger`) é verificada em três níveis:

1. `assertLedgerMatchesBalance` ao final de cada cenário que movimenta saldo;
2. **um hook global** (`test/support/global-invariants.ts`, carregado com `--preload` nas suítes de integração, concorrência e resiliência) que, ao final da execução, confere **todas as wallets criadas durante o run** e falha a suíte se alguma divergir. As únicas exceções são as wallets corrompidas de propósito pelo teste de reconciliação, registradas explicitamente com `excludeFromGlobalInvariant`;
3. os triggers diferidos, que recusam qualquer commit que quebre a invariante.

Os testes usam ids aleatórios (UUID v7) e **filas exclusivas por teste**, criadas e apagadas pelo próprio teste. Por isso não dependem de limpeza do banco, que o próprio schema impede para o ledger, e podem rodar repetidamente. A suíte foi executada várias vezes seguidas sem falhas intermitentes.

## 15. Teste de carga

`bun run test:load` mira a API (ou várias, via `BASE_URLS`), abre wallets, roda dois cenários por um tempo fixo com N clientes concorrentes e, ao final, **reconcilia todas as wallets usadas**. O relatório JSON vai para `load-test-results/`.

**Ambiente**: notebook Windows 10, AMD Ryzen 5 3500U (4 núcleos e 8 threads), 18 GB de RAM, Docker Desktop (WSL2) rodando Postgres 17 e LocalStack 4.4, API e workers em Bun 1.4.4. Os geradores de carga e as APIs rodaram no mesmo host.

**Metodologia**: mistura de 60% BET, 25% WIN (referenciando uma BET da mesma rodada), 10% LOSS e 5% REFUND. Valores pequenos para evitar rejeição por saldo. Cenário *spread* com 200 wallets e cenário *hot* com uma wallet só. 15 a 20 s por cenário. O lag da outbox é amostrado a cada 250 ms direto no banco, e conflitos e retries vêm do diff das métricas Prometheus.

| Cenário | Instâncias | Concorrência | Throughput | p50 | p95 | p99 | Erros | Conflitos/retries | Reconciliação |
|---|---|---|---|---|---|---|---|---|---|
| spread (200 wallets) | 1 | 32 | 87,6 req/s | 351 ms | 496 ms | 571 ms | 0% | 0 / 0 | 200/200 |
| hot (1 wallet) | 1 | 32 | 44,8 req/s | 709 ms | 820 ms | 836 ms | 0% | 0 / 0 | 1/1 |
| spread (200 wallets) | 3 | 48 | 101 a 159 req/s | 268 a 390 ms | 545 a 996 ms | 866 a 1358 ms | 0% | 0 / 0 | 200/200 |
| hot (1 wallet) | 3 | 48 | 36,3 req/s | 1237 ms | 1956 ms | 2173 ms | 0% | 0 / 0 | 1/1 |

Lag da outbox (spread com 3 instâncias): **antes** do envio em lote, máximo de 22,5 s e drenagem de 22 s depois da carga. Com `SendMessageBatch`, máximo de 10,5 s e drenagem de 4,6 s. Com a marcação em um único `UPDATE`, **máximo de 6,8 s e drenagem de 1,9 s**.

**Análise:**

- **Correção sob carga**: 0% de erro, 0 conflitos de lock, 0 retries, todas as wallets consistentes e nenhum lançamento duplicado. Os poucos `PENDING_REFERENCE` (até 10 por rodada) são WINs que chegaram antes da BET concorrente commitar: fora de ordem real, resolvido pelo worker.
- **Uma instância é limitada por CPU, não pelo banco.** Um perfil de CPU (`bun --cpu-prof`) mostrou cerca de 13 ms de CPU por transação, cerca de 45% dele na montagem de queries da MikroORM (`QueryHelper`, `formatQuery`, `escapeLiteral`). O Bun usa uma thread de JS, então uma instância satura em cerca de 90 a 100 req/s nesta máquina. Além disso, cada ida e volta ao Postgres pela rede do Docker Desktop custa de 2 a 7 ms, e uma transação faz cerca de 10 comandos.
- **A escala horizontal funciona** para wallets espalhadas: de 1 para 3 instâncias, o throughput passou de cerca de 88 para 101 a 159 req/s (a variação entre rodadas vem de tudo rodar no mesmo notebook de 4 núcleos, carga e serviço disputando CPU). Num ambiente com núcleos dedicados por instância, o ganho tende a ser mais linear, porque não há estado compartilhado fora do Postgres.
- **A hot wallet é limitada pela seção crítica**: com lock pessimista, o throughput de uma única wallet é `1 / duração da transação com o lock`. Aqui isso deu cerca de 45 req/s. Mais instâncias **não** ajudam e até pioram um pouco (36 req/s), porque a passagem do lock entre conexões de processos diferentes acrescenta latência. É o trade-off consciente: correção e ausência de retries no lugar de throughput por wallet. Para aumentar, o caminho é encurtar a seção crítica (menos idas ao banco, por exemplo uma função SQL que faz lock, insert e update), não trocar de estratégia de lock.
- **O lag da outbox** era o gargalo real que o teste revelou, e foi corrigido no próprio teste (envio em lote e marcação em `UPDATE` único). Os parâmetros `OUTBOX_BATCH_SIZE` e `OUTBOX_INTERVAL_MS` permitem ajuste fino.

## 16. Trade-offs e limitações

- **Throughput por instância**: a montagem de queries da MikroORM domina o uso de CPU. Se fosse preciso, eu moveria o caminho quente (lock, insert e update) para SQL direto via Kysely, ou para uma função PL/pgSQL, mantendo o ORM no resto.
- **Hot wallet**: limitada pela seção crítica, como descrito acima.
- **Outbox com transação aberta durante I/O**: aceito pela simplicidade; com lease em coluna isso deixaria de acontecer.
- **Ordem global de eventos** não é garantida entre publishers concorrentes; os consumidores ordenam por `walletVersion`.
- **Moeda única no teste de carga**; o modelo é multi-moeda e os conflitos de moeda são testados.
- **Autenticação** não implementada (ver seção 13).
- **Sem OpenTelemetry nem dashboard**: logs estruturados e métricas Prometheus cobrem o diagnóstico; o `correlationId` já seria a base para trace.
- **Retenção**: inbox e outbox crescem sem limpeza. Em produção, um job removeria inbox e outbox publicadas mais velhas que a janela de deduplicação dos produtores.
- **`FAILED`** só ocorre no reprocessamento de pendências. Falhas de infraestrutura no caminho síncrono não persistem nada (rollback) e são reportadas como 503 ou reentregues pelo SQS, o que é mais seguro do que gravar um estado terminal por causa de uma falha transitória.
