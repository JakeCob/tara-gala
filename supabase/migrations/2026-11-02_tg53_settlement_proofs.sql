-- TG-53 Payment proof screenshots (owner-approved 2026-11-02): one proof on a payment, wallet-owned. A path means there's
-- a proof; no path with proof_at means the sweep deleted it. Safe to re-run, and a no-op on a database built from schema.sql.
alter table settlements add column if not exists proof_path  text unique;
alter table settlements add column if not exists proof_type  text check (proof_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'));
alter table settlements add column if not exists proof_bytes integer check (proof_bytes between 1 and 5242880);
alter table settlements add column if not exists proof_at    timestamptz;
alter table settlements drop constraint if exists settlements_proof_whole;
alter table settlements add constraint settlements_proof_whole check (
  ((proof_path is null) = (proof_type is null)) and ((proof_path is null) = (proof_bytes is null)) and (proof_path is null or proof_at is not null));
