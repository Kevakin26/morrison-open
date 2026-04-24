export type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

export type EventStatus = 'upcoming' | 'drafting' | 'in_progress' | 'completed' | 'skipped'
export type DraftStatus = 'pending' | 'active' | 'completed'
export type GolferStatus = 'active' | 'cut' | 'wd' | 'dq'

export interface ProfileRow { id: string; display_name: string; created_at: string }
export interface SeasonRow { id: string; year: number; name: string; status: 'active' | 'completed'; created_at: string }
export interface LeagueMemberRow { season_id: string; user_id: string; display_order: number; created_at: string }
export interface WeeklyEventRow {
  id: string
  season_id: string
  espn_event_id: string
  name: string
  short_name: string | null
  start_date: string
  end_date: string
  draft_opens_at: string | null
  status: EventStatus
  current_round: number
  cut_line: number | null
  leader_display: string | null
  created_at: string
  updated_at: string
}
export interface DraftStateRow {
  event_id: string
  status: DraftStatus
  draft_order: string[]
  current_pick_index: number
  started_at: string | null
  completed_at: string | null
}
export interface PickRow {
  id: string
  event_id: string
  user_id: string
  pick_number: number
  golfer_espn_id: string
  golfer_name: string
  created_at: string
}
export interface LeaderboardSnapshotRow {
  id: string
  event_id: string
  golfer_espn_id: string
  golfer_name: string
  position_display: string | null
  position_numeric: number | null
  total_to_par_display: string | null
  total_to_par_numeric: number | null
  today: string | null
  thru: string | null
  status: GolferStatus
  world_ranking: number | null
  updated_at: string
}
export interface WeeklyResultRow {
  id: string
  event_id: string
  user_id: string
  golfer_espn_id: string
  golfer_name: string
  position_display: string | null
  position_numeric: number | null
  total_to_par_display: string | null
  status: string
  rank_in_league: number
  points: number
  is_final: boolean
  updated_at: string
}
export interface SeasonStandingRow {
  season_id: string
  user_id: string
  display_name: string
  total_points: number
  firsts: number
  seconds: number
  thirds: number
  fourths: number
  weeks_played: number
}

type Rel = []

export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfileRow; Insert: Partial<ProfileRow> & { id: string; display_name: string }; Update: Partial<ProfileRow>; Relationships: Rel }
      seasons: { Row: SeasonRow; Insert: Partial<SeasonRow> & { year: number; name: string }; Update: Partial<SeasonRow>; Relationships: Rel }
      league_members: { Row: LeagueMemberRow; Insert: Partial<LeagueMemberRow> & { season_id: string; user_id: string; display_order: number }; Update: Partial<LeagueMemberRow>; Relationships: Rel }
      weekly_events: {
        Row: WeeklyEventRow
        Insert: Partial<WeeklyEventRow> & { espn_event_id: string; season_id: string; name: string; start_date: string; end_date: string }
        Update: Partial<WeeklyEventRow>
        Relationships: Rel
      }
      draft_state: { Row: DraftStateRow; Insert: Partial<DraftStateRow> & { event_id: string; draft_order: string[] }; Update: Partial<DraftStateRow>; Relationships: Rel }
      picks: {
        Row: PickRow
        Insert: Partial<PickRow> & { event_id: string; user_id: string; pick_number: number; golfer_espn_id: string; golfer_name: string }
        Update: Partial<PickRow>
        Relationships: Rel
      }
      leaderboard_snapshots: {
        Row: LeaderboardSnapshotRow
        Insert: Partial<LeaderboardSnapshotRow> & { event_id: string; golfer_espn_id: string; golfer_name: string }
        Update: Partial<LeaderboardSnapshotRow>
        Relationships: Rel
      }
      weekly_results: { Row: WeeklyResultRow; Insert: Partial<WeeklyResultRow>; Update: Partial<WeeklyResultRow>; Relationships: Rel }
    }
    Views: {
      season_standings: { Row: SeasonStandingRow; Relationships: Rel }
    }
    Functions: {
      start_weekly_draft: { Args: { p_event_id: string }; Returns: DraftStateRow }
      make_weekly_pick: { Args: { p_event_id: string; p_golfer_espn_id: string; p_golfer_name: string }; Returns: PickRow }
      recompute_weekly_results: { Args: { p_event_id: string }; Returns: void }
    }
  }
}
