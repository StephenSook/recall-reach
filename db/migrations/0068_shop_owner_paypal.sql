-- A shop owner's own PayPal login, linked from a signed-in session so that login opens the shop again later. Only an
-- HMAC of the PayPal account id is kept, one shop per PayPal account, and it goes with the shop.
alter table shops add column owner_payer_hmac text unique;
alter table shops add column owner_linked_at timestamptz;
alter table shops add column owner_signed_in_at timestamptz;
-- Measured when linked, never assumed: is this login the same PayPal account the shop's refunds go from?
alter table shops add column owner_is_seller boolean;
