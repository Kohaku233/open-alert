CREATE TABLE auth_registration_policy (
  id TEXT PRIMARY KEY CHECK(id='registration'),
  max_users INTEGER NOT NULL CHECK(max_users>0),
  invite_only INTEGER NOT NULL CHECK(invite_only IN(0,1))
);
--> statement-breakpoint
CREATE TRIGGER auth_user_registration_guard BEFORE INSERT ON "user"
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auth_registration_policy WHERE id='registration')
    THEN RAISE(ABORT, 'AUTH_POLICY_MISSING') END;
  SELECT CASE WHEN NEW.email<>lower(trim(NEW.email)) OR NEW.email_verified<>1 OR NEW.role<>'user'
    THEN RAISE(ABORT, 'AUTH_VERIFIED_USER_REQUIRED') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM "user") >= (SELECT max_users FROM auth_registration_policy WHERE id='registration')
    THEN RAISE(ABORT, 'AUTH_USER_LIMIT') END;
  SELECT CASE WHEN (SELECT invite_only FROM auth_registration_policy WHERE id='registration')=1
    AND NOT EXISTS(SELECT 1 FROM invitations WHERE email=NEW.email AND consumed_by IS NULL
      AND expires_at>cast(unixepoch('subsecond')*1000 as integer))
    THEN RAISE(ABORT, 'AUTH_INVITATION_REQUIRED') END;
END;
--> statement-breakpoint
CREATE TRIGGER auth_user_consume_invitation AFTER INSERT ON "user"
BEGIN
  UPDATE invitations SET consumed_by=NEW.id, consumed_at=cast(unixepoch('subsecond')*1000 as integer)
    WHERE id=(SELECT id FROM invitations WHERE email=NEW.email AND consumed_by IS NULL
      AND expires_at>cast(unixepoch('subsecond')*1000 as integer) ORDER BY expires_at LIMIT 1);
END;
--> statement-breakpoint
CREATE TRIGGER auth_session_disabled_guard BEFORE INSERT ON "session"
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM user_settings WHERE user_id=NEW.user_id AND disabled=1)
    THEN RAISE(ABORT, 'AUTH_ACCOUNT_DISABLED') END;
END;
