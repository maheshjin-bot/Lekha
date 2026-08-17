// Generated from the live schema. Regenerate after every migration:
//   supabase gen types typescript --project-id msgzicwfdoxaswgmevyg > types/database.types.ts
// Hand-editing this file guarantees drift between what TypeScript believes and
// what Postgres enforces, which is the worst of both worlds.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: { PostgrestVersion: "14.15" };
  public: {
    Tables: {
      account_groups: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          is_system: boolean;
          ledger_role: string;
          name: string;
          nature: string;
          normal_balance: string;
          parent_group_id: string | null;
          sort_order: number;
          statement: string | null;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          id?: string;
          is_system?: boolean;
          ledger_role?: string;
          name: string;
          nature: string;
          normal_balance: string;
          parent_group_id?: string | null;
          sort_order?: number;
        };
        Update: Partial<Database["public"]["Tables"]["account_groups"]["Insert"]>;
        Relationships: [];
      };
      branches: {
        Row: {
          address_line1: string | null;
          address_line2: string | null;
          city: string | null;
          code: string;
          company_id: string;
          created_at: string;
          gst_registration_id: string | null;
          id: string;
          is_active: boolean;
          is_head_office: boolean;
          name: string;
          pincode: string | null;
          state_code: string;
          updated_at: string;
        };
        Insert: {
          address_line1?: string | null;
          address_line2?: string | null;
          city?: string | null;
          code: string;
          company_id: string;
          gst_registration_id?: string | null;
          id?: string;
          is_active?: boolean;
          is_head_office?: boolean;
          name: string;
          pincode?: string | null;
          state_code: string;
        };
        Update: Partial<Database["public"]["Tables"]["branches"]["Insert"]>;
        Relationships: [];
      };
      companies: {
        Row: {
          base_currency: string;
          book_beginning_date: string;
          cin: string | null;
          compliance_mode: string;
          created_at: string;
          created_by: string | null;
          entity_type: string;
          financial_year_start_month: number;
          id: string;
          iec: string | null;
          incorporation_date: string | null;
          is_active: boolean;
          legal_name: string | null;
          lock_date: string | null;
          name: string;
          pan: string | null;
          tan: string | null;
          udyam_category: string | null;
          udyam_number: string | null;
          updated_at: string;
        };
        Insert: {
          book_beginning_date: string;
          cin?: string | null;
          compliance_mode?: string;
          entity_type: string;
          financial_year_start_month?: number;
          id?: string;
          iec?: string | null;
          incorporation_date?: string | null;
          legal_name?: string | null;
          lock_date?: string | null;
          name: string;
          pan?: string | null;
          tan?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["companies"]["Insert"]>;
        Relationships: [];
      };
      company_invites: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          company_id: string;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string;
          role: string;
          status: string;
          token: string;
        };
        Insert: {
          company_id: string;
          email: string;
          invited_by: string;
          role: string;
          status?: string;
        };
        Update: Partial<Database["public"]["Tables"]["company_invites"]["Insert"]>;
        Relationships: [];
      };
      company_members: {
        Row: {
          company_id: string;
          created_at: string;
          id: string;
          invited_by: string | null;
          role: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          company_id: string;
          invited_by?: string | null;
          role: string;
          status?: string;
          user_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["company_members"]["Insert"]>;
        Relationships: [];
      };
      company_modules: {
        Row: {
          company_id: string;
          config: Json;
          created_at: string;
          effective_from: string;
          effective_to: string | null;
          enabled_by: string | null;
          id: string;
          licensed: boolean;
          locked_reason: string | null;
          module_code: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          effective_from: string;
          effective_to?: string | null;
          module_code: string;
        };
        Update: Partial<Database["public"]["Tables"]["company_modules"]["Insert"]>;
        Relationships: [];
      };
      gst_registrations: {
        Row: {
          company_id: string;
          created_at: string;
          filing_frequency: string;
          gstin: string;
          id: string;
          is_active: boolean;
          legal_name: string | null;
          registered_from: string;
          registered_to: string | null;
          registration_type: string;
          state_code: string;
          trade_name: string | null;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          filing_frequency?: string;
          gstin: string;
          registered_from: string;
          registration_type?: string;
          state_code: string;
        };
        Update: Partial<Database["public"]["Tables"]["gst_registrations"]["Insert"]>;
        Relationships: [];
      };
      ledgers: {
        Row: {
          company_id: string;
          created_at: string;
          default_currency: string;
          group_id: string;
          gstin: string | null;
          id: string;
          is_active: boolean;
          name: string;
          opening_balance_amount: number;
          opening_balance_type: string;
          pan: string | null;
          party_type: string | null;
          state_code: string | null;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          group_id: string;
          gstin?: string | null;
          name: string;
          opening_balance_amount?: number;
          opening_balance_type?: string;
          party_type?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["ledgers"]["Insert"]>;
        Relationships: [];
      };
      member_branches: {
        Row: {
          branch_id: string;
          company_id: string;
          company_member_id: string;
          created_at: string;
          id: string;
        };
        Insert: {
          branch_id: string;
          company_id: string;
          company_member_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["member_branches"]["Insert"]>;
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          full_name: string | null;
          id: string;
        };
        Insert: { avatar_url?: string | null; full_name?: string | null; id: string };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      ref_entity_types: {
        Row: {
          code: string;
          governing_act: string | null;
          interest_on_capital_cap_percent: number | null;
          itr_form: string;
          name: string;
          presumptive_allowed: boolean;
          remuneration_section: string | null;
          roc_applicable: boolean;
          roc_forms: string[] | null;
          sort_order: number;
          special_provisions: string[] | null;
          statement_format: string;
          statutory_audit_note: string | null;
          statutory_audit_rule: string;
          tax_audit_report_form: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ref_modules: {
        Row: {
          activates_when: Json | null;
          code: string;
          depends_on: string[];
          description: string | null;
          name: string;
          sort_order: number;
          tier: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ref_states: {
        Row: {
          code: string;
          intra_state_component: string;
          is_active: boolean;
          jurisdiction: string;
          name: string;
          obsolete_note: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      statutory_rules: {
        Row: {
          attrs: Json;
          authority: string | null;
          created_at: string;
          domain: string;
          effective_from: string;
          effective_to: string | null;
          id: string;
          notes: string | null;
          rule_key: string;
          scope: Json;
          value: number | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      tax_ledger_map: {
        Row: {
          company_id: string;
          created_at: string;
          gst_registration_id: string | null;
          id: string;
          ledger_id: string;
          purpose: string;
        };
        Insert: {
          company_id: string;
          gst_registration_id?: string | null;
          ledger_id: string;
          purpose: string;
        };
        Update: Partial<Database["public"]["Tables"]["tax_ledger_map"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      create_company: {
        Args: {
          p_book_beginning_date: string;
          p_compliance_mode?: string;
          p_entity_type: string;
          p_financial_year_start_month?: number;
          p_name: string;
          p_pan?: string;
          p_state_code: string;
        };
        Returns: string;
      };
      get_company_modules: {
        Args: { p_as_at?: string; p_company_id: string };
        Returns: {
          active: boolean;
          can_toggle: boolean;
          code: string;
          depends_on: string[];
          description: string;
          licensed: boolean;
          locked_reason: string;
          name: string;
          tier: string;
        }[];
      };
      get_company_profile: {
        Args: { p_company_id: string };
        Returns: {
          company_id: string;
          compliance_mode: string;
          entity_name: string;
          entity_type: string;
          financial_year_start_month: number;
          has_iec: boolean;
          has_pan: boolean;
          has_tan: boolean;
          itr_form: string;
          name: string;
          presumptive_allowed: boolean;
          remuneration_section: string;
          roc_applicable: boolean;
          roc_forms: string[];
          special_provisions: string[];
          statement_format: string;
          statutory_audit_rule: string;
          tax_audit_report_form: string;
        }[];
      };
      resolve_statutory_rule: {
        Args: { p_as_at: string; p_domain: string; p_rule_key: string; p_scope?: Json };
        Returns: { attrs: Json; authority: string; value: number }[];
      };
      set_module: {
        Args: {
          p_company_id: string;
          p_enabled: boolean;
          p_from_date?: string;
          p_module_code: string;
        };
        Returns: undefined;
      };
      create_voucher: {
        Args: {
          p_company_id: string;
          p_branch_id: string;
          p_voucher_type: string;
          p_voucher_date: string;
          p_narration?: string;
          p_reference_number?: string;
          p_reference_date?: string;
          p_lines: Json;
          p_party_ledger_id?: string;
          p_txn_currency?: string;
          p_exchange_rate?: number;
          p_rate_source?: string;
        };
        Returns: string;
      };
      update_voucher: {
        Args: {
          p_voucher_id: string;
          p_voucher_date: string;
          p_narration?: string;
          p_reference_number?: string;
          p_reference_date?: string;
          p_lines: Json;
          p_party_ledger_id?: string;
        };
        Returns: string;
      };
      find_duplicate_bills: {
        Args: {
          p_company_id: string;
          p_party_ledger_id: string;
          p_reference_number: string;
          p_exclude_voucher_id?: string;
        };
        Returns: {
          id: string;
          voucher_number: string;
          voucher_date: string;
          total_amount: number;
        }[];
      };
      get_trial_balance: {
        Args: {
          p_company_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string;
        };
        Returns: {
          ledger_id: string;
          ledger_name: string;
          group_name: string;
          nature: string;
          opening_debit: number;
          opening_credit: number;
          period_debit: number;
          period_credit: number;
          closing_debit: number;
          closing_credit: number;
        }[];
      };
      get_daybook: {
        Args: {
          p_company_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string;
        };
        Returns: {
          voucher_id: string;
          voucher_date: string;
          voucher_type: string;
          voucher_number: string;
          branch_code: string;
          narration: string | null;
          reference_number: string | null;
          total_amount: number;
          party_name: string | null;
          line_count: number;
        }[];
      };
      get_ledger_statement: {
        Args: {
          p_company_id: string;
          p_ledger_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string;
        };
        Returns: {
          voucher_id: string;
          voucher_date: string;
          voucher_number: string;
          voucher_type: string;
          narration: string | null;
          contra_ledgers: string | null;
          debit_amount: number;
          credit_amount: number;
          running_balance: number;
        }[];
      };
      get_profit_and_loss: {
        Args: {
          p_company_id: string;
          p_from: string;
          p_to: string;
          p_branch_id?: string;
        };
        Returns: {
          section: string;
          nature: string;
          group_name: string;
          ledger_name: string;
          amount: number;
        }[];
      };
      get_balance_sheet: {
        Args: { p_company_id: string; p_as_at: string; p_branch_id?: string };
        Returns: {
          side: string;
          nature: string;
          group_name: string;
          ledger_name: string;
          amount: number;
        }[];
      };
      get_audit_trail: {
        Args: {
          p_company_id: string;
          p_from?: string;
          p_to?: string;
          p_table_name?: string;
          p_limit?: number;
        };
        Returns: {
          id: string;
          table_name: string;
          record_id: string;
          operation: string;
          changed_fields: string[] | null;
          derived_note: string | null;
          changed_by: string | null;
          changed_by_name: string | null;
          changed_at: string;
        }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type FunctionReturns<T extends keyof PublicSchema["Functions"]> =
  PublicSchema["Functions"][T]["Returns"];
