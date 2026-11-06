import { Migration } from '@mikro-orm/migrations';

export class Migration20261106000001InitialSchema extends Migration {
  override name = 'Migration20261106000001InitialSchema';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL CONSTRAINT wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) NOT NULL CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        version integer NOT NULL CONSTRAINT wallets_version_check CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(100) NOT NULL CONSTRAINT wager_transactions_provider_id_check CHECK (provider_id <> ''),
        external_transaction_id varchar(200) NOT NULL CONSTRAINT wager_transactions_external_id_check CHECK (external_transaction_id <> ''),
        idempotency_key varchar(255) NOT NULL CONSTRAINT wager_transactions_idempotency_key_check CHECK (idempotency_key <> ''),
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id uuid NOT NULL,
        round_id varchar(200) NOT NULL,
        game_id varchar(200) NOT NULL,
        kind varchar(16) NOT NULL CONSTRAINT wager_transactions_kind_check
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) NOT NULL,
        currency char(3) NOT NULL CONSTRAINT wager_transactions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(200),
        reference_transaction_id uuid REFERENCES wager_transactions (id),
        status varchar(24) NOT NULL CONSTRAINT wager_transactions_status_check
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code varchar(64),
        result_balance numeric(20, 2) CONSTRAINT wager_transactions_result_balance_check CHECK (result_balance >= 0),
        reference_attempts integer NOT NULL DEFAULT 0 CONSTRAINT wager_transactions_reference_attempts_check CHECK (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        processed_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wager_transactions_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_provider_external_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_amount_check
          CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_transactions_reference_required
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_transactions_opening_is_internal
          CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_transactions_failure_code_matches_status
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_transactions_processed_at_matches_status
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_transactions_result_balance_matches_status
          CHECK (status NOT IN ('PROCESSED', 'REJECTED') OR result_balance IS NOT NULL),
        CONSTRAINT wager_transactions_pending_reference_is_scheduled
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL),
        CONSTRAINT wager_transactions_reference_only_when_processed
          CHECK (reference_transaction_id IS NULL OR status = 'PROCESSED')
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_single_reversal_idx
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_lookup_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_transactions_wallet_idx ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        sequence bigint GENERATED ALWAYS AS IDENTITY,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        direction varchar(6) NOT NULL CONSTRAINT wallet_ledger_entries_direction_check
          CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) NOT NULL CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20, 2) NOT NULL CONSTRAINT wallet_ledger_entries_balance_before_check CHECK (balance_before >= 0),
        balance_after numeric(20, 2) NOT NULL CONSTRAINT wallet_ledger_entries_balance_after_check CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CONSTRAINT wallet_ledger_entries_wallet_version_check CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        CONSTRAINT wallet_ledger_entries_sequence_key UNIQUE (sequence),
        CONSTRAINT wallet_ledger_entries_transaction_wallet_key UNIQUE (transaction_id, wallet_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`CREATE INDEX wallet_ledger_entries_wallet_sequence_idx ON wallet_ledger_entries (wallet_id, sequence);`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(100) NOT NULL,
        message_id varchar(200) NOT NULL,
        payload_hash char(64) NOT NULL,
        transaction_id uuid REFERENCES wager_transactions (id),
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        sequence bigint GENERATED ALWAYS AS IDENTITY,
        aggregate_id varchar(200) NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CONSTRAINT outbox_messages_attempts_check CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz,
        last_error text,
        CONSTRAINT outbox_messages_sequence_key UNIQUE (sequence)
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx
        ON outbox_messages (next_attempt_at, sequence)
        WHERE published_at IS NULL;
    `);

    this.addSql(`
      CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed: rows are append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_modification();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION reject_modification();
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION reject_modification();
    `);
    this.addSql(`
      CREATE TRIGGER financial_tables_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_truncate
        BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
    `);

    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet % balance change must increment version by exactly 1', OLD.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version may only change with its balance', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update();
    `);

    this.addSql(`
      CREATE FUNCTION wallets_require_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.balance > 0)
           OR (TG_OP = 'UPDATE' AND NEW.balance IS DISTINCT FROM OLD.balance) THEN
          IF NOT EXISTS (
            SELECT 1 FROM wallet_ledger_entries e
            WHERE e.wallet_id = NEW.id AND e.wallet_version = NEW.version AND e.balance_after = NEW.balance
          ) THEN
            RAISE EXCEPTION 'wallet % balance % at version % has no matching ledger entry',
              NEW.id, NEW.balance, NEW.version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_require_ledger_entry
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_require_ledger_entry();
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        wallet_currency char(3);
        previous_balance numeric(20, 2);
        tx record;
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger entry currency % does not match wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT wallet_id, amount, currency, status, kind INTO tx
        FROM wager_transactions WHERE id = NEW.transaction_id;
        IF tx.wallet_id IS DISTINCT FROM NEW.wallet_id
           OR tx.amount IS DISTINCT FROM NEW.amount
           OR tx.currency IS DISTINCT FROM NEW.currency
           OR tx.status IS DISTINCT FROM 'PROCESSED'
           OR tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry does not match a processed balance-affecting transaction %', NEW.transaction_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT balance_after INTO previous_balance
        FROM wallet_ledger_entries
        WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF FOUND THEN
          IF previous_balance <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: previous balance % != balance_before %',
              NEW.wallet_id, previous_balance, NEW.balance_before
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.balance_before <> 0 OR NEW.wallet_version > 2 THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: missing entry for version %',
            NEW.wallet_id, NEW.wallet_version - 1
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_guard_insert
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_guard_insert();
    `);

    this.addSql(`
      CREATE FUNCTION wager_transactions_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'transaction % is in terminal status %', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'transaction % business columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_update();
    `);

    this.addSql(`
      CREATE FUNCTION wager_transactions_require_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS' AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries e WHERE e.transaction_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'processed transaction % has no ledger entry', NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wager_transactions_require_ledger_entry
        AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_require_ledger_entry();
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_require_ledger_entry();');
    this.addSql('DROP FUNCTION IF EXISTS wager_transactions_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_ledger_entries_guard_insert();');
    this.addSql('DROP FUNCTION IF EXISTS wallets_require_ledger_entry();');
    this.addSql('DROP FUNCTION IF EXISTS wallets_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS reject_modification();');
  }
}
