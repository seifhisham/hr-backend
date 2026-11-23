// Absence audit records are keyed `employeeId:workDate`, so branch-limited HR
// sees them under the branch the employee belonged to on that work date.
export const ABSENCE_AUDIT_SCHEMA = `
  CREATE OR REPLACE FUNCTION hr_audit_branch(c uuid,action text,record text,at_time text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE b uuid;
    BEGIN
      IF action LIKE 'attendance.%' THEN SELECT branch_id INTO b FROM public.attendance WHERE company_id=c AND id=record;
      ELSIF action LIKE 'request.%' THEN SELECT branch_id INTO b FROM public.employee_requests WHERE company_id=c AND id=record;
      ELSIF action LIKE 'sales.activity.%' THEN SELECT branch_id INTO b FROM public.sales_activities WHERE company_id=c AND id=record;
      ELSIF action='payroll.deduction.created' THEN SELECT branch_id INTO b FROM public.payroll_deductions WHERE company_id=c AND id=record;
      ELSIF action LIKE 'payroll.absence.%' THEN b:=public.hr_resolve_branch(c,split_part(record,':',1),split_part(record,':',2));
      ELSIF action IN ('employee.created','employee.updated','employee.schedule_assigned','sales.target.saved') THEN b:=public.hr_resolve_branch(c,record,to_char(at_time::timestamptz AT TIME ZONE (SELECT timezone FROM public.companies WHERE id=c),'YYYY-MM-DD'));
      END IF;
      RETURN b;
    END $$;
  DROP POLICY hr_records ON audit;
  CREATE POLICY hr_records ON audit AS RESTRICTIVE USING(hr_branch_visible(branch_id) AND
    CASE WHEN action IN ('payroll.deduction.created','sales.target.saved') OR action LIKE 'payroll.absence.%'
      THEN hr_month_visible(after_data::jsonb->>'employeeId',after_data::jsonb->>'month') ELSE true END)
    WITH CHECK(branch_id IS NULL OR hr_branch_visible(branch_id));
`;
