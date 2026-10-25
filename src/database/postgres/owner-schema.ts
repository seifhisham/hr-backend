export const OWNER_FUNCTIONS = [
  'hr_owner_credentials(text)',
  'hr_owner_login(text,text,bigint,text,text)',
  'hr_owner_session(text)',
  'hr_owner_setup(text,text,jsonb)',
  'hr_owner_command(text,text,jsonb)',
  'hr_company_invitation(text,text,jsonb)',
] as const;

export const OWNER_SCHEMA = `
  CREATE TABLE platform_owners (
    id uuid PRIMARY KEY, email text NOT NULL, name text NOT NULL,
    password_hash text, totp_secret text, last_totp_counter bigint NOT NULL DEFAULT -1,
    recovery_hashes jsonb NOT NULL DEFAULT '[]', active boolean NOT NULL DEFAULT true,
    setup_hash text UNIQUE, setup_expires timestamptz, pending_secret text,
    setup_failures integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX platform_owner_email ON platform_owners(lower(email));
  CREATE TABLE platform_sessions (
    hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES platform_owners(id), expires timestamptz NOT NULL
  );
  CREATE INDEX platform_sessions_owner ON platform_sessions(owner_id);
  CREATE TABLE platform_login_limits(email text PRIMARY KEY, failures integer NOT NULL, reset_at timestamptz NOT NULL);
  CREATE TABLE platform_audit (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES platform_owners(id), action text NOT NULL,
    company_id uuid REFERENCES companies(id), details jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX platform_audit_company ON platform_audit(company_id,sequence);
  CREATE TABLE platform_company_setup (
    company_id uuid PRIMARY KEY REFERENCES companies(id), request_key uuid UNIQUE NOT NULL,
    fingerprint text NOT NULL, admin_email text NOT NULL, admin_name text NOT NULL,
    complete boolean NOT NULL DEFAULT false
  );
  CREATE TABLE platform_invitations (
    request_key uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
    owner_id uuid NOT NULL REFERENCES platform_owners(id), token_hash text UNIQUE NOT NULL,
    token_cipher text NOT NULL, expires timestamptz NOT NULL, used_at timestamptz, revoked boolean NOT NULL DEFAULT false
  );
  CREATE INDEX platform_invitations_company ON platform_invitations(company_id);
  REVOKE ALL ON platform_owners,platform_sessions,platform_login_limits,platform_audit,platform_company_setup,platform_invitations FROM PUBLIC;

  CREATE FUNCTION hr_owner_credentials(e text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      IF EXISTS(SELECT 1 FROM public.platform_login_limits WHERE email=lower(e) AND failures>=5 AND reset_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'Too many attempts. Try again in 15 minutes.' USING ERRCODE='HR429'; END IF;
      RETURN (SELECT jsonb_build_object('passwordHash',password_hash,'secret',totp_secret)
        FROM public.platform_owners WHERE lower(email)=lower(e) AND active AND password_hash IS NOT NULL);
    END $$;
  CREATE FUNCTION hr_owner_login(e text,verified_hash text,counter bigint,recovery text,session_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE o public.platform_owners; valid boolean; result jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('owner-login:'||lower(e),0));
      IF EXISTS(SELECT 1 FROM public.platform_login_limits WHERE email=lower(e) AND failures>=5 AND reset_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'Too many attempts. Try again in 15 minutes.' USING ERRCODE='HR429'; END IF;
      SELECT * INTO o FROM public.platform_owners WHERE lower(email)=lower(e) FOR UPDATE;
      valid:=o.id IS NOT NULL AND o.active AND o.password_hash=verified_hash
        AND ((counter IS NOT NULL AND counter>o.last_totp_counter) OR (recovery IS NOT NULL AND o.recovery_hashes ? recovery));
      IF valid IS NOT TRUE THEN
        DELETE FROM public.platform_login_limits WHERE reset_at<=clock_timestamp();
        INSERT INTO public.platform_login_limits(email,failures,reset_at) VALUES(lower(e),1,clock_timestamp()+interval '15 minutes')
          ON CONFLICT(email) DO UPDATE SET failures=public.platform_login_limits.failures+1;
        RETURN NULL;
      END IF;
      UPDATE public.platform_owners SET last_totp_counter=coalesce(counter,last_totp_counter),
        recovery_hashes=CASE WHEN recovery IS NULL THEN recovery_hashes ELSE recovery_hashes-recovery END WHERE id=o.id;
      DELETE FROM public.platform_login_limits WHERE email=lower(e);
      DELETE FROM public.platform_sessions WHERE expires<=clock_timestamp();
      INSERT INTO public.platform_sessions VALUES(session_hash,o.id,clock_timestamp()+interval '4 hours');
      INSERT INTO public.platform_audit(owner_id,action,details) VALUES(o.id,'owner.signed_in',jsonb_build_object('recoveryUsed',recovery IS NOT NULL));
      RETURN jsonb_build_object('id',o.id,'email',o.email,'name',o.name,'recoveryUsed',recovery IS NOT NULL);
    END $$;
  CREATE FUNCTION hr_owner_session(h text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('id',o.id,'email',o.email,'name',o.name,'expiresAt',s.expires)
    FROM public.platform_sessions s JOIN public.platform_owners o ON o.id=s.owner_id
    WHERE s.hash=h AND s.expires>now() AND o.active AND o.password_hash IS NOT NULL $$;

  CREATE FUNCTION hr_owner_setup(h text,operation text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE o public.platform_owners;
    BEGIN
      SELECT * INTO o FROM public.platform_owners WHERE setup_hash=h FOR UPDATE;
      IF o.id IS NULL OR NOT o.active OR o.setup_expires<=clock_timestamp() OR o.setup_failures>=10 THEN
        RAISE EXCEPTION 'Setup link is invalid or expired.' USING ERRCODE='HR401'; END IF;
      IF operation='prepare' THEN
        UPDATE public.platform_owners SET pending_secret=coalesce(pending_secret,p->>'secret') WHERE id=o.id RETURNING * INTO o;
        RETURN jsonb_build_object('email',o.email,'name',o.name,'secret',o.pending_secret);
      ELSIF operation='fail' THEN
        UPDATE public.platform_owners SET setup_failures=setup_failures+1 WHERE id=o.id; RETURN NULL;
      ELSIF operation='complete' THEN
        IF o.pending_secret IS NULL OR o.pending_secret IS DISTINCT FROM p->>'expectedSecret' THEN
          RAISE EXCEPTION 'Prepare authenticator setup first.' USING ERRCODE='HR409'; END IF;
        UPDATE public.platform_owners SET name=p->>'name',password_hash=p->>'passwordHash',totp_secret=pending_secret,
          last_totp_counter=(p->>'counter')::bigint,recovery_hashes=p->'recoveryHashes',setup_hash=NULL,setup_expires=NULL,
          pending_secret=NULL,setup_failures=0 WHERE id=o.id;
        DELETE FROM public.platform_sessions WHERE owner_id=o.id;
        DELETE FROM public.platform_login_limits WHERE email=lower(o.email);
        INSERT INTO public.platform_audit(owner_id,action) VALUES(o.id,'owner.credentials_enrolled');
        RETURN jsonb_build_object('email',o.email);
      END IF;
      RAISE EXCEPTION 'Unknown setup operation.' USING ERRCODE='HR400';
    END $$;

  CREATE FUNCTION hr_owner_command(h text,operation text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE owner uuid; c public.companies; setup public.platform_company_setup; invite public.platform_invitations;
      result jsonb; company_uuid uuid; target text;
    BEGIN
      SELECT o.id INTO owner FROM public.platform_sessions s JOIN public.platform_owners o ON o.id=s.owner_id
        WHERE s.hash=h AND s.expires>clock_timestamp() AND o.active FOR SHARE OF s,o;
      IF owner IS NULL THEN RAISE EXCEPTION 'Please sign in as platform owner.' USING ERRCODE='HR401'; END IF;
      IF operation='companies' THEN
        RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',co.id,'workspace',co.workspace_code,'name',co.name,
          'timezone',co.timezone,'status',co.status,'createdAt',co.created_at,'setupComplete',coalesce(s.complete,true),
          'adminEmail',s.admin_email,'invitationExpiresAt',(SELECT max(i.expires) FROM public.platform_invitations i
            WHERE i.company_id=co.id AND NOT i.revoked AND i.used_at IS NULL)) ORDER BY co.created_at,co.id)
          FROM public.companies co LEFT JOIN public.platform_company_setup s ON s.company_id=co.id),'[]');
      ELSIF operation='audit' THEN
        RETURN coalesce((SELECT jsonb_agg(row ORDER BY row.sequence DESC) FROM (SELECT a.sequence,o.name AS actor,a.action,
          a.company_id AS "companyId",a.details,a.at FROM public.platform_audit a JOIN public.platform_owners o ON o.id=a.owner_id
          ORDER BY a.sequence DESC LIMIT 100) row),'[]');
      ELSIF operation='logout' THEN
        DELETE FROM public.platform_sessions WHERE hash=h; RETURN '{"message":"Signed out"}';
      ELSIF operation='recover' THEN
        UPDATE public.platform_owners SET setup_hash=p->>'hash',setup_expires=clock_timestamp()+interval '15 minutes',
          pending_secret=NULL,setup_failures=0 WHERE id=owner;
        INSERT INTO public.platform_audit(owner_id,action) VALUES(owner,'owner.recovery_started');
        RETURN jsonb_build_object('expiresAt',clock_timestamp()+interval '15 minutes');
      ELSIF operation='create' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('company-create:'||(p->>'requestId'),0));
        SELECT * INTO setup FROM public.platform_company_setup WHERE request_key=(p->>'requestId')::uuid;
        IF setup.company_id IS NOT NULL THEN
          IF setup.fingerprint IS DISTINCT FROM p->>'fingerprint' THEN RAISE EXCEPTION 'Request ID already used for different company details.' USING ERRCODE='HR409'; END IF;
          RETURN jsonb_build_object('id',setup.company_id);
        END IF;
        company_uuid:=(p->>'id')::uuid;
        INSERT INTO public.companies(id,workspace_code,name,timezone,status) VALUES(company_uuid,p->>'workspace',p->>'name',p->>'timezone','provisioning');
        PERFORM set_config('hr.company_id',company_uuid::text,true);
        INSERT INTO public.platform_company_setup VALUES(company_uuid,(p->>'requestId')::uuid,p->>'fingerprint',p->>'adminEmail',p->>'adminName',false);
        INSERT INTO public.branches(company_id,id,code,name,policy) VALUES(company_uuid,(p->>'branchId')::uuid,'main','Main branch','{"configured":false}');
        INSERT INTO public.settings(company_id,key,value) VALUES(company_uuid,'company',jsonb_build_object('name',p->>'name','timezone',p->>'timezone')::text);
        INSERT INTO public.schedules(company_id,id,data) SELECT company_uuid,item->>'id',item::text FROM jsonb_array_elements(p->'schedules') item;
        INSERT INTO public.platform_audit(owner_id,action,company_id,details) VALUES(owner,'company.created',company_uuid,
          jsonb_build_object('workspace',p->>'workspace','name',p->>'name'));
        RETURN jsonb_build_object('id',company_uuid);
      END IF;

      company_uuid:=(p->>'companyId')::uuid;
      PERFORM pg_advisory_xact_lock(hashtextextended(company_uuid::text,0));
      SELECT * INTO c FROM public.companies WHERE id=company_uuid FOR UPDATE;
      IF c.id IS NULL THEN RAISE EXCEPTION 'Company not found.' USING ERRCODE='HR404'; END IF;
      PERFORM set_config('hr.company_id',company_uuid::text,true);
      IF operation='invitation' THEN
        IF c.status<>'provisioning' OR NOT EXISTS(SELECT 1 FROM public.platform_company_setup WHERE company_id=c.id AND NOT complete)
          OR EXISTS(SELECT 1 FROM public.users WHERE company_id=c.id AND role='admin') THEN
          RAISE EXCEPTION 'Only a new company awaiting administrator setup can be invited.' USING ERRCODE='HR409'; END IF;
        SELECT * INTO invite FROM public.platform_invitations WHERE request_key=(p->>'requestId')::uuid;
        IF invite.request_key IS NOT NULL THEN
          IF invite.company_id<>c.id OR invite.revoked OR invite.used_at IS NOT NULL OR invite.expires<=clock_timestamp() THEN
            RAISE EXCEPTION 'Invitation request is no longer reusable; use a new request ID.' USING ERRCODE='HR409'; END IF;
        ELSE
          UPDATE public.platform_invitations SET revoked=true WHERE company_id=c.id AND used_at IS NULL;
          INSERT INTO public.platform_invitations VALUES((p->>'requestId')::uuid,c.id,owner,p->>'hash',p->>'cipher',clock_timestamp()+interval '24 hours',NULL,false) RETURNING * INTO invite;
          INSERT INTO public.platform_audit(owner_id,action,company_id) VALUES(owner,'company.administrator_invited',c.id);
        END IF;
        RETURN jsonb_build_object('cipher',invite.token_cipher,'expiresAt',invite.expires);
      ELSIF operation='revoke-invitation' THEN
        UPDATE public.platform_invitations SET revoked=true WHERE company_id=c.id AND used_at IS NULL;
        INSERT INTO public.platform_audit(owner_id,action,company_id,details) VALUES(owner,'company.invitation_revoked',c.id,jsonb_build_object('reason',p->>'reason'));
        RETURN '{"message":"Invitation revoked"}';
      ELSIF operation='status' THEN
        target:=p->>'status';
        IF c.status IS DISTINCT FROM p->>'expectedStatus' THEN RAISE EXCEPTION 'Company status changed; refresh before trying again.' USING ERRCODE='HR409'; END IF;
        IF c.status='archived' OR target=c.status OR NOT (
          (c.status='provisioning' AND target IN ('active','archived')) OR (c.status='active' AND target IN ('suspended','archived'))
          OR (c.status='suspended' AND target IN ('active','archived'))) THEN
          RAISE EXCEPTION 'Invalid company status transition.' USING ERRCODE='HR409'; END IF;
        IF target='active' AND (NOT EXISTS(SELECT 1 FROM public.users WHERE company_id=c.id AND role='admin' AND active=1)
          OR EXISTS(SELECT 1 FROM public.platform_company_setup WHERE company_id=c.id AND NOT complete)
          OR NOT EXISTS(SELECT 1 FROM public.branches WHERE company_id=c.id AND active AND (policy::jsonb ? 'latitude') AND (policy::jsonb ? 'longitude'))) THEN
          RAISE EXCEPTION 'Administrator and branch setup must be complete before activation.' USING ERRCODE='HR409'; END IF;
        DELETE FROM public.sessions WHERE company_id=c.id;
        UPDATE public.attendance_location l SET data=(l.data::jsonb||jsonb_build_object('status','unavailable','lastCapturedAt',NULL,
          'outsideSince',NULL,'returnBy',NULL,'distanceMeters',NULL,'accuracyMeters',NULL))::text
          WHERE l.company_id=c.id AND EXISTS(SELECT 1 FROM public.attendance a WHERE (a.company_id,a.id)=(l.company_id,l.attendance_id) AND a.check_out IS NULL);
        IF target IN ('suspended','archived') THEN UPDATE public.platform_invitations SET revoked=true WHERE company_id=c.id AND used_at IS NULL; END IF;
        UPDATE public.companies SET status=target WHERE id=c.id;
        INSERT INTO public.platform_audit(owner_id,action,company_id,details) VALUES(owner,'company.status_changed',c.id,
          jsonb_build_object('from',c.status,'to',target,'reason',p->>'reason'));
        RETURN jsonb_build_object('id',c.id,'status',target);
      END IF;
      RAISE EXCEPTION 'Unknown platform operation.' USING ERRCODE='HR400';
    END $$;

  CREATE FUNCTION hr_company_invitation(h text,operation text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE i public.platform_invitations; c public.companies; s public.platform_company_setup; branch uuid;
    BEGIN
      SELECT * INTO i FROM public.platform_invitations WHERE token_hash=h;
      IF i.company_id IS NULL THEN RAISE EXCEPTION 'Invitation is invalid or expired.' USING ERRCODE='HR401'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(i.company_id::text,0));
      SELECT * INTO c FROM public.companies WHERE id=i.company_id FOR UPDATE;
      SELECT * INTO i FROM public.platform_invitations WHERE token_hash=h FOR UPDATE;
      SELECT * INTO s FROM public.platform_company_setup WHERE company_id=c.id FOR UPDATE;
      IF c.status<>'provisioning' OR i.revoked OR i.used_at IS NOT NULL OR i.expires<=clock_timestamp() OR s.complete THEN
        RAISE EXCEPTION 'Invitation is invalid or expired.' USING ERRCODE='HR401'; END IF;
      IF operation='preview' THEN RETURN jsonb_build_object('workspace',c.workspace_code,'companyName',c.name,'timezone',c.timezone,
        'email',s.admin_email,'name',s.admin_name,'expiresAt',i.expires); END IF;
      IF operation<>'accept' THEN RAISE EXCEPTION 'Unknown invitation operation.' USING ERRCODE='HR400'; END IF;
      PERFORM set_config('hr.company_id',c.id::text,true);
      IF EXISTS(SELECT 1 FROM public.users WHERE company_id=c.id AND role='admin') THEN RAISE EXCEPTION 'Company already has an administrator.' USING ERRCODE='HR409'; END IF;
      INSERT INTO public.users(company_id,id,email,name,role,employee_id,active,password_hash) VALUES(c.id,p->>'userId',s.admin_email,p->>'name','admin',NULL,1,p->>'passwordHash');
      UPDATE public.branches SET name=p->>'branchName',policy=(p->'policy')::text WHERE company_id=c.id AND code='main' RETURNING id INTO branch;
      IF branch IS NULL THEN RAISE EXCEPTION 'Initial branch is missing.' USING ERRCODE='HR409'; END IF;
      UPDATE public.settings SET value=(jsonb_build_object('name',c.name,'timezone',c.timezone)||(p->'policy'))::text WHERE company_id=c.id AND key='company';
      UPDATE public.platform_company_setup SET complete=true WHERE company_id=c.id;
      UPDATE public.platform_invitations SET used_at=clock_timestamp() WHERE request_key=i.request_key;
      INSERT INTO public.platform_audit(owner_id,action,company_id) VALUES(i.owner_id,'company.administrator_enrolled',c.id);
      RETURN jsonb_build_object('workspace',c.workspace_code,'status','provisioning','message','Setup complete. The platform owner must activate your company before sign-in.');
    END $$;
  ${OWNER_FUNCTIONS.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC;`).join('\n')}
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hr_runtime') THEN
    ${OWNER_FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO hr_runtime;`).join('\n')}
  END IF; END $$;
`;
