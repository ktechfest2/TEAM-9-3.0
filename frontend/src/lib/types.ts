// Mirrors backend/app/schemas/*. Field names match the API exactly.

export type Role = 'party_admin' | 'pu_agent' | 'ward_agent' | 'collation_officer' | 'operations' | 'legal_compliance'
export type Kind = 'party' | 'inec'

export interface User {
  id: string
  email: string
  full_name: string
  is_active: boolean
  is_platform_admin: boolean
  mfa_enabled: boolean
}

export interface Workspace {
  id: string
  name: string
  party_code: string
  kind: Kind
  timezone: string
  status: string
  created_at: string
}

export interface NodeSummary {
  id: string
  level: string
  code: string
  name: string
  path: string[]
}

export interface BallotCandidate {
  id: string
  name: string
  ballot_code: string
  party_code: string
  party_name: string
}

export interface BallotContest {
  id: string
  name: string
  office: string
  form_type: string
  geography_level: string
  candidates: BallotCandidate[]
}

export interface BallotElection {
  id: string
  name: string
  election_type: string
  election_date: string
  status: string
  contests: BallotContest[]
}

export interface WorkspaceContext {
  workspace: Workspace
  role: Role
  can_submit_anywhere: boolean
  assignments: NodeSummary[]
  elections: BallotElection[]
}

export interface GeographyNode {
  id: string
  parent_id: string | null
  level: 'state' | 'lga' | 'ward' | 'polling_unit'
  code: string
  name: string
}

export interface Person {
  membership_id: string
  user_id: string
  full_name: string
  email: string
  role: Role
  is_active: boolean
  assignments: NodeSummary[]
}

export interface PendingInvite {
  id: string
  email: string
  role: Role
  polling_unit: NodeSummary | null
  expires_at: string
}

export interface Invitation {
  id: string
  email: string
  role: Role
  geography_node_id: string | null
  expires_at: string
  invitation_token: string
}

export type Status = 'match' | 'mismatch' | 'awaiting_inec' | 'awaiting_party' | 'not_reported'

export interface ReportedFigures {
  submission_id: string
  document_id: string
  version: number
  submitted_at: string
  totals: { valid_votes: number; rejected_ballots: number; total_votes_cast: number }
  votes: Record<string, number>
  correction_reason: string | null
  document_url: string | null
}

export interface Difference {
  field: string
  label: string
  party: number | null
  inec: number | null
  delta: number | null
}

export interface PartyReport {
  workspace_id: string
  party_code: string
  party_name: string
  status: Status
  result: ReportedFigures | null
  differences: Difference[]
}

export interface UnitCrossCheck {
  node: NodeSummary
  status: Status
  inec: ReportedFigures | null
  reports: PartyReport[]
}

export interface CrossCheck {
  viewer: Kind
  election_id: string
  inec_connected: boolean
  summary: { total_units: number } & Record<Status, number>
  units: UnitCrossCheck[]
}

export interface DocumentOut {
  id: string
  sha256: string
  original_filename: string
  size_bytes: number
  status: string
}

export interface Submission {
  id: string
  geography_node_id: string
  version: number
  status: string
  submitted_at: string
}
