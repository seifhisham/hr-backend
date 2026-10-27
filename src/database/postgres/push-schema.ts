// Keep these separate from TENANT_TABLES: older migration checksums use that list.
export const PUSH_TABLES = [
  'push_devices',
  'push_events',
  'push_deliveries',
] as const;
export const PUSH_FUNCTIONS = ['hr_register_push(text,uuid,text)'] as const;

export const PUSH_SCHEMA = `
  CREATE TABLE push_devices (
    company_id uuid NOT NULL REFERENCES companies(id),
    device_id uuid PRIMARY KEY, binding_id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id text NOT NULL, session_hash text NOT NULL,
    token text NOT NULL UNIQUE, platform text NOT NULL DEFAULT 'android' CHECK(platform='android'),
    registered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id) ON DELETE CASCADE,
    FOREIGN KEY(company_id,session_hash) REFERENCES sessions(company_id,hash) ON DELETE CASCADE
  );
  CREATE TABLE push_events (
    company_id uuid NOT NULL REFERENCES companies(id), user_id text NOT NULL,
    notification_id text NOT NULL, type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(company_id,user_id,notification_id),
    FOREIGN KEY(company_id,user_id) REFERENCES users(company_id,id) ON DELETE CASCADE
  );
  CREATE TABLE push_deliveries (
    company_id uuid NOT NULL REFERENCES companies(id), user_id text NOT NULL,
    notification_id text NOT NULL, device_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','cancelled','failed')),
    attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
    lease_id uuid, lease_until timestamptz, last_code text, finished_at timestamptz,
    PRIMARY KEY(company_id,user_id,notification_id,device_id),
    FOREIGN KEY(company_id,user_id,notification_id) REFERENCES push_events(company_id,user_id,notification_id) ON DELETE CASCADE
  );
  CREATE INDEX push_deliveries_pending ON push_deliveries(company_id,next_attempt) WHERE state='pending';
  ${PUSH_TABLES.map(
    (table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} ALTER COLUMN company_id SET DEFAULT nullif(current_setting('hr.company_id',true),'')::uuid;
    CREATE POLICY company_scope ON ${table}
      USING(company_id=nullif(current_setting('hr.company_id',true),'')::uuid)
      WITH CHECK(company_id=nullif(current_setting('hr.company_id',true),'')::uuid);
  `,
  ).join('\n')}
  CREATE FUNCTION hr_register_push(h text,d uuid,t text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE a record;
    BEGIN
      SELECT * INTO a FROM public.hr_session_actor(h,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      IF a.id IS NULL OR a.company_id IS DISTINCT FROM nullif(current_setting('hr.company_id',true),'')::uuid
        OR a.id IS DISTINCT FROM current_setting('hr.actor_id',true) THEN
        RAISE EXCEPTION 'Invalid push session' USING ERRCODE='42501';
      END IF;
      IF length(t)<20 OR length(t)>4096 OR t ~ '[[:space:]]' THEN
        RAISE EXCEPTION 'Invalid registration token' USING ERRCODE='22023';
      END IF;
      -- Serialize global device/token transfers without exposing another tenant's binding.
      PERFORM pg_advisory_xact_lock(715104,6);
      DELETE FROM public.push_devices WHERE token=t AND device_id<>d;
      INSERT INTO public.push_devices(company_id,device_id,user_id,session_hash,token)
        VALUES(a.company_id,d,a.id,h,t)
      ON CONFLICT(device_id) DO UPDATE SET
        binding_id=CASE WHEN (push_devices.company_id,push_devices.user_id,push_devices.session_hash,push_devices.token)
          IS DISTINCT FROM (excluded.company_id,excluded.user_id,excluded.session_hash,excluded.token)
          THEN gen_random_uuid() ELSE push_devices.binding_id END,
        registered_at=CASE WHEN (push_devices.company_id,push_devices.user_id,push_devices.session_hash)
          IS DISTINCT FROM (excluded.company_id,excluded.user_id,excluded.session_hash)
          THEN now() ELSE push_devices.registered_at END,
        company_id=excluded.company_id,user_id=excluded.user_id,session_hash=excluded.session_hash,
        token=excluded.token,updated_at=now();
    END $$;
  REVOKE ALL ON FUNCTION hr_register_push(text,uuid,text) FROM PUBLIC;
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hr_runtime') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${PUSH_TABLES.join(',')} TO hr_runtime;
    GRANT EXECUTE ON FUNCTION hr_register_push(text,uuid,text) TO hr_runtime;
  END IF; END $$;
`;
