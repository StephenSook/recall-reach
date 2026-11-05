-- Every table says where its data comes from. Tests require a label on every table, and require the
-- 48-hour purge (server/privacy/retention.ts) to cover exactly the tables labelled "paypal".
--   cpsc-public  public CPSC recall data
--   own          records this app creates itself
--   paypal       holds data PayPal returned: deleted 48 hours after receipt (Developer Agreement 10.1.3)
--   paypal-hmac  only HMAC keys of PayPal ids under the shop's secret, plus this app's own timestamps
comment on table recalls is 'data-source: cpsc-public';
comment on table cpsc_pulls is 'data-source: own';
comment on table paypal_webhook_events is 'data-source: paypal';
comment on table paypal_webhook_transmissions is 'data-source: paypal-hmac';
