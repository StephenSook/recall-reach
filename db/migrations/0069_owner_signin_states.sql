-- Each PayPal sign-in's state is used once. A return is refused if its state's hash is already here, so a kept cookie
-- can't be replayed. Rows go after an hour, long after the 10-minute state itself runs out.
create table owner_signin_states (
  state_hash text primary key,
  used_at    timestamptz not null default now()
);
comment on table owner_signin_states is 'data-source: own';
