-- TG-50: shared trip wallets. See schema.sql for the commented definitions; this file adds them to a database
-- built before TG-50. Private by link: RLS on with no policy, so anon and authenticated see nothing; the API
-- reads and writes through DATABASE_URL. Safe to re-run, and a no-op on a database built from the current schema.sql.
create table if not exists wallets (
  id            uuid primary key default gen_random_uuid(),
  share_slug    text unique not null default encode(gen_random_bytes(16), 'hex'),  -- 128 bits: the link is the key
  name          text not null check (char_length(name) between 1 and 40),
  created_at    timestamptz not null default now()
);

create table if not exists wallet_members (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,  -- keeps the party in the order it was entered
  wallet_id     uuid not null references wallets(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 30),
  created_at    timestamptz not null default now()
);
create unique index if not exists wallet_members_name on wallet_members (wallet_id, lower(name));

create table if not exists expenses (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  paid_by         uuid not null references wallet_members(id) on delete cascade,
  amount_centavos integer not null check (amount_centavos between 1 and 10000000),  -- up to PHP 100,000
  note            text not null check (char_length(note) between 1 and 60),
  created_at      timestamptz not null default now()
);
create index if not exists expenses_wallet on expenses (wallet_id);

-- Each person's part of an expense; the parts add up to amount_centavos (checked in the API)
create table if not exists expense_shares (
  expense_id      uuid not null references expenses(id) on delete cascade,
  member_id       uuid not null references wallet_members(id) on delete cascade,
  share_centavos  integer not null check (share_centavos >= 0),
  primary key (expense_id, member_id)
);

-- A payment between two people that the group marked as done
create table if not exists settlements (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  from_member     uuid not null references wallet_members(id) on delete cascade,
  to_member       uuid not null references wallet_members(id) on delete cascade,
  amount_centavos integer not null check (amount_centavos between 1 and 10000000),
  created_at      timestamptz not null default now(),
  check (from_member <> to_member)
);
create index if not exists settlements_wallet on settlements (wallet_id);

alter table wallets        enable row level security;
alter table wallet_members enable row level security;
alter table expenses       enable row level security;
alter table expense_shares enable row level security;
alter table settlements    enable row level security;
