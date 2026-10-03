CREATE TABLE users (
 id uuid PRIMARY KEY, login text NOT NULL UNIQUE, role text NOT NULL CHECK (role IN ('DOCTOR','CLINICAL_PHARMACOLOGIST','CLINICAL_ADMIN','SYSTEM_ADMIN')), active boolean NOT NULL DEFAULT true, data jsonb NOT NULL
);
CREATE TABLE sessions (id char(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz(3) NOT NULL, data jsonb NOT NULL);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE clinical_cases (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision>0), data jsonb NOT NULL);
CREATE INDEX clinical_cases_owner_id_idx ON clinical_cases(owner_id);
CREATE TABLE case_revisions (id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision>0), created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, data jsonb NOT NULL, UNIQUE(case_id,revision));
CREATE INDEX case_revisions_created_by_idx ON case_revisions(created_by);
CREATE TABLE evaluations (id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, data jsonb NOT NULL);
CREATE INDEX evaluations_case_id_idx ON evaluations(case_id);
CREATE INDEX evaluations_owner_id_idx ON evaluations(owner_id);
CREATE TABLE clinician_feedback (id uuid PRIMARY KEY, evaluation_id uuid NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, data jsonb NOT NULL);
CREATE INDEX clinician_feedback_evaluation_id_idx ON clinician_feedback(evaluation_id);
CREATE INDEX clinician_feedback_user_id_idx ON clinician_feedback(user_id);
CREATE TABLE content_packages (id uuid PRIMARY KEY, package_type text NOT NULL, version text NOT NULL, status text NOT NULL CHECK(status IN ('DRAFT','IN_REVIEW','VALIDATED','PUBLISHED','RETIRED')), sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), data jsonb NOT NULL, UNIQUE(package_type,version));
CREATE INDEX content_packages_status_idx ON content_packages(status);
CREATE TABLE content_package_activations (id uuid PRIMARY KEY, package_id uuid NOT NULL REFERENCES content_packages(id) ON DELETE RESTRICT, package_type text NOT NULL, created_at timestamptz(3) NOT NULL, data jsonb NOT NULL);
CREATE INDEX content_package_activations_package_id_idx ON content_package_activations(package_id);
CREATE INDEX content_package_activations_package_type_created_at_idx ON content_package_activations(package_type,created_at);
CREATE TABLE audit_events (id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id) ON DELETE RESTRICT, action text NOT NULL, created_at timestamptz(3) NOT NULL, data jsonb NOT NULL);
CREATE INDEX audit_events_actor_id_created_at_idx ON audit_events(actor_id,created_at);
CREATE INDEX audit_events_action_created_at_idx ON audit_events(action,created_at);

-- Защита действует и при обходе application repository.
CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable table: %', TG_TABLE_NAME USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER evaluations_immutable BEFORE UPDATE OR DELETE ON evaluations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON case_revisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER feedback_immutable BEFORE UPDATE OR DELETE ON clinician_feedback FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER activations_immutable BEFORE UPDATE OR DELETE ON content_package_activations FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE FUNCTION reject_published_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PUBLISHED','RETIRED') THEN RAISE EXCEPTION 'immutable published content package' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER published_package_immutable BEFORE UPDATE OR DELETE ON content_packages FOR EACH ROW EXECUTE FUNCTION reject_published_change();
CREATE FUNCTION validate_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM content_packages WHERE id=NEW.package_id AND package_type=NEW.package_type AND status='PUBLISHED') THEN RAISE EXCEPTION 'activation requires matching published package' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER activation_published_only BEFORE INSERT ON content_package_activations FOR EACH ROW EXECUTE FUNCTION validate_activation();
