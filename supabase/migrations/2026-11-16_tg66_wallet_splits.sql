-- TG-66 Wallet splitting upgrade (owner-approved 2026-11-15, options.md §4: 5 columns, 7 tables). All additive: the split
-- modes and their inputs, several payers, itemized bills, comments and the activity list. Old rows read as legacy
-- (split_mode null), not sorted yet (category null), version 1 and rev 0, so there's nothing to backfill.
-- Safe to re-run, and a no-op on a database built from schema.sql. RLS on every new table, no policy: private by link.

-- the wallet's write counter (TG-65 ordering)
alter table wallets  add column if not exists rev bigint not null default 0;

-- expenses: mode, category and edit counter. Old rows: split_mode null (legacy), category null (not sorted yet), version 1.
alter table expenses add column if not exists split_mode text
  check (split_mode in ('equal', 'exact', 'percent', 'shares', 'adjust', 'itemized'));
alter table expenses add column if not exists category text
  check (category in ('transport', 'hotel', 'food', 'activities', 'other'));
alter table expenses add column if not exists version integer not null default 1 check (version >= 1);
alter table expenses add column if not exists updated_at timestamptz;

-- one row per person in the form: equal = 1 (among), exact = centavos, percent = basis points, shares = weight,
-- adjust = extra centavos (among = the rows; may be negative). Not used for itemized.
create table if not exists expense_inputs (
  expense_id  uuid not null references expenses(id) on delete cascade,
  member_id   uuid not null references wallet_members(id) on delete cascade,
  value       integer not null check (value between -10000000 and 10000000),
  primary key (expense_id, member_id)
);

-- several payers only (more than one); one payer stays expenses.paid_by. Sum = amount (checked in the API).
create table if not exists expense_payers (
  expense_id  uuid not null references expenses(id) on delete cascade,
  member_id   uuid not null references wallet_members(id) on delete cascade,
  paid_centavos integer not null check (paid_centavos between 1 and 10000000),
  primary key (expense_id, member_id)
);

-- itemized bill
create table if not exists expense_items (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references expenses(id) on delete cascade,
  seq         smallint not null check (seq between 1 and 40),
  name        text not null check (char_length(name) between 1 and 40),
  price_centavos integer not null check (price_centavos between 0 and 10000000),
  unique (expense_id, seq)
);
create table if not exists expense_item_people (
  item_id     uuid not null references expense_items(id) on delete cascade,
  member_id   uuid not null references wallet_members(id) on delete cascade,
  primary key (item_id, member_id)
);
create table if not exists expense_charges (
  expense_id  uuid not null references expenses(id) on delete cascade,
  kind        text not null check (kind in ('service', 'vat')),
  basis       text not null check (basis in ('percent', 'amount')),
  value       integer not null check (value between 0 and 10000000),  -- basis points or centavos
  primary key (expense_id, kind)
);

-- comments on an expense
create table if not exists expense_comments (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references expenses(id) on delete cascade,
  author      uuid references wallet_members(id) on delete set null,   -- the phone's pick; null = "Someone"
  body        text not null check (char_length(body) between 1 and 300),
  created_at  timestamptz not null default now()
);
create index if not exists expense_comments_expense on expense_comments (expense_id);

-- the activity list and the edit history (append-only; nothing updates or deletes a row except the wallet's cascade)
create table if not exists wallet_activity (
  id          bigint generated always as identity primary key,  -- newest first = id desc
  wallet_id   uuid not null references wallets(id) on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid references wallet_members(id) on delete set null,  -- the phone's pick; null = "Someone"
  action      text not null check (action in ('expense_add', 'expense_edit', 'expense_delete', 'comment_add',
                'comment_delete', 'settle', 'settle_undo', 'proof_add', 'proof_change', 'proof_remove', 'member_join')),
  expense_id  uuid,      -- no FK: a deleted expense's lines stay
  settlement_id uuid,    -- no FK, the same reason
  member_id   uuid references wallet_members(id) on delete set null,  -- member_join
  before      jsonb,     -- expense_edit / expense_delete: the expense as it was
  after       jsonb      -- expense_add / expense_edit: as saved; settle, settle_undo, proof_*: {from_member, to_member, amount_centavos}
);
create index if not exists wallet_activity_wallet on wallet_activity (wallet_id, id desc);
create index if not exists wallet_activity_expense on wallet_activity (expense_id) where expense_id is not null;

alter table expense_inputs      enable row level security;
alter table expense_payers      enable row level security;
alter table expense_items       enable row level security;
alter table expense_item_people enable row level security;
alter table expense_charges     enable row level security;
alter table expense_comments    enable row level security;
alter table wallet_activity     enable row level security;
-- no policy on any of them: the API serves them with the service role, like wallets (TG-50)
