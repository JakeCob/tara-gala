-- TG-73 Ipon goal → trip pot (owner yes: owner-questions.md Q1, 2026-11-23). Additive: 4 tables, 2 widened checks. Old rows
-- are untouched: no wallet has a goal, no expense has mode pot or libre, no member has a shared QR. Safe to re-run, and a
-- no-op on a database built from schema.sql. RLS on every new table, no policy: private by link, written only by the
-- API's service role. NOT applied anywhere yet: the manager applies it on Supabase after P0 merges (plan §9).

-- the Ipon goal: at most one per wallet. treasurer is always a member of the same wallet (checked in the API).
create table if not exists wallet_pots (
  wallet_id      uuid primary key references wallets(id) on delete cascade,
  name           text check (name is null or char_length(name) between 1 and 40),  -- null: the wallet's (or trip's) name
  each_centavos  integer not null check (each_centavos between 100 and 10000000),
  due_date       date not null,
  treasurer      uuid not null references wallet_members(id),  -- members are never deleted; the wallet's cascade takes both
  version        integer not null default 1 check (version >= 1),
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);

-- who's in the goal, and any person's own amount (null: the goal's each_centavos)
create table if not exists pot_people (
  wallet_id        uuid not null references wallet_pots(wallet_id) on delete cascade,
  member_id        uuid not null references wallet_members(id) on delete cascade,
  target_centavos  integer check (target_centavos is null or target_centavos between 0 and 10000000),
  in_goal          boolean not null default true,
  primary key (wallet_id, member_id)
);

-- each ambag: 'in' = sent to the pot (pending until Received), 'back' = the treasurer gave it back (always received)
create table if not exists pot_ambag (
  id               uuid primary key default gen_random_uuid(),
  wallet_id        uuid not null references wallet_pots(wallet_id) on delete cascade,
  member_id        uuid not null references wallet_members(id) on delete cascade,
  kind             text not null default 'in' check (kind in ('in', 'back')),
  amount_centavos  integer not null check (amount_centavos between 1 and 10000000),
  status           text not null check (status in ('sent', 'received')),
  created_at       timestamptz not null default now(),
  received_at      timestamptz,
  proof_path       text unique,
  proof_type       text check (proof_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  proof_bytes      integer check (proof_bytes between 1 and 5242880),
  proof_at         timestamptz,
  constraint pot_ambag_received check ((status = 'received') = (received_at is not null)),
  constraint pot_ambag_back_received check (kind = 'in' or status = 'received'),
  constraint pot_ambag_proof_whole check (
    ((proof_path is null) = (proof_type is null)) and ((proof_path is null) = (proof_bytes is null))
    and (proof_path is null or proof_at is not null))
);
create index if not exists pot_ambag_wallet on pot_ambag (wallet_id, created_at desc);

-- a member's receive QR for this wallet, shown only to someone paying them (the API gates the read)
create table if not exists wallet_qrs (
  member_id     uuid primary key references wallet_members(id) on delete cascade,
  wallet_id     uuid not null references wallets(id) on delete cascade,
  storage_path  text unique not null,  -- wallets/<wallet id>/qr/<uuid>
  content_type  text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes         integer not null check (bytes between 1 and 5242880),
  added_at      timestamptz not null default now(),
  delete_after  date  -- a trip's wallet: the trip's return + 14 days (owner Q4); null: until its owner removes it
);
create index if not exists wallet_qrs_wallet on wallet_qrs (wallet_id);

-- expenses: two more modes. 'pot' = paid from the pot, 'libre' = a treat; both store one share, the payer's.
alter table expenses drop constraint if exists expenses_split_mode_check;
alter table expenses add constraint expenses_split_mode_check
  check (split_mode in ('equal', 'exact', 'percent', 'shares', 'adjust', 'itemized', 'pot', 'libre'));

-- the activity list: the pot's actions
alter table wallet_activity drop constraint if exists wallet_activity_action_check;
alter table wallet_activity add constraint wallet_activity_action_check
  check (action in ('expense_add', 'expense_edit', 'expense_delete', 'comment_add', 'comment_delete', 'settle',
    'settle_undo', 'proof_add', 'proof_change', 'proof_remove', 'member_join',
    'pot_on', 'pot_edit', 'pot_off', 'pot_person', 'ambag_sent', 'ambag_received', 'ambag_unreceive', 'ambag_undo',
    'ambag_back', 'ambag_proof_add', 'ambag_proof_change', 'ambag_proof_remove', 'pot_handover', 'pot_close',
    'pot_reopen'));

alter table wallet_pots enable row level security;
alter table pot_people  enable row level security;
alter table pot_ambag   enable row level security;
alter table wallet_qrs  enable row level security;
-- no policy on any of them (as TG-50/TG-66): the API serves them by the wallet's slug with the service role

-- Down (only with the owner's ok, and only when no row uses the new values; delete the QR and ambag-proof bytes first:
-- wallets/<id>/qr/ and pot_ambag.proof_path). It refuses (check violation) if any expense is pot/libre or any activity
-- row uses a pot action: fix forward instead.
--   drop table if exists wallet_qrs, pot_ambag, pot_people, wallet_pots;
--   alter table expenses drop constraint expenses_split_mode_check;
--   alter table expenses add constraint expenses_split_mode_check
--     check (split_mode in ('equal', 'exact', 'percent', 'shares', 'adjust', 'itemized'));
--   alter table wallet_activity drop constraint wallet_activity_action_check;
--   alter table wallet_activity add constraint wallet_activity_action_check
--     check (action in ('expense_add', 'expense_edit', 'expense_delete', 'comment_add', 'comment_delete', 'settle',
--       'settle_undo', 'proof_add', 'proof_change', 'proof_remove', 'member_join'));
