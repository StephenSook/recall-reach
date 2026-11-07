-- A keyed hash of the PayPal order a slip started, so the way back reads PayPal only for that order. Never the raw id.
alter table shopping_slips add column order_ref_hmac text;
