CREATE TABLE auth_registration_policy (
  id TEXT PRIMARY KEY CHECK(id='registration'),
  max_users INTEGER NOT NULL CHECK(max_users>0),
  invite_only INTEGER NOT NULL CHECK(invite_only IN(0,1)),
  user_count BIGINT NOT NULL DEFAULT 0 CHECK(user_count>=0)
);
--> statement-breakpoint
CREATE FUNCTION open_alert_registration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy auth_registration_policy%ROWTYPE;
BEGIN
  IF NEW.email<>lower(trim(NEW.email)) OR NOT NEW.email_verified OR NEW.role<>'user' THEN
    RAISE EXCEPTION 'AUTH_VERIFIED_USER_REQUIRED';
  END IF;
  UPDATE auth_registration_policy SET user_count=user_count+1
    WHERE id='registration' AND user_count<max_users RETURNING * INTO policy;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_POLICY_MISSING_OR_USER_LIMIT'; END IF;
  IF policy.invite_only=1 AND NOT EXISTS(SELECT 1 FROM invitations WHERE email=NEW.email
    AND consumed_by IS NULL AND expires_at>(extract(epoch from clock_timestamp())*1000)::bigint) THEN
    RAISE EXCEPTION 'AUTH_INVITATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_user_registration_guard BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION open_alert_registration_guard();
--> statement-breakpoint
CREATE FUNCTION open_alert_consume_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE invitations SET consumed_by=NEW.id, consumed_at=(extract(epoch from clock_timestamp())*1000)::bigint
    WHERE id=(SELECT id FROM invitations WHERE email=NEW.email AND consumed_by IS NULL
      AND expires_at>(extract(epoch from clock_timestamp())*1000)::bigint ORDER BY expires_at LIMIT 1);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_user_consume_invitation AFTER INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION open_alert_consume_invitation();
--> statement-breakpoint
CREATE FUNCTION open_alert_release_user_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE auth_registration_policy SET user_count=user_count-1 WHERE id='registration';
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_user_release_slot AFTER DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION open_alert_release_user_slot();
--> statement-breakpoint
CREATE FUNCTION open_alert_session_disabled_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_disabled BIGINT;
BEGIN
  SELECT disabled INTO is_disabled FROM user_settings WHERE user_id=NEW.user_id FOR SHARE;
  IF is_disabled=1 THEN RAISE EXCEPTION 'AUTH_ACCOUNT_DISABLED'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_session_disabled_guard BEFORE INSERT ON "session"
  FOR EACH ROW EXECUTE FUNCTION open_alert_session_disabled_guard();
