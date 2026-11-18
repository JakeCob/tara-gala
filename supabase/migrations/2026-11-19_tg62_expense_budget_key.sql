-- TG-62 Budget vs actual (owner-approved shapes 2026-11-16, plan.md §2): an expense may point at one of its trip plan's
-- budget lines. budget_key is that line's key (guide.budget.rows[].key), '_none' for "Not in the budget", or null for
-- "Not sorted yet". Old rows stay null: nothing to backfill on expenses. The key is a slug of the group's own line text,
-- so the API never logs it.
-- Additive, safe to re-run, and a no-op on a database built from schema.sql. It sorts after TG-66's and TG-64's.

alter table expenses add column if not exists budget_key text;
alter table expenses drop constraint if exists expenses_budget_key_check;
alter table expenses add constraint expenses_budget_key_check
  check (budget_key is null or budget_key = '_none' or budget_key ~ '^[a-z][a-z0-9-]{1,20}$');
