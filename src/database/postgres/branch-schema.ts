export const BRANCH_FUNCTIONS = [
  'hr_payroll_locked(text)',
  'hr_request_locked(text)',
  'hr_grant_signature(uuid,text)',
  'hr_visible_assignments(text,text)',
  'hr_branch_visible(uuid)',
  'hr_branch_at(text,text)',
  'hr_month_visible(text,text)',
  'hr_employee_history(text,text)',
  'hr_workflow_employee(text)',
  'hr_payroll_run(text)',
] as const;

export const BRANCH_SCHEMA = `
  CREATE UNIQUE INDEX sessions_hash ON sessions(hash);
  ALTER TABLE employee_branches ADD COLUMN employee_snapshot text;
  UPDATE employee_branches a SET employee_snapshot=e.data FROM employees e
    WHERE (e.company_id,e.id)=(a.company_id,a.employee_id);
  ALTER TABLE employee_branches ALTER COLUMN employee_snapshot SET NOT NULL;
  CREATE FUNCTION hr_assignment_snapshot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      IF NEW.employee_snapshot IS NULL THEN SELECT data INTO NEW.employee_snapshot FROM public.employees WHERE company_id=NEW.company_id AND id=NEW.employee_id; END IF;
      RETURN NEW;
    END $$;
  CREATE TRIGGER assignment_snapshot BEFORE INSERT ON employee_branches FOR EACH ROW EXECUTE FUNCTION hr_assignment_snapshot();
  CREATE INDEX assignments_branch ON employee_branches(company_id,branch_id,employee_id,effective_from);
  CREATE FUNCTION hr_resolve_branch(c uuid,e text,d text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog AS $$ SELECT branch_id FROM public.employee_branches
      WHERE company_id=c AND employee_id=e
      ORDER BY (effective_from<=d) DESC, CASE WHEN effective_from<=d THEN effective_from END DESC,effective_from ASC LIMIT 1 $$;
  REVOKE ALL ON FUNCTION hr_resolve_branch(uuid,text,text) FROM PUBLIC;
  CREATE FUNCTION hr_branch_at(e text,d text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT public.hr_resolve_branch(nullif(current_setting('hr.company_id',true),'')::uuid,e,d) $$;
  CREATE FUNCTION hr_grant_signature(c uuid,u text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT coalesce(string_agg(branch_id::text,',' ORDER BY branch_id),'') FROM public.hr_branch_grants WHERE company_id=c AND user_id=u $$;
  CREATE FUNCTION hr_branch_visible(b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT coalesce(current_setting('hr.actor_role',true),'')<>'hr' OR current_setting('hr.personal',true)='true'
      OR EXISTS(SELECT 1 FROM public.hr_branch_grants WHERE company_id=nullif(current_setting('hr.company_id',true),'')::uuid
        AND user_id=current_setting('hr.actor_id',true) AND branch_id=b) $$;
  CREATE FUNCTION hr_month_visible(e text,m text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT public.hr_branch_visible(public.hr_branch_at(e,m||'-01')) AND NOT EXISTS(
      SELECT 1 FROM public.employee_branches a WHERE a.company_id=nullif(current_setting('hr.company_id',true),'')::uuid
      AND a.employee_id=e AND a.effective_from>=m||'-01'
      AND a.effective_from<to_char((m||'-01')::date+interval '1 month','YYYY-MM-DD') AND NOT public.hr_branch_visible(a.branch_id)) $$;
  CREATE FUNCTION hr_employee_history(e text,d text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT CASE WHEN a.branch_id=public.hr_branch_at(e,current_setting('hr.today',true))
      THEN (SELECT data FROM public.employees WHERE company_id=a.company_id AND id=e) ELSE a.employee_snapshot END FROM public.employee_branches a
      WHERE a.company_id=nullif(current_setting('hr.company_id',true),'')::uuid AND a.employee_id=e
      AND a.branch_id=public.hr_branch_at(e,d) AND public.hr_branch_visible(a.branch_id)
      ORDER BY (a.effective_from<=d) DESC,a.effective_from DESC LIMIT 1 $$;
  CREATE FUNCTION hr_visible_assignments(first_day text,last_day text)
    RETURNS TABLE(employee_id text,branch_id uuid,effective_from text,effective_to text,employee_snapshot text,branch_name text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    WITH spans AS (SELECT a.*,lead(a.effective_from) OVER(PARTITION BY a.company_id,a.employee_id ORDER BY a.effective_from) AS end_date
      FROM public.employee_branches a WHERE a.company_id=nullif(current_setting('hr.company_id',true),'')::uuid)
    SELECT a.employee_id,a.branch_id,a.effective_from,coalesce(a.end_date,'9999-12-31'),
      CASE WHEN a.branch_id=public.hr_branch_at(a.employee_id,current_setting('hr.today',true)) THEN e.data ELSE a.employee_snapshot END,b.name
    FROM spans a JOIN public.employees e ON (e.company_id,e.id)=(a.company_id,a.employee_id) JOIN public.branches b ON (b.company_id,b.id)=(a.company_id,a.branch_id)
    WHERE public.hr_branch_visible(a.branch_id) AND a.effective_from<=last_day AND coalesce(a.end_date,'9999-12-31')>first_day ORDER BY a.employee_id,a.effective_from $$;
  CREATE FUNCTION hr_workflow_employee(e text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('id',id,'managerId',manager_id,'department',data::jsonb->>'department',
      'role',data::jsonb->>'role','active',(data::jsonb->>'active')::boolean)::text FROM public.employees
      WHERE company_id=nullif(current_setting('hr.company_id',true),'')::uuid AND id=e $$;
  CREATE FUNCTION hr_payroll_locked(m text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT EXISTS(SELECT 1 FROM public.payroll_runs WHERE company_id=nullif(current_setting('hr.company_id',true),'')::uuid AND month=m) $$;
  CREATE FUNCTION hr_request_locked(request text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT p.month FROM public.payroll_runs p,jsonb_array_elements(p.data::jsonb->'rows') r(value),jsonb_array_elements(r.value->'deductions') d(value)
      WHERE p.company_id=nullif(current_setting('hr.company_id',true),'')::uuid AND d.value->>'requestId'=request LIMIT 1 $$;
  CREATE FUNCTION hr_payroll_run(m text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT (r.data::jsonb || jsonb_build_object('rows',coalesce((SELECT jsonb_agg(row) FROM jsonb_array_elements(r.data::jsonb->'rows') row
      WHERE public.hr_month_visible(row->>'employeeId',m)),'[]'::jsonb),'revision','branch-view','approvedBy',null,
      'approvedById',null,'approvalReason',null))::text FROM public.payroll_runs r
      WHERE r.company_id=nullif(current_setting('hr.company_id',true),'')::uuid AND r.month=m $$;

  CREATE OR REPLACE FUNCTION hr_initial_branch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
    DECLARE branch uuid;
    BEGIN
      IF nullif(current_setting('hr.company_id',true),'') IS NULL THEN RETURN NEW; END IF;
      branch:=nullif(NEW.data::jsonb->>'branchId','')::uuid;
      IF branch IS NULL THEN SELECT id INTO branch FROM public.branches WHERE company_id=NEW.company_id AND active
        AND (SELECT count(*) FROM public.branches WHERE company_id=NEW.company_id AND active)=1; END IF;
      IF branch IS NULL THEN RAISE EXCEPTION 'An assigned branch is required' USING ERRCODE='23514'; END IF;
      INSERT INTO public.employee_branches(company_id,employee_id,branch_id,effective_from,employee_snapshot)
        VALUES(NEW.company_id,NEW.id,branch,NEW.data::jsonb->>'startDate',NEW.data);
      RETURN NEW;
    END $$;

  ${[
    'employee_requests',
    'payroll_deductions',
    'sales_activities',
    'sales_targets',
    'audit',
  ]
    .map(
      (t) => `ALTER TABLE ${t} ADD COLUMN branch_id uuid;
    ALTER TABLE ${t} ADD CONSTRAINT ${t}_branch_fk FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id);`,
    )
    .join('\n')}
  UPDATE employee_requests r SET branch_id=coalesce((SELECT branch_id FROM attendance a WHERE (a.company_id,a.id)=(r.company_id,r.data::jsonb->>'attendanceId')),
    hr_resolve_branch(r.company_id,r.employee_id,coalesce(r.data::jsonb->>'from',substr(r.data::jsonb->>'submittedAt',1,10))));
  UPDATE payroll_deductions SET branch_id=hr_resolve_branch(company_id,employee_id,month||'-01');
  UPDATE sales_activities SET branch_id=hr_resolve_branch(company_id,employee_id,activity_date);
  UPDATE sales_targets SET branch_id=hr_resolve_branch(company_id,employee_id,month||'-01');

  CREATE FUNCTION hr_audit_branch(c uuid,action text,record text,at_time text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE b uuid;
    BEGIN
      IF action LIKE 'attendance.%' THEN SELECT branch_id INTO b FROM public.attendance WHERE company_id=c AND id=record;
      ELSIF action LIKE 'request.%' THEN SELECT branch_id INTO b FROM public.employee_requests WHERE company_id=c AND id=record;
      ELSIF action LIKE 'sales.activity.%' THEN SELECT branch_id INTO b FROM public.sales_activities WHERE company_id=c AND id=record;
      ELSIF action='payroll.deduction.created' THEN SELECT branch_id INTO b FROM public.payroll_deductions WHERE company_id=c AND id=record;
      ELSIF action IN ('employee.created','employee.updated','employee.schedule_assigned','sales.target.saved') THEN b:=public.hr_resolve_branch(c,record,to_char(at_time::timestamptz AT TIME ZONE (SELECT timezone FROM public.companies WHERE id=c),'YYYY-MM-DD'));
      END IF;
      RETURN b;
    END $$;
  REVOKE ALL ON FUNCTION hr_audit_branch(uuid,text,text,text) FROM PUBLIC;
  UPDATE audit SET branch_id=CASE WHEN action='employee.schedule_assigned' THEN hr_resolve_branch(company_id,record_id,after_data::jsonb->>'effectiveFrom')
    WHEN action='sales.target.saved' THEN hr_resolve_branch(company_id,record_id,(after_data::jsonb->>'month')||'-01')
    ELSE hr_audit_branch(company_id,action,record_id,at) END;
  CREATE FUNCTION hr_record_branch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF TG_TABLE_NAME='sales_activities' THEN
          IF NEW.activity_date<>OLD.activity_date AND public.hr_resolve_branch(NEW.company_id,NEW.employee_id,NEW.activity_date) IS DISTINCT FROM OLD.branch_id THEN
            RAISE EXCEPTION 'Activity date crosses a branch transfer' USING ERRCODE='23514'; END IF;
        END IF;
        NEW.branch_id:=OLD.branch_id; RETURN NEW;
      END IF;
      IF TG_TABLE_NAME='employee_requests' THEN
        IF NEW.data::jsonb->>'type'='forgotten-check-out' THEN
          SELECT branch_id INTO NEW.branch_id FROM public.attendance WHERE company_id=NEW.company_id AND id=NEW.data::jsonb->>'attendanceId';
        ELSE NEW.branch_id:=public.hr_resolve_branch(NEW.company_id,NEW.employee_id,NEW.data::jsonb->>'from'); END IF;
      ELSIF TG_TABLE_NAME IN ('payroll_deductions','sales_targets') THEN NEW.branch_id:=public.hr_resolve_branch(NEW.company_id,NEW.employee_id,NEW.month||'-01');
      ELSIF TG_TABLE_NAME='sales_activities' THEN NEW.branch_id:=public.hr_resolve_branch(NEW.company_id,NEW.employee_id,NEW.activity_date);
      ELSE
      IF NEW.action='employee.schedule_assigned' THEN NEW.branch_id:=public.hr_resolve_branch(NEW.company_id,NEW.record_id,NEW.after_data::jsonb->>'effectiveFrom');
      ELSIF NEW.action='sales.target.saved' THEN NEW.branch_id:=public.hr_resolve_branch(NEW.company_id,NEW.record_id,(NEW.after_data::jsonb->>'month')||'-01');
      ELSE NEW.branch_id:=public.hr_audit_branch(NEW.company_id,NEW.action,NEW.record_id,NEW.at); END IF; END IF;
      RETURN NEW;
    END $$;
  ${[
    'employee_requests',
    'payroll_deductions',
    'sales_activities',
    'sales_targets',
    'audit',
  ]
    .map(
      (
        t,
      ) => `CREATE TRIGGER record_branch BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION hr_record_branch();
    CREATE INDEX ${t}_branch ON ${t}(company_id,branch_id);`,
    )
    .join('\n')}

  CREATE POLICY hr_branches ON branches AS RESTRICTIVE USING(hr_branch_visible(id))
    WITH CHECK(coalesce(current_setting('hr.actor_role',true),'')<>'hr');
  CREATE POLICY hr_grants ON hr_branch_grants AS RESTRICTIVE USING(true)
    WITH CHECK(coalesce(current_setting('hr.actor_role',true),'')<>'hr');
  CREATE POLICY hr_branch_delete ON branches AS RESTRICTIVE FOR DELETE
    USING(coalesce(current_setting('hr.actor_role',true),'')<>'hr');
  CREATE POLICY hr_grant_delete ON hr_branch_grants AS RESTRICTIVE FOR DELETE
    USING(coalesce(current_setting('hr.actor_role',true),'')<>'hr');
  CREATE POLICY hr_assignments ON employee_branches AS RESTRICTIVE USING(hr_branch_visible(branch_id))
    WITH CHECK(coalesce(current_setting('hr.actor_role',true),'')<>'hr' OR hr_branch_visible(branch_id));
  CREATE POLICY hr_employees ON employees AS RESTRICTIVE
    USING(hr_branch_visible(hr_branch_at(id,current_setting('hr.today',true))))
    WITH CHECK(hr_branch_visible(coalesce(nullif(data::jsonb->>'branchId','')::uuid,hr_branch_at(id,current_setting('hr.today',true)),
      (SELECT id FROM branches WHERE active LIMIT 1))));
  ${['attendance', 'employee_requests', 'sales_activities'].map((t) => `CREATE POLICY hr_records ON ${t} AS RESTRICTIVE USING(hr_branch_visible(branch_id)) WITH CHECK(hr_branch_visible(branch_id));`).join('\n')}
  CREATE POLICY hr_records ON audit AS RESTRICTIVE USING(hr_branch_visible(branch_id) AND
    CASE WHEN action IN ('payroll.deduction.created','sales.target.saved') THEN hr_month_visible(after_data::jsonb->>'employeeId',after_data::jsonb->>'month') ELSE true END)
    WITH CHECK(branch_id IS NULL OR hr_branch_visible(branch_id));
  ${['payroll_deductions', 'sales_targets'].map((t) => `CREATE POLICY hr_records ON ${t} AS RESTRICTIVE USING(hr_branch_visible(branch_id) AND hr_month_visible(employee_id,month)) WITH CHECK(hr_branch_visible(branch_id) AND hr_month_visible(employee_id,month));`).join('\n')}
  CREATE POLICY hr_payroll ON payroll_runs AS RESTRICTIVE
    USING(coalesce(current_setting('hr.actor_role',true),'')<>'hr') WITH CHECK(coalesce(current_setting('hr.actor_role',true),'')<>'hr');
  ${['attendance_evidence', 'attendance_location']
    .map(
      (t) => `CREATE POLICY hr_records ON ${t} AS RESTRICTIVE
    USING(EXISTS(SELECT 1 FROM attendance WHERE id=attendance_id)) WITH CHECK(EXISTS(SELECT 1 FROM attendance WHERE id=attendance_id));`,
    )
    .join('\n')}
  ${BRANCH_FUNCTIONS.map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC;`).join('\n')}
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hr_runtime') THEN
    ${BRANCH_FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO hr_runtime;`).join('\n')}
  END IF; END $$;
`;
