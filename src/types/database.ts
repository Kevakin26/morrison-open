export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      draft_picks: {
        Row: {
          created_at: string
          golfer_id: string
          id: string
          pick_number: number
          round_number: number
          tournament_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          golfer_id: string
          id?: string
          pick_number: number
          round_number: number
          tournament_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          golfer_id?: string
          id?: string
          pick_number?: number
          round_number?: number
          tournament_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_picks_golfer_id_fkey"
            columns: ["golfer_id"]
            isOneToOne: false
            referencedRelation: "golfers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_picks_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_state: {
        Row: {
          created_at: string
          current_pick_index: number
          draft_order: Json
          id: string
          pick_deadline: string | null
          status: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          current_pick_index?: number
          draft_order?: Json
          id?: string
          pick_deadline?: string | null
          status?: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          current_pick_index?: number
          draft_order?: Json
          id?: string
          pick_deadline?: string | null
          status?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_state_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: true
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      golfer_scores: {
        Row: {
          golfer_id: string
          id: string
          is_manual: boolean
          position: string | null
          r1: number | null
          r2: number | null
          r3: number | null
          r4: number | null
          status: string
          thru: string | null
          to_par: number | null
          today: number | null
          total_score: number | null
          tournament_id: string
          updated_at: string
        }
        Insert: {
          golfer_id: string
          id?: string
          is_manual?: boolean
          position?: string | null
          r1?: number | null
          r2?: number | null
          r3?: number | null
          r4?: number | null
          status?: string
          thru?: string | null
          to_par?: number | null
          today?: number | null
          total_score?: number | null
          tournament_id: string
          updated_at?: string
        }
        Update: {
          golfer_id?: string
          id?: string
          is_manual?: boolean
          position?: string | null
          r1?: number | null
          r2?: number | null
          r3?: number | null
          r4?: number | null
          status?: string
          thru?: string | null
          to_par?: number | null
          today?: number | null
          total_score?: number | null
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "golfer_scores_golfer_id_fkey"
            columns: ["golfer_id"]
            isOneToOne: false
            referencedRelation: "golfers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "golfer_scores_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      golfers: {
        Row: {
          bio: string | null
          country: string
          created_at: string
          id: string
          image_url: string | null
          is_active: boolean
          masters_record: string | null
          name: string
          odds: string | null
          power_ranking: number | null
          scoring_avg: number | null
          world_ranking: number
        }
        Insert: {
          bio?: string | null
          country?: string
          created_at?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          masters_record?: string | null
          name: string
          odds?: string | null
          power_ranking?: number | null
          scoring_avg?: number | null
          world_ranking?: number
        }
        Update: {
          bio?: string | null
          country?: string
          created_at?: string
          id?: string
          image_url?: string | null
          is_active?: boolean
          masters_record?: string | null
          name?: string
          odds?: string | null
          power_ranking?: number | null
          scoring_avg?: number | null
          world_ranking?: number
        }
        Relationships: []
      }
      message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
        }
        Relationships: []
      }
      ready_checks: {
        Row: {
          created_at: string
          id: string
          is_ready: boolean
          tournament_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_ready?: boolean
          tournament_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_ready?: boolean
          tournament_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ready_checks_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      score_fetch_logs: {
        Row: {
          created_at: string
          error_message: string | null
          golfers_updated: number
          id: string
          source: string
          status: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          golfers_updated?: number
          id?: string
          source: string
          status: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          golfers_updated?: number
          id?: string
          source?: string
          status?: string
        }
        Relationships: []
      }
      tournaments: {
        Row: {
          created_at: string
          current_round: number | null
          cut_line: number | null
          id: string
          status: string
          year: number
        }
        Insert: {
          created_at?: string
          current_round?: number | null
          cut_line?: number | null
          id?: string
          status?: string
          year: number
        }
        Update: {
          created_at?: string
          current_round?: number | null
          cut_line?: number | null
          id?: string
          status?: string
          year?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auto_pick: { Args: { p_tournament_id: string }; Returns: undefined }
      create_proxy_player: {
        Args: {
          p_display_name: string
          p_tournament_id: string
        }
        Returns: string
      }
      make_draft_pick: {
        Args: {
          p_golfer_id: string
          p_tournament_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      start_draft: { Args: { p_tournament_id: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">
type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never
