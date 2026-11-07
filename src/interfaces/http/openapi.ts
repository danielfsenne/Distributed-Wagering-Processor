import type { OpenAPIObject } from '@nestjs/swagger';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: object, example?: unknown) => ({
  'application/json': { schema, ...(example === undefined ? {} : { example }) },
});

const errorResponse = (description: string, code: string, message: string, retryable = false) => ({
  description,
  content: json(ref('Error'), { error: { code, message, retryable } }),
});

const walletIdParam = {
  name: 'walletId',
  in: 'path' as const,
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

const sample = {
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
};

const outcome = (status: string, amount: string, replay: boolean, failureCode?: string) => ({
  transactionId: sample.transactionId,
  status,
  balance: { amount, currency: 'BRL' },
  ...(failureCode ? { failureCode } : {}),
  idempotentReplay: replay,
});

const wager = (kind: string, amount: string, externalTransactionId: string, reference?: string) => ({
  providerId: 'provider-a',
  externalTransactionId,
  playerId: sample.playerId,
  walletId: sample.walletId,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind,
  money: { amount, currency: 'BRL' },
  ...(reference ? { referenceExternalTransactionId: reference } : {}),
});

export const openApiDocument: OpenAPIObject = {
  openapi: '3.0.3',
  info: {
    title: 'Distributed Wagering Processor',
    version: '1.0.0',
    description: [
      'Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com idempotência persistente, ledger imutável e consistência entre saldo e ledger.',
      '',
      '**Como testar:** crie uma wallet em `POST /wallets`, copie o `id` e o `playerId` retornados e use-os nos exemplos de `POST /wagering/transactions`. Para cada nova transação, troque o `externalTransactionId` e o header `Idempotency-Key`.',
      '',
      '**Status HTTP:** 201 aplicada · 200 replay · 202 aguardando referência · 422 rejeição de negócio (com `failureCode`) · 400 payload inválido · 403 provedor fora do escopo · 409 conflito · 404 inexistente · 503 falha transitória (reenviar com a mesma chave).',
    ].join('\n'),
  },
  tags: [
    { name: 'Wallets', description: 'Abertura, consulta, ledger e reconciliação' },
    { name: 'Wagering', description: 'Submissão e consulta de transações de aposta' },
    { name: 'Operational', description: 'Health checks e métricas (públicos)' },
  ],
  paths: {
    '/wallets': {
      post: {
        tags: ['Wallets'],
        summary: 'Criar wallet',
        description:
          'Saldo inicial maior que zero gera uma transação interna OPENING e um lançamento CREDIT na mesma transação SQL. Uma wallet por `playerId + currency`.',
        requestBody: {
          required: true,
          content: json(ref('OpenWalletRequest'), {
            playerId: sample.playerId,
            initialBalance: { amount: '1000.00', currency: 'BRL' },
          }),
        },
        responses: {
          '201': {
            description: 'Wallet criada',
            content: json(ref('Wallet'), {
              id: sample.walletId,
              playerId: sample.playerId,
              balance: { amount: '1000.00', currency: 'BRL' },
              version: 1,
            }),
          },
          '400': errorResponse('Payload inválido', 'INVALID_PAYLOAD', 'The payload is invalid'),
          '409': errorResponse(
            'Já existe wallet para o jogador nessa moeda',
            'WALLET_ALREADY_EXISTS',
            'Player already has a BRL wallet',
          ),
          '503': errorResponse('Falha transitória', 'TRANSIENT_FAILURE', 'database unavailable', true),
        },
      },
    },
    '/wallets/{walletId}': {
      get: {
        tags: ['Wallets'],
        summary: 'Consultar wallet',
        parameters: [walletIdParam],
        responses: {
          '200': { description: 'Wallet', content: json(ref('Wallet')) },
          '400': errorResponse('Id malformado', 'INVALID_PAYLOAD', 'The payload is invalid'),
          '404': errorResponse('Wallet inexistente', 'WALLET_NOT_FOUND', 'Wallet not found'),
        },
      },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        tags: ['Wallets'],
        summary: 'Listar lançamentos do ledger',
        description: 'Paginação por cursor opaco e estável, em ordem de inserção.',
        parameters: [
          walletIdParam,
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          '200': { description: 'Página do ledger', content: json(ref('LedgerPage')) },
          '400': errorResponse('Cursor ou limite inválido', 'INVALID_CURSOR', 'cursor is invalid'),
          '404': errorResponse('Wallet inexistente', 'WALLET_NOT_FOUND', 'Wallet not found'),
        },
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        tags: ['Wallets'],
        summary: 'Reconciliar saldo com o ledger',
        description: 'Divergências não são corrigidas: são logadas, contabilizadas em métrica e sinalizadas com `consistent: false`.',
        parameters: [walletIdParam],
        responses: {
          '200': {
            description: 'Relatório de reconciliação',
            content: json(ref('Reconciliation'), {
              walletId: sample.walletId,
              storedBalance: { amount: '975.00', currency: 'BRL' },
              calculatedBalance: { amount: '975.00', currency: 'BRL' },
              difference: { amount: '0.00', currency: 'BRL' },
              consistent: true,
              checkedEntries: 2,
            }),
          },
          '404': errorResponse('Wallet inexistente', 'WALLET_NOT_FOUND', 'Wallet not found'),
        },
      },
    },
    '/wagering/transactions': {
      post: {
        tags: ['Wagering'],
        summary: 'Submeter transação de aposta',
        description:
          'O header `Idempotency-Key` é obrigatório e é a fonte da verdade. Requisição idêntica devolve a resposta original com `idempotentReplay: true`; mesma chave com payload diferente é conflito (409). `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', maxLength: 255 },
            example: 'provider-a:transaction-123',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('WagerRequest'),
              examples: {
                bet: { summary: 'BET', value: wager('BET', '25.00', 'transaction-123') },
                win: { summary: 'WIN referenciando a BET', value: wager('WIN', '60.00', 'transaction-124', 'transaction-123') },
                loss: { summary: 'LOSS', value: wager('LOSS', '0.00', 'transaction-125', 'transaction-123') },
                refund: { summary: 'REFUND da BET', value: wager('REFUND', '25.00', 'transaction-126', 'transaction-123') },
                rollback: {
                  summary: 'ROLLBACK do WIN',
                  value: wager('ROLLBACK', '60.00', 'transaction-127', 'transaction-124'),
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Transação aplicada', content: json(ref('WagerOutcome'), outcome('PROCESSED', '975.00', false)) },
          '200': {
            description: 'Replay idempotente de transação aplicada',
            content: json(ref('WagerOutcome'), outcome('PROCESSED', '975.00', true)),
          },
          '202': {
            description: 'Aceita, aguardando a transação referenciada',
            content: json(ref('WagerOutcome'), outcome('PENDING_REFERENCE', '1000.00', false)),
          },
          '400': errorResponse('Payload inválido ou Idempotency-Key ausente', 'INVALID_PAYLOAD', 'The payload is invalid'),
          '403': errorResponse('Provedor fora do escopo do principal', 'PROVIDER_NOT_ALLOWED', 'Principal may not act for provider'),
          '404': errorResponse('Wallet inexistente', 'WALLET_NOT_FOUND', 'Wallet not found'),
          '409': errorResponse(
            'Mesma chave com payload diferente',
            'IDEMPOTENCY_KEY_CONFLICT',
            'Idempotency key was already used with a different payload',
          ),
          '422': {
            description: 'Rejeição por regra de negócio (persistida e auditável)',
            content: json(ref('WagerOutcome'), outcome('REJECTED', '20.00', false, 'INSUFFICIENT_FUNDS')),
          },
          '503': errorResponse('Falha transitória: reenviar com a mesma chave', 'TRANSIENT_FAILURE', 'database unavailable', true),
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: {
        tags: ['Wagering'],
        summary: 'Consultar transação pelo id interno',
        parameters: [{ name: 'transactionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Transação', content: json(ref('Transaction')) },
          '404': errorResponse('Transação inexistente', 'TRANSACTION_NOT_FOUND', 'Transaction not found'),
        },
      },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        tags: ['Wagering'],
        summary: 'Consultar transação pelo id do provedor',
        parameters: [
          { name: 'providerId', in: 'path', required: true, schema: { type: 'string' }, example: 'provider-a' },
          { name: 'externalTransactionId', in: 'path', required: true, schema: { type: 'string' }, example: 'transaction-123' },
        ],
        responses: {
          '200': { description: 'Transação', content: json(ref('Transaction')) },
          '403': errorResponse('Provedor fora do escopo do principal', 'PROVIDER_NOT_ALLOWED', 'Principal may not act for provider'),
          '404': errorResponse('Transação inexistente', 'TRANSACTION_NOT_FOUND', 'Transaction not found'),
        },
      },
    },
    '/health/live': {
      get: {
        tags: ['Operational'],
        summary: 'Liveness',
        responses: { '200': { description: 'Processo vivo', content: json({ type: 'object' }, { status: 'ok' }) } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Operational'],
        summary: 'Readiness (PostgreSQL e SQS)',
        responses: {
          '200': {
            description: 'Dependências alcançáveis',
            content: json({ type: 'object' }, { status: 'ok', checks: { postgres: 'up', sqs: 'up' } }),
          },
          '503': {
            description: 'Alguma dependência indisponível',
            content: json({ type: 'object' }, { status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } }),
          },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operational'],
        summary: 'Métricas Prometheus',
        responses: { '200': { description: 'Formato de exposição Prometheus', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Money: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'string', pattern: '^(0|[1-9]\\d*)(\\.\\d{1,2})?$', example: '25.00' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' },
        },
      },
      OpenWalletRequest: {
        type: 'object',
        required: ['playerId', 'initialBalance'],
        properties: { playerId: { type: 'string', format: 'uuid' }, initialBalance: ref('Money') },
      },
      Wallet: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          playerId: { type: 'string', format: 'uuid' },
          balance: ref('Money'),
          version: { type: 'integer', minimum: 1 },
        },
      },
      LedgerEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          transactionId: { type: 'string', format: 'uuid' },
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          money: ref('Money'),
          balanceBefore: ref('Money'),
          balanceAfter: ref('Money'),
          walletVersion: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      LedgerPage: {
        type: 'object',
        properties: {
          walletId: { type: 'string', format: 'uuid' },
          entries: { type: 'array', items: ref('LedgerEntry') },
          nextCursor: { type: 'string', nullable: true },
        },
      },
      Reconciliation: {
        type: 'object',
        properties: {
          walletId: { type: 'string', format: 'uuid' },
          storedBalance: ref('Money'),
          calculatedBalance: ref('Money'),
          difference: ref('Money'),
          consistent: { type: 'boolean' },
          checkedEntries: { type: 'integer' },
        },
      },
      WagerRequest: {
        type: 'object',
        required: ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'],
        properties: {
          providerId: { type: 'string', maxLength: 100 },
          externalTransactionId: { type: 'string', maxLength: 200 },
          playerId: { type: 'string', format: 'uuid' },
          walletId: { type: 'string', format: 'uuid' },
          roundId: { type: 'string', maxLength: 200 },
          gameId: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
          money: ref('Money'),
          referenceExternalTransactionId: {
            type: 'string',
            maxLength: 200,
            description: 'Obrigatório para REFUND e ROLLBACK; opcional para WIN e LOSS',
          },
        },
      },
      WagerOutcome: {
        type: 'object',
        properties: {
          transactionId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['PROCESSED', 'PENDING_REFERENCE', 'REJECTED', 'FAILED'] },
          balance: ref('Money'),
          failureCode: {
            type: 'string',
            enum: [
              'INSUFFICIENT_FUNDS',
              'REVERSAL_INSUFFICIENT_FUNDS',
              'CURRENCY_MISMATCH',
              'PLAYER_WALLET_MISMATCH',
              'REFERENCE_NOT_FOUND',
              'REFERENCE_NOT_PROCESSED',
              'REFERENCE_KIND_NOT_ALLOWED',
              'REFERENCE_MISMATCH',
              'REFERENCE_AMOUNT_MISMATCH',
              'ALREADY_REVERSED',
              'PROCESSING_ERROR',
            ],
          },
          idempotentReplay: { type: 'boolean' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          providerId: { type: 'string' },
          externalTransactionId: { type: 'string' },
          idempotencyKey: { type: 'string' },
          walletId: { type: 'string', format: 'uuid' },
          playerId: { type: 'string', format: 'uuid' },
          roundId: { type: 'string' },
          gameId: { type: 'string' },
          kind: { type: 'string', enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] },
          money: ref('Money'),
          status: { type: 'string', enum: ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] },
          failureCode: { type: 'string', nullable: true },
          referenceExternalTransactionId: { type: 'string', nullable: true },
          referenceTransactionId: { type: 'string', nullable: true },
          resultBalance: { allOf: [ref('Money')], nullable: true },
          referenceAttempts: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              retryable: { type: 'boolean' },
              issues: {
                type: 'array',
                items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
};
