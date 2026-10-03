export type FactValue = {
  state: 'KNOWN' | 'UNKNOWN' | 'NOT_ASSESSED';
  value: boolean | number | string | null;
  unit?: string | null;
  source?: 'MANUAL' | 'IMPORTED' | 'CALCULATED' | 'UNKNOWN';
};
export interface FactDefinition {
  fact_code: string;
  label_ru: string;
  data_type: 'BOOLEAN' | 'INTEGER' | 'DECIMAL' | 'ENUM' | 'STRING' | 'DATE';
  unit?: string | null;
  enum_values?: string[];
  min_value?: number | null;
  max_value?: number | null;
  unknown_allowed: boolean;
  unknown_policy: string;
  notes?: string | null;
}
export type Expression =
  | { kind: 'REF'; ref_type: 'FACT' | 'SCORE' | 'DERIVED_FACT'; ref_id: string }
  | { kind: 'LITERAL'; value: boolean | number | string | null; unit?: string | null }
  | { kind: 'OP'; operator: string; operands: Expression[] };
export interface SourceRef {
  source_type: string;
  document_id: string;
  slide?: number | null;
  note?: string | null;
}
export interface RuleNode {
  node_id: string;
  nosology_code: string;
  node_type: string;
  input_ref?: string | null;
  output_ref?: string | null;
  label_ru?: string | null;
  unknown_behavior?: string;
  resolution_status: string;
  source?: SourceRef;
  display_expression?: string | null;
  notes?: string | null;
}
export interface RuleEdge {
  edge_id: string;
  nosology_code: string;
  from_node_id: string;
  to_node_id: string;
  branch_code: string;
  condition: Expression;
  priority: number;
  resolution_status: string;
  source?: SourceRef;
  display_expression?: string | null;
  is_default?: boolean;
  notes?: string | null;
}
export interface ScoreGroup {
  score_group_id: string;
  label_ru: string;
  items: { item_id: string; weight: number; condition: Expression; label_ru?: string | null }[];
  source?: SourceRef;
  resolution_status?: string;
  notes?: string | null;
}
export interface Scheme {
  scheme_id: string;
  nosology_code: string;
  scheme_root: string;
  rank?: number | null;
  tree_label?: string | null;
  table_label?: string | null;
  resolution_status: string;
  terminal_state_override?: string | null;
  source?: SourceRef;
  notes?: string | null;
}
export interface TreatmentOption {
  treatment_option_id: string;
  scheme_id: string;
  line_type: string;
  option_group: number;
  drug_id: number;
  base_regimen_text: string;
  source?: SourceRef;
}
export interface RulePackage {
  contract_version: '0.1.0';
  package_type: 'CLINICAL_RULESET';
  ruleset_version: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'VALIDATED' | 'PUBLISHED' | 'RETIRED';
  created_at?: string;
  published_at?: string | null;
  ruleset_hash?: string | null;
  hash_algorithm?: 'SHA-256';
  component_versions: Record<string, string>;
  nosologies: { nosology_code: string; name_ru: string; root_node_id: string; active: boolean }[];
  fact_definitions: FactDefinition[];
  score_groups: ScoreGroup[];
  nodes: RuleNode[];
  edges: RuleEdge[];
  schemes: Scheme[];
  terminal_states: { terminal_code: string; label_ru: string; scope?: string }[];
  treatment_options: TreatmentOption[];
  provenance: { source_basis: SourceRef[]; normalization_policy: string; notes?: string };
}
export interface Medications {
  state: 'UNKNOWN' | 'KNOWN_NONE' | 'KNOWN_LIST';
  drug_ids: number[];
  unrecognized: string[];
}
export interface CaseDraft {
  id: string;
  nosology_code: string;
  facts: Record<string, FactValue>;
  medications: Medications;
  created_at?: string;
  updated_at?: string;
}
export type Outcome =
  { type: 'TREATMENT_SCHEME'; scheme_id: string } | { type: 'TERMINAL_STATE'; terminal_code: string };
export interface TraceStep {
  sequence: number;
  node_id: string;
  node_type: string;
  status: 'EVALUATED' | 'BLOCKED_MISSING_INPUT' | 'TERMINAL';
  inputs?: Record<string, unknown>;
  edge_evaluations: {
    edge_id: string;
    result: 'TRUE' | 'FALSE' | 'UNKNOWN' | 'NOT_EVALUATED';
    selected?: boolean;
  }[];
  selected_edge_id?: string | null;
  next_node_id?: string | null;
  score_details?: Record<string, unknown> | null;
}
export interface CoreResult {
  status: 'COMPLETED' | 'NEEDS_INPUT' | 'FAILED';
  outcome: Outcome | null;
  missing_facts: string[];
  trace: TraceStep[];
  errors: { code: string; message: string; node_id?: string; details?: Record<string, unknown> }[];
  steps_executed: number;
}
export type Action = 'BLOCK' | 'REVIEW_REQUIRED' | 'WARN' | 'ALLOW';
export interface Finding {
  message: string;
  action: Action;
  source?: string;
  rule_id?: string;
}
export interface Regimen {
  dose_amount: number | null;
  dose_max?: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency_per_day: number | null;
  duration_days: number | null;
  duration_max_days?: number | null;
  loading_dose?: {
    dose_amount: number;
    dose_unit: string;
    duration_days: number;
    frequency_per_day?: number;
    dose_per_administration?: number;
  } | null;
  source_text: string;
  parse_status: 'STRUCTURED' | 'REVIEW_REQUIRED';
  variants?: Regimen[];
  components?: { amount: number; unit: string }[];
}
export interface TherapyOption {
  option_id: string;
  drug_id: number;
  drug_name: string;
  line: string;
  source_text: string;
  regimen: Regimen;
  eligibility: 'ELIGIBLE' | 'BLOCKED' | 'REVIEW_REQUIRED';
  action: Action;
  findings: Finding[];
  dose_status: string;
}
export interface EvaluationView {
  id?: string;
  case_id: string;
  nosology_code?: string;
  status: CoreResult['status'];
  missing_facts: string[];
  questions: FactDefinition[];
  outcome: Outcome | null;
  title: string;
  options: TherapyOption[];
  warnings: string[];
  explanation: string[];
  copy_text: string;
  trace: unknown[];
  versions: Record<string, string>;
  hashes: Record<string, string>;
  demo: boolean;
  created_at?: string;
  safety_status: string;
  errors?: CoreResult['errors'];
  snapshot?: CaseDraft;
}
export interface Drug {
  drug_id: number;
  generic_name_ru: string;
  normalized_code: string;
  aliases: string[];
  active?: boolean;
}
export interface ValidationReport {
  valid: boolean;
  errors: { code: string; message: string; path?: string }[];
  warnings: { code: string; message: string; path?: string }[];
}
export interface SafetyRule {
  rule_id: string;
  drug_id: number;
  nosology_code?: string;
  condition?: Expression;
  concomitant_drug_id?: number;
  action: Action;
  message: string;
  source: string;
  enabled: boolean;
  validation_status: string;
}
export interface DoseRule {
  rule_id: string;
  drug_id: number;
  nosology_code: string;
  condition: Expression;
  required_facts: string[];
  regimen: Regimen;
  enabled: boolean;
  validation_status: string;
  source: string;
}
export interface ClinicalContent {
  rules: RulePackage;
  drugs: Drug[];
  contraindications: SafetyRule[];
  interactions: SafetyRule[];
  dose_rules: DoseRule[];
  hashes: Record<string, string>;
  versions?: Record<string, string>;
  demo: boolean;
}
