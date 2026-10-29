# Notification center

The notification center at `/notifications` owns channels, source routing and delivery history. Detection thresholds remain on the anomaly page.

## Channels

Pushover and Discord webhook channels support create, edit, test, disable and delete. Credentials are encrypted at rest and never returned by the API. Blank credential fields on edit preserve the saved credentials. To replace a Pushover app token, enter the user key as well.

For Discord, create an incoming webhook in a standard text channel under Channel settings > Integrations > Webhooks. Copy its URL into a Discord channel in Open Alert. Saving validates the URL without posting a message. The explicit Test action posts a test message. Forum/thread webhooks are not supported by this form.

## Rules

Price alerts, crypto anomalies and stock anomalies can target any enabled channels. Each source card sets priority, Pushover sound/emergency repeats, quiet hours and a daily limit per channel. Quiet hours use the UTC offset saved from the browser; update the rule after a timezone or daylight-saving change.

Daily limits reset at midnight UTC. The existing aggregate price-alert attempt limit remains a separate server guard, including failed attempts and retries. Discord sound and attention behavior depend on the Discord client; silent priority suppresses Discord notifications. Pushover emergency repeat settings apply only to Pushover.

Price alerts retain the durable outbox with bounded retries. Results are tracked per destination so a retry does not resend to channels that already accepted the message. Uncertain delivery is not automatically replayed. Anomaly pushes retain their existing detection/cooldown behavior and are dispatched once; they do not gain outbox retries in this release.

## History and migration

History shows the latest 100 channel outcomes and retains entries for 30 days. Sent means provider acceptance, not that a device displayed or read the message. Quiet hours and daily limits produce skipped records.

Startup copies existing Pushover credentials into an ordinary notification-center channel and creates a price-alert route. Existing anomaly routes are retained. Migration markers prevent deleted migrated channels from reappearing. The old credential tables are retained for compatibility and rollback; the UI uses the notification center.

Back up SQLite using its online backup API before deployment. Rollback requires restoring the pre-release database together with the previous application revision if notification settings have changed after migration.
