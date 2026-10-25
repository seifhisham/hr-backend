import { TENANT_TABLES } from './schema.js';

export const RUNTIME_FUNCTIONS = [
  'hr_schema_version()',
  'hr_workspace_company(text)',
  'hr_session_actor(text,text)',
  'hr_active_companies()',
  'hr_company_revision()',
] as const;

export const RUNTIME_SCHEMA = `
  CREATE TABLE company_revisions(company_id uuid PRIMARY KEY REFERENCES companies(id), revision bigint NOT NULL DEFAULT 0);
  ALTER TABLE company_revisions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE company_revisions FORCE ROW LEVEL SECURITY;
  CREATE POLICY company_scope ON company_revisions USING(company_id=nullif(current_setting('hr.company_id',true),'')::uuid)
    WITH CHECK(company_id=nullif(current_setting('hr.company_id',true),'')::uuid);
  CREATE FUNCTION hr_company_revision() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $$ SELECT coalesce((SELECT revision FROM public.company_revisions
      WHERE company_id=nullif(current_setting('hr.company_id',true),'')::uuid),0) $$;
  CREATE FUNCTION hr_bump_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      INSERT INTO public.company_revisions(company_id,revision) VALUES(coalesce(NEW.company_id,OLD.company_id),1)
        ON CONFLICT(company_id) DO UPDATE SET revision=public.company_revisions.revision+1;
      RETURN NULL;
    END $$;
  ${TENANT_TABLES.map(
    (
      table,
    ) => `CREATE TRIGGER company_revision AFTER INSERT OR UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION hr_bump_revision();`,
  ).join('\n')}
  ${TENANT_TABLES.map(
    (table) => `ALTER TABLE ${table} ALTER COLUMN company_id
    SET DEFAULT nullif(current_setting('hr.company_id',true),'')::uuid;`,
  ).join('\n')}
  CREATE FUNCTION hr_schema_version() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $$ SELECT max(version) FROM public.schema_migrations $$;
  CREATE FUNCTION hr_workspace_company(workspace text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $$ SELECT id FROM public.companies
      WHERE lower(workspace_code)=lower(workspace) AND status='active' $$;
  CREATE FUNCTION hr_session_actor(token_hash text, at_time text)
    RETURNS TABLE(company_id uuid,id text,email text,name text,role text,employee_id text,active integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT u.company_id,u.id,u.email,u.name,u.role,u.employee_id,u.active
      FROM public.users u JOIN public.sessions s ON (s.company_id,s.user_id)=(u.company_id,u.id)
      JOIN public.companies c ON c.id=u.company_id
      WHERE s.hash=token_hash AND s.expires>at_time AND u.active=1 AND c.status='active'
    $$;
  CREATE FUNCTION hr_active_companies() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $$ SELECT id FROM public.companies WHERE status='active' $$;
  ${RUNTIME_FUNCTIONS.map((signature) => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`).join('\n')}
  CREATE FUNCTION hr_employee_fields() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    BEGIN
      NEW.employee_number := coalesce(NEW.data::jsonb->>'employeeNumber', NEW.employee_number);
      NEW.manager_id := NEW.data::jsonb->>'managerId';
      RETURN NEW;
    END $$;
  CREATE TRIGGER employee_fields BEFORE INSERT OR UPDATE OF data ON employees
    FOR EACH ROW EXECUTE FUNCTION hr_employee_fields();
  CREATE FUNCTION hr_initial_branch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    DECLARE branch uuid;
    BEGIN
      IF nullif(current_setting('hr.company_id',true),'') IS NULL THEN RETURN NEW; END IF;
      branch := nullif(NEW.data::jsonb->>'branchId','')::uuid;
      IF branch IS NULL THEN
        SELECT id INTO branch FROM public.branches WHERE company_id=NEW.company_id AND active
          AND (SELECT count(*) FROM public.branches WHERE company_id=NEW.company_id AND active)=1;
      END IF;
      IF branch IS NULL THEN RAISE EXCEPTION 'An assigned branch is required' USING ERRCODE='23514'; END IF;
      INSERT INTO public.employee_branches(company_id,employee_id,branch_id,effective_from)
        VALUES(NEW.company_id,NEW.id,branch,NEW.data::jsonb->>'startDate');
      RETURN NEW;
    END $$;
  CREATE TRIGGER initial_branch AFTER INSERT ON employees FOR EACH ROW EXECUTE FUNCTION hr_initial_branch();
  CREATE FUNCTION hr_attendance_branch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    DECLARE branch public.branches%ROWTYPE;
    BEGIN
      IF NEW.branch_id IS NOT NULL THEN RETURN NEW; END IF;
      SELECT b.* INTO branch FROM public.employee_branches a
        JOIN public.branches b ON (b.company_id,b.id)=(a.company_id,a.branch_id)
        WHERE a.company_id=NEW.company_id AND a.employee_id=NEW.employee_id AND a.effective_from<=NEW.work_date
        ORDER BY a.effective_from DESC LIMIT 1;
      IF branch.id IS NULL OR NOT branch.active THEN
        RAISE EXCEPTION 'An active assigned branch is required' USING ERRCODE='23514';
      END IF;
      NEW.branch_id := branch.id;
      NEW.branch_snapshot := jsonb_build_object('id',branch.id,'name',branch.name,'code',branch.code,'policy',branch.policy::jsonb)::text;
      RETURN NEW;
    END $$;
  CREATE TRIGGER attendance_branch BEFORE INSERT ON attendance FOR EACH ROW EXECUTE FUNCTION hr_attendance_branch();
  DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hr_runtime') THEN
      ${RUNTIME_FUNCTIONS.map((signature) => `GRANT EXECUTE ON FUNCTION ${signature} TO hr_runtime;`).join('\n')}
    END IF;
  END $$;
`;
