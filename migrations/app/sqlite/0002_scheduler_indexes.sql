CREATE INDEX outbox_pending_work ON outbox(phase,trigger_id) WHERE phase IN('queued','sending');
CREATE INDEX alerts_pending_work ON alerts(pending_trigger_id,user_id) WHERE pending_trigger_id IS NOT NULL;
CREATE INDEX test_notifications_sending_work ON test_notifications(created_at,user_id) WHERE phase='sending';
