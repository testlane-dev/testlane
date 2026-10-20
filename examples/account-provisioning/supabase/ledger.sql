-- Fresh owned local Supabase only. Never rerun over an existing ledger.
-- Runtime creates the foreign control Auth user BEFORE this migration, then seeds
-- target(target_id) and control_grant(user_id,email,expires_at) using prepared SQL.
BEGIN;
CREATE SCHEMA testlane_private;
CREATE SCHEMA testlane_api;
REVOKE ALL ON SCHEMA testlane_private, testlane_api FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE testlane_private.target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  target_id uuid NOT NULL UNIQUE,
  last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  policy_hash text CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  release_id text CHECK (release_id ~ '^[a-f0-9]{64}$'),
  coordinator_root text,
  coordinator_nonce text CHECK (coordinator_nonce ~ '^[a-f0-9]{64}$'),
  CHECK ((policy_hash IS NULL AND release_id IS NULL AND coordinator_root IS NULL AND coordinator_nonce IS NULL)
    OR (policy_hash IS NOT NULL AND release_id IS NOT NULL AND coordinator_root IS NOT NULL AND coordinator_nonce IS NOT NULL))
);
CREATE TABLE testlane_private.runs (
  run_id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES testlane_private.target(target_id),
  release_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE testlane_private.reservations (
  operation_id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES testlane_private.target(target_id),
  run_id uuid NOT NULL REFERENCES testlane_private.runs(run_id),
  owner jsonb NOT NULL,
  role text NOT NULL CHECK (role IN ('Editor','Reviewer')),
  email text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  user_id uuid UNIQUE,
  revoked boolean NOT NULL DEFAULT false,
  delivery_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, role)
);
CREATE TABLE testlane_private.control_grant (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = 'foreign-control@example.test'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);

CREATE FUNCTION testlane_private.exact_object(value jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (SELECT count(*) FROM jsonb_object_keys(value)) = cardinality(keys)
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS key WHERE NOT key = ANY(keys));
END $$;

CREATE FUNCTION testlane_private.bind(value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target testlane_private.target%ROWTYPE; observed timestamptz;
BEGIN
  SELECT * INTO target FROM testlane_private.target WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_STATE_INVALID'; END IF;
  IF value IS NULL OR value = 'null'::jsonb THEN
    IF target.policy_hash IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('root',target.coordinator_root,'policyHash',target.policy_hash,'nonce',target.coordinator_nonce);
  END IF;
  observed := clock_timestamp();
  IF observed < target.last_observed_at THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_CLOCK_REFUSED'; END IF;
  IF NOT testlane_private.exact_object(value,ARRAY['targetId','policyHash','releaseId','root','nonce'])
    OR jsonb_typeof(value->'targetId') IS DISTINCT FROM 'string' OR value->>'targetId' IS DISTINCT FROM target.target_id::text
    OR jsonb_typeof(value->'policyHash') IS DISTINCT FROM 'string' OR (value->>'policyHash') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(value->'releaseId') IS DISTINCT FROM 'string' OR (value->>'releaseId') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(value->'nonce') IS DISTINCT FROM 'string' OR (value->>'nonce') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(value->'root') IS DISTINCT FROM 'string' OR length(value->>'root') NOT BETWEEN 1 AND 4096
    OR (value->>'root') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_POLICY_REFUSED';
  END IF;
  IF target.policy_hash IS NULL THEN
    UPDATE testlane_private.target SET policy_hash=value->>'policyHash',release_id=value->>'releaseId',
      coordinator_root=value->>'root',coordinator_nonce=value->>'nonce',last_observed_at=observed WHERE singleton;
  ELSIF target.policy_hash IS DISTINCT FROM value->>'policyHash' OR target.release_id IS DISTINCT FROM value->>'releaseId'
    OR target.coordinator_root IS DISTINCT FROM value->>'root' OR target.coordinator_nonce IS DISTINCT FROM value->>'nonce' THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_STATE_INVALID';
  ELSE
    UPDATE testlane_private.target SET last_observed_at=observed WHERE singleton;
  END IF;
  RETURN jsonb_build_object('root',value->>'root','policyHash',value->>'policyHash','nonce',value->>'nonce');
END $$;

-- All mutations acquire target then reservation locks in that order. This is the
-- target-wide quota/fencing authority; local journal directories cannot reset it.
CREATE FUNCTION testlane_private.check_owner(value jsonb, allow_expired boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target testlane_private.target%ROWTYPE; key text; observed timestamptz;
BEGIN
  SELECT * INTO target FROM testlane_private.target WHERE singleton FOR UPDATE;
  IF NOT FOUND OR target.policy_hash IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_STATE_INVALID'; END IF;
  observed := clock_timestamp();
  IF observed < target.last_observed_at THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_CLOCK_REFUSED'; END IF;
  IF NOT testlane_private.exact_object(value,ARRAY['targetId','policyHash','runId','releaseId','operationId','role','email','expiresAt']) THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
  END IF;
  FOREACH key IN ARRAY ARRAY['targetId','runId','operationId'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR (value->>key) !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
      RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
    END IF;
  END LOOP;
  IF value->>'targetId' IS DISTINCT FROM target.target_id::text OR value->>'policyHash' IS DISTINCT FROM target.policy_hash
    OR value->>'releaseId' IS DISTINCT FROM target.release_id
    OR jsonb_typeof(value->'policyHash') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'releaseId') IS DISTINCT FROM 'string'
    OR value->>'role' NOT IN ('Editor','Reviewer') OR allow_expired IS NULL
    OR jsonb_typeof(value->'role') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'email') IS DISTINCT FROM 'string'
    OR value->>'email' IS DISTINCT FROM 'tlp-'||(value->>'runId')||'-'||lower(value->>'role')||'@example.test'
    OR jsonb_typeof(value->'expiresAt') IS DISTINCT FROM 'number' OR (value->>'expiresAt') !~ '^[0-9]{1,16}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
  END IF;
  IF (value->>'expiresAt')::numeric NOT BETWEEN 1 AND 9007199254740991 THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
  END IF;
  IF NOT allow_expired AND (to_timestamp((value->>'expiresAt')::bigint/1000.0) <= observed
    OR to_timestamp((value->>'expiresAt')::bigint/1000.0) > observed+interval '10 minutes') THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_EXPIRED';
  END IF;
  UPDATE testlane_private.target SET last_observed_at=observed WHERE singleton;
END $$;

CREATE FUNCTION testlane_private.ensure_run(value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE run testlane_private.runs%ROWTYPE;
BEGIN
  SELECT * INTO run FROM testlane_private.runs WHERE run_id=(value->>'runId')::uuid;
  IF FOUND THEN
    IF run.target_id::text IS DISTINCT FROM value->>'targetId' OR run.release_id IS DISTINCT FROM value->>'releaseId'
      OR run.expires_at IS DISTINCT FROM to_timestamp((value->>'expiresAt')::bigint/1000.0) THEN
      RAISE EXCEPTION USING MESSAGE = 'PROVISION_RUN_REFUSED';
    END IF;
  ELSE
    IF (SELECT count(*) FROM testlane_private.runs) >= 1000 THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_QUOTA_REFUSED'; END IF;
    INSERT INTO testlane_private.runs(run_id,target_id,release_id,expires_at)
      VALUES((value->>'runId')::uuid,(value->>'targetId')::uuid,value->>'releaseId',to_timestamp((value->>'expiresAt')::bigint/1000.0));
  END IF;
END $$;

CREATE FUNCTION testlane_private.reserve(value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM testlane_private.check_owner(value,false);
  IF EXISTS(SELECT 1 FROM testlane_private.reservations WHERE operation_id=(value->>'operationId')::uuid
    OR (run_id=(value->>'runId')::uuid AND role=value->>'role')) THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_REPLAY_REFUSED';
  END IF;
  IF (SELECT count(*) FROM testlane_private.reservations) >= 1000
    OR (SELECT count(*) FROM testlane_private.reservations WHERE NOT revoked) >= 4
    OR (SELECT count(*) FROM testlane_private.reservations WHERE created_at>clock_timestamp()-interval '1 hour') >= 10
    OR (SELECT count(*) FROM testlane_private.reservations WHERE run_id=(value->>'runId')::uuid) >= 2 THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_QUOTA_REFUSED';
  END IF;
  PERFORM testlane_private.ensure_run(value);
  INSERT INTO testlane_private.reservations(operation_id,target_id,run_id,owner,role,email,expires_at)
    VALUES((value->>'operationId')::uuid,(value->>'targetId')::uuid,(value->>'runId')::uuid,value,value->>'role',value->>'email',to_timestamp((value->>'expiresAt')::bigint/1000.0));
  RETURN jsonb_build_object('id',NULL);
END $$;

CREATE FUNCTION testlane_private.inspect(value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry testlane_private.reservations%ROWTYPE; account auth.users%ROWTYPE; present boolean := false;
BEGIN
  PERFORM testlane_private.check_owner(value,true);
  SELECT * INTO entry FROM testlane_private.reservations WHERE operation_id=(value->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('present',false,'id',NULL,'revoked',false,'deliveryPending',false); END IF;
  IF entry.owner IS DISTINCT FROM value THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED'; END IF;
  IF entry.user_id IS NOT NULL THEN
    SELECT * INTO account FROM auth.users WHERE id=entry.user_id; present := FOUND;
    IF present AND (account.email IS DISTINCT FROM entry.email OR account.raw_app_meta_data->'testlane_owner' IS DISTINCT FROM value) THEN
      RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
    END IF;
  END IF;
  RETURN jsonb_build_object('present',present,'id',entry.user_id,'revoked',entry.revoked,'deliveryPending',entry.delivery_pending);
END $$;

CREATE FUNCTION testlane_private.delivery(value jsonb, pending boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry testlane_private.reservations%ROWTYPE;
BEGIN
  PERFORM testlane_private.check_owner(value,true);
  SELECT * INTO entry FROM testlane_private.reservations WHERE operation_id=(value->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR entry.owner IS DISTINCT FROM value OR pending IS NULL THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED'; END IF;
  IF pending AND (entry.revoked OR entry.delivery_pending OR entry.user_id IS NULL OR entry.expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=entry.user_id)) THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_RUN_REFUSED'; END IF;
  IF NOT pending AND NOT entry.delivery_pending THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_RUN_REFUSED'; END IF;
  UPDATE testlane_private.reservations SET delivery_pending=pending WHERE operation_id=entry.operation_id;
  RETURN jsonb_build_object('pending',pending);
END $$;

CREATE FUNCTION testlane_private.revoke(value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE entry testlane_private.reservations%ROWTYPE;
BEGIN
  PERFORM testlane_private.check_owner(value,true);
  -- inspect validates any bound live Auth identity before authority is returned.
  PERFORM testlane_private.inspect(value);
  SELECT * INTO entry FROM testlane_private.reservations WHERE operation_id=(value->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    IF (SELECT count(*) FROM testlane_private.reservations) >= 1000 THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_QUOTA_REFUSED'; END IF;
    IF EXISTS(SELECT 1 FROM testlane_private.reservations WHERE run_id=(value->>'runId')::uuid AND role=value->>'role') THEN
      RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
    END IF;
    PERFORM testlane_private.ensure_run(value);
    INSERT INTO testlane_private.reservations(operation_id,target_id,run_id,owner,role,email,expires_at,revoked)
      VALUES((value->>'operationId')::uuid,(value->>'targetId')::uuid,(value->>'runId')::uuid,value,value->>'role',value->>'email',to_timestamp((value->>'expiresAt')::bigint/1000.0),true);
    RETURN jsonb_build_object('id',NULL,'revoked',true,'deliveryPending',false);
  END IF;
  UPDATE testlane_private.reservations SET revoked=true WHERE operation_id=entry.operation_id;
  RETURN jsonb_build_object('id',entry.user_id,'revoked',true,'deliveryPending',entry.delivery_pending);
END $$;

CREATE FUNCTION testlane_private.guard_auth_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE expected_owner jsonb; entry testlane_private.reservations%ROWTYPE; account auth.users%ROWTYPE;
BEGIN
  -- GoTrue v2.197.0 inserts the row before applying role/app_metadata in the
  -- same transaction. The deferred fence must inspect the final stored row,
  -- never the initial NEW snapshot, and must reject the entire commit.
  SELECT * INTO account FROM auth.users WHERE id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED'; END IF;
  expected_owner := account.raw_app_meta_data->'testlane_owner';
  PERFORM testlane_private.check_owner(expected_owner,false);
  SELECT * INTO entry FROM testlane_private.reservations AS reservation WHERE reservation.operation_id=(expected_owner->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR entry.owner IS DISTINCT FROM expected_owner OR entry.revoked OR entry.user_id IS NOT NULL
    OR entry.delivery_pending OR entry.expires_at<=clock_timestamp() OR account.email IS DISTINCT FROM entry.email
    OR account.role IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION USING MESSAGE = 'PROVISION_OWNERSHIP_REFUSED';
  END IF;
  UPDATE testlane_private.reservations SET user_id=NEW.id WHERE operation_id=entry.operation_id;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER testlane_reserved_auth_insert AFTER INSERT ON auth.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION testlane_private.guard_auth_insert();

CREATE FUNCTION testlane_private.identity(subject uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; observed timestamptz; lower_bound timestamptz;
BEGIN
  IF subject IS NULL THEN RETURN NULL; END IF;
  observed := clock_timestamp();
  SELECT last_observed_at INTO lower_bound FROM testlane_private.target WHERE singleton;
  IF NOT FOUND OR observed < lower_bound THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id',account.id,'email',entry.email,'role',entry.role) INTO result
    FROM testlane_private.reservations AS entry JOIN auth.users AS account ON account.id=entry.user_id
    JOIN testlane_private.target AS target ON target.target_id=entry.target_id AND target.policy_hash=entry.owner->>'policyHash'
      AND target.release_id=entry.owner->>'releaseId'
    WHERE account.id=subject AND NOT entry.revoked AND entry.expires_at>observed
      AND account.role='authenticated' AND account.deleted_at IS NULL AND (account.banned_until IS NULL OR account.banned_until<=observed)
      AND account.email=entry.email AND account.raw_app_meta_data->'testlane_owner'=entry.owner;
  IF result IS NOT NULL THEN RETURN result; END IF;
  SELECT jsonb_build_object('id',account.id,'email',control.email,'role','Control') INTO result
    FROM testlane_private.control_grant AS control JOIN auth.users AS account ON account.id=control.user_id
    WHERE account.id=subject AND control.expires_at>observed AND account.role='authenticated' AND account.deleted_at IS NULL
      AND (account.banned_until IS NULL OR account.banned_until<=observed) AND account.email=control.email
      AND NOT (coalesce(account.raw_app_meta_data,'{}'::jsonb) ? 'testlane_owner');
  RETURN result;
END $$;

CREATE FUNCTION testlane_api.whoami() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT testlane_private.identity(auth.uid());
$$;
CREATE FUNCTION testlane_private.allow_record(owner_id uuid, writing boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE identity jsonb;
BEGIN
  IF writing IS NULL OR auth.uid() IS NULL OR owner_id IS DISTINCT FROM auth.uid() THEN RETURN false; END IF;
  identity := testlane_private.identity(auth.uid());
  RETURN identity IS NOT NULL AND CASE WHEN writing THEN identity->>'role'='Editor' ELSE identity->>'role' IN ('Editor','Reviewer','Control') END;
END $$;
CREATE TABLE testlane_api.proof_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  note text NOT NULL CHECK (note='synthetic'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE testlane_api.proof_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY proof_read ON testlane_api.proof_records FOR SELECT TO authenticated
  USING (testlane_private.allow_record(owner_id,false));
CREATE POLICY proof_insert ON testlane_api.proof_records FOR INSERT TO authenticated
  WITH CHECK (testlane_private.allow_record(owner_id,true));
CREATE POLICY proof_delete ON testlane_api.proof_records FOR DELETE TO authenticated
  USING (testlane_private.allow_record(owner_id,true));
REVOKE ALL ON ALL TABLES IN SCHEMA testlane_private, testlane_api FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA testlane_private, testlane_api FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA testlane_api, testlane_private TO authenticated;
GRANT EXECUTE ON FUNCTION testlane_api.whoami() TO authenticated;
GRANT EXECUTE ON FUNCTION testlane_private.allow_record(uuid,boolean) TO authenticated;
GRANT SELECT, DELETE ON testlane_api.proof_records TO authenticated;
GRANT INSERT(owner_id,note) ON testlane_api.proof_records TO authenticated;
COMMIT;
