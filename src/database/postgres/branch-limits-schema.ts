export const BRANCH_LIMIT_FUNCTIONS = [
  'hr_owner_branch_limits(text,text,jsonb)',
] as const;

export const BRANCH_LIMIT_SCHEMA = `
  CREATE TABLE platform_company_branch_limits (
    company_id uuid PRIMARY KEY REFERENCES companies(id),
    branch_limit integer CHECK (branch_limit > 0)
  );
  CREATE FUNCTION hr_owner_branch_limits(h text,operation text,p jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE owner uuid; target uuid; maximum integer; previous integer; used bigint; registry jsonb;
    BEGIN
      SELECT o.id INTO owner FROM public.platform_sessions s JOIN public.platform_owners o ON o.id=s.owner_id
        WHERE s.hash=h AND s.expires>clock_timestamp() AND o.active FOR SHARE OF s,o;
      IF owner IS NULL THEN RAISE EXCEPTION 'Please sign in as platform owner.' USING ERRCODE='HR401'; END IF;
      IF operation='companies' THEN
        registry:=public.hr_owner_command(h,'companies','{}');
        RETURN coalesce((SELECT jsonb_agg(item || jsonb_build_object('branchLimit',l.branch_limit,
          'branchCount',(SELECT count(*) FROM public.branches b WHERE b.company_id=(item->>'id')::uuid)) ORDER BY position)
          FROM jsonb_array_elements(registry) WITH ORDINALITY AS entries(item,position)
          LEFT JOIN public.platform_company_branch_limits l ON l.company_id=(item->>'id')::uuid),'[]');
      END IF;
      IF operation<>'branch-limit' THEN RAISE EXCEPTION 'Unknown platform operation.' USING ERRCODE='HR400'; END IF;
      target:=(p->>'companyId')::uuid; maximum:=(p->>'branchLimit')::integer;
      IF maximum IS NOT NULL AND maximum<1 OR length(trim(coalesce(p->>'reason','')))<5
        OR length(p->>'reason')>500 THEN
        RAISE EXCEPTION 'Enter a positive branch limit and a reason.' USING ERRCODE='HR400';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(target::text,0));
      IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=target) THEN
        RAISE EXCEPTION 'Company not found.' USING ERRCODE='HR404';
      END IF;
      SELECT count(*) INTO used FROM public.branches WHERE company_id=target;
      IF maximum<used THEN RAISE EXCEPTION 'Branch limit cannot be lower than the existing branch count.' USING ERRCODE='HR409'; END IF;
      SELECT branch_limit INTO previous FROM public.platform_company_branch_limits WHERE company_id=target;
      INSERT INTO public.platform_company_branch_limits VALUES(target,maximum)
        ON CONFLICT(company_id) DO UPDATE SET branch_limit=excluded.branch_limit;
      INSERT INTO public.platform_audit(owner_id,action,company_id,details)
        VALUES(owner,'company.branch_limit_changed',target,jsonb_build_object('from',previous,'to',maximum,'reason',p->>'reason'));
      RETURN jsonb_build_object('branchLimit',maximum,'branchCount',used);
    END $$;
  CREATE FUNCTION hr_enforce_branch_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE maximum integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text,0));
      IF EXISTS(SELECT 1 FROM public.branches WHERE company_id=NEW.company_id AND id=NEW.id) THEN RETURN NEW; END IF;
      SELECT branch_limit INTO maximum FROM public.platform_company_branch_limits WHERE company_id=NEW.company_id;
      IF maximum IS NOT NULL AND (SELECT count(*) FROM public.branches WHERE company_id=NEW.company_id)>=maximum THEN
        RAISE EXCEPTION 'Branch limit reached. Contact the platform owner to increase it.' USING ERRCODE='HR409';
      END IF;
      RETURN NEW;
    END $$;
  CREATE TRIGGER branch_limit BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION hr_enforce_branch_limit();
  REVOKE ALL ON FUNCTION hr_enforce_branch_limit() FROM PUBLIC;
  REVOKE ALL ON FUNCTION hr_owner_branch_limits(text,text,jsonb) FROM PUBLIC;
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hr_runtime') THEN
    GRANT EXECUTE ON FUNCTION hr_owner_branch_limits(text,text,jsonb) TO hr_runtime;
  END IF; END $$;
`;
