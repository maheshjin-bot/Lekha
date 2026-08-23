export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      account_groups: {
        Row: {
          company_id: string
          created_at: string
          id: string
          is_system: boolean
          ledger_role: string
          name: string
          nature: string
          normal_balance: string
          parent_group_id: string | null
          sort_order: number
          statement: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          is_system?: boolean
          ledger_role?: string
          name: string
          nature: string
          normal_balance: string
          parent_group_id?: string | null
          sort_order?: number
          statement?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          is_system?: boolean
          ledger_role?: string
          name?: string
          nature?: string
          normal_balance?: string
          parent_group_id?: string | null
          sort_order?: number
          statement?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_groups_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_groups_parent_group_id_company_id_fkey"
            columns: ["parent_group_id", "company_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      api_keys: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_07: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_08: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_09: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_10: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_11: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2026_12: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_01: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_02: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_03: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_04: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_05: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_06: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_2027_07: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      audit_log_default: {
        Row: {
          after_data: Json | null
          before_data: Json | null
          changed_at: string
          changed_by: string | null
          company_id: string
          derived_note: string | null
          id: string
          operation: string
          record_id: string | null
          table_name: string
        }
        Insert: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id: string
          derived_note?: string | null
          id?: string
          operation: string
          record_id?: string | null
          table_name: string
        }
        Update: {
          after_data?: Json | null
          before_data?: Json | null
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          derived_note?: string | null
          id?: string
          operation?: string
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      bank_statement_lines: {
        Row: {
          company_id: string
          created_at: string
          credit_amount: number
          debit_amount: number
          description: string | null
          id: string
          ledger_id: string
          matched_at: string | null
          matched_by: string | null
          matched_entry_id: string | null
          reference: string | null
          txn_date: string
        }
        Insert: {
          company_id: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          description?: string | null
          id?: string
          ledger_id: string
          matched_at?: string | null
          matched_by?: string | null
          matched_entry_id?: string | null
          reference?: string | null
          txn_date: string
        }
        Update: {
          company_id?: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          description?: string | null
          id?: string
          ledger_id?: string
          matched_at?: string | null
          matched_by?: string | null
          matched_entry_id?: string | null
          reference?: string | null
          txn_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_statement_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statement_lines_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "bank_statement_lines_matched_entry_id_fkey"
            columns: ["matched_entry_id"]
            isOneToOne: false
            referencedRelation: "voucher_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      banking_facilities: {
        Row: {
          bank_name: string
          company_id: string
          created_at: string
          debtor_eligibility_days: number
          debtor_margin_percent: number
          facility_type: string
          id: string
          is_active: boolean
          sanctioned_limit: number
          stock_margin_percent: number
          updated_at: string
        }
        Insert: {
          bank_name: string
          company_id: string
          created_at?: string
          debtor_eligibility_days?: number
          debtor_margin_percent?: number
          facility_type?: string
          id?: string
          is_active?: boolean
          sanctioned_limit?: number
          stock_margin_percent?: number
          updated_at?: string
        }
        Update: {
          bank_name?: string
          company_id?: string
          created_at?: string
          debtor_eligibility_days?: number
          debtor_margin_percent?: number
          facility_type?: string
          id?: string
          is_active?: boolean
          sanctioned_limit?: number
          stock_margin_percent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "banking_facilities_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_of_materials: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          output_item_id: string
          updated_at: string
          yield_quantity: number
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          output_item_id: string
          updated_at?: string
          yield_quantity: number
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          output_item_id?: string
          updated_at?: string
          yield_quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "bill_of_materials_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_of_materials_output_item_id_company_id_fkey"
            columns: ["output_item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      bom_components: {
        Row: {
          bom_id: string
          company_id: string
          component_item_id: string
          created_at: string
          id: string
          line_order: number
          quantity: number
          updated_at: string
        }
        Insert: {
          bom_id: string
          company_id: string
          component_item_id: string
          created_at?: string
          id?: string
          line_order?: number
          quantity: number
          updated_at?: string
        }
        Update: {
          bom_id?: string
          company_id?: string
          component_item_id?: string
          created_at?: string
          id?: string
          line_order?: number
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bom_components_bom_id_company_id_fkey"
            columns: ["bom_id", "company_id"]
            isOneToOne: false
            referencedRelation: "bill_of_materials"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "bom_components_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "bill_of_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_components_component_item_id_company_id_fkey"
            columns: ["component_item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      branches: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          code: string
          company_id: string
          created_at: string
          gst_registration_id: string | null
          id: string
          is_active: boolean
          is_head_office: boolean
          name: string
          pincode: string | null
          state_code: string
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code: string
          company_id: string
          created_at?: string
          gst_registration_id?: string | null
          id?: string
          is_active?: boolean
          is_head_office?: boolean
          name: string
          pincode?: string | null
          state_code: string
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          code?: string
          company_id?: string
          created_at?: string
          gst_registration_id?: string | null
          id?: string
          is_active?: boolean
          is_head_office?: boolean
          name?: string
          pincode?: string | null
          state_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branches_gst_registration_id_company_id_state_code_fkey"
            columns: ["gst_registration_id", "company_id", "state_code"]
            isOneToOne: false
            referencedRelation: "gst_registrations"
            referencedColumns: ["id", "company_id", "state_code"]
          },
          {
            foreignKeyName: "branches_state_code_fkey"
            columns: ["state_code"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
      }
      budget_lines: {
        Row: {
          amount: number
          budget_id: string
          company_id: string
          created_at: string
          id: string
          ledger_id: string
          period_month: string
          updated_at: string
        }
        Insert: {
          amount?: number
          budget_id: string
          company_id: string
          created_at?: string
          id?: string
          ledger_id: string
          period_month: string
          updated_at?: string
        }
        Update: {
          amount?: number
          budget_id?: string
          company_id?: string
          created_at?: string
          id?: string
          ledger_id?: string
          period_month?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_lines_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_lines_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      budgets: {
        Row: {
          company_id: string
          created_at: string
          fy_end: string
          fy_start: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          fy_end: string
          fy_start: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          fy_end?: string
          fy_start?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          base_currency: string
          book_beginning_date: string
          cin: string | null
          company_tax_regime: string
          compliance_mode: string
          created_at: string
          created_by: string | null
          debtor_eligibility_days: number
          debtor_margin_percent: number
          entity_type: string
          financial_year_start_month: number
          id: string
          iec: string | null
          incorporation_date: string | null
          inventory_valuation_method: string
          is_active: boolean
          is_professional: boolean
          legal_name: string | null
          lock_date: string | null
          name: string
          pan: string | null
          password_hash: string | null
          password_protected: boolean | null
          stock_margin_percent: number
          tan: string | null
          udyam_category: string | null
          udyam_number: string | null
          updated_at: string
        }
        Insert: {
          base_currency?: string
          book_beginning_date: string
          cin?: string | null
          company_tax_regime?: string
          compliance_mode?: string
          created_at?: string
          created_by?: string | null
          debtor_eligibility_days?: number
          debtor_margin_percent?: number
          entity_type: string
          financial_year_start_month?: number
          id?: string
          iec?: string | null
          incorporation_date?: string | null
          inventory_valuation_method?: string
          is_active?: boolean
          is_professional?: boolean
          legal_name?: string | null
          lock_date?: string | null
          name: string
          pan?: string | null
          password_hash?: string | null
          password_protected?: boolean | null
          stock_margin_percent?: number
          tan?: string | null
          udyam_category?: string | null
          udyam_number?: string | null
          updated_at?: string
        }
        Update: {
          base_currency?: string
          book_beginning_date?: string
          cin?: string | null
          company_tax_regime?: string
          compliance_mode?: string
          created_at?: string
          created_by?: string | null
          debtor_eligibility_days?: number
          debtor_margin_percent?: number
          entity_type?: string
          financial_year_start_month?: number
          id?: string
          iec?: string | null
          incorporation_date?: string | null
          inventory_valuation_method?: string
          is_active?: boolean
          is_professional?: boolean
          legal_name?: string | null
          lock_date?: string | null
          name?: string
          pan?: string | null
          password_hash?: string | null
          password_protected?: boolean | null
          stock_margin_percent?: number
          tan?: string | null
          udyam_category?: string | null
          udyam_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "companies_entity_type_fkey"
            columns: ["entity_type"]
            isOneToOne: false
            referencedRelation: "ref_entity_types"
            referencedColumns: ["code"]
          },
        ]
      }
      company_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          company_id: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: string
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role: string
          status?: string
          token?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_invites_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_members: {
        Row: {
          company_id: string
          created_at: string
          id: string
          invited_by: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_modules: {
        Row: {
          company_id: string
          config: Json
          created_at: string
          effective_from: string
          effective_to: string | null
          enabled_by: string | null
          id: string
          licensed: boolean
          locked_reason: string | null
          module_code: string
          updated_at: string
        }
        Insert: {
          company_id: string
          config?: Json
          created_at?: string
          effective_from: string
          effective_to?: string | null
          enabled_by?: string | null
          id?: string
          licensed?: boolean
          locked_reason?: string | null
          module_code: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          config?: Json
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          enabled_by?: string | null
          id?: string
          licensed?: boolean
          locked_reason?: string | null
          module_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_modules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_modules_module_code_fkey"
            columns: ["module_code"]
            isOneToOne: false
            referencedRelation: "ref_modules"
            referencedColumns: ["code"]
          },
        ]
      }
      cost_centres: {
        Row: {
          code: string
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          kind: string
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_centres_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          company_id: string
          created_at: string
          entity_id: string | null
          entity_type: string
          file_name: string
          id: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          file_name: string
          id?: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          file_name?: string
          id?: string
          mime_type?: string
          size_bytes?: number
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_salary_structures: {
        Row: {
          basic: number
          company_id: string
          created_at: string
          dearness_allowance: number
          effective_from: string
          employee_id: string
          esi_applicable: boolean
          hra: number
          id: string
          other_allowance: number
          pf_applicable: boolean
          pf_wage_ceiling_applies: boolean
          professional_tax_monthly: number
          special_allowance: number
        }
        Insert: {
          basic: number
          company_id: string
          created_at?: string
          dearness_allowance?: number
          effective_from: string
          employee_id: string
          esi_applicable?: boolean
          hra?: number
          id?: string
          other_allowance?: number
          pf_applicable?: boolean
          pf_wage_ceiling_applies?: boolean
          professional_tax_monthly?: number
          special_allowance?: number
        }
        Update: {
          basic?: number
          company_id?: string
          created_at?: string
          dearness_allowance?: number
          effective_from?: string
          employee_id?: string
          esi_applicable?: boolean
          hra?: number
          id?: string
          other_allowance?: number
          pf_applicable?: boolean
          pf_wage_ceiling_applies?: boolean
          professional_tax_monthly?: number
          special_allowance?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_salary_structures_employee_id_company_id_fkey"
            columns: ["employee_id", "company_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      employees: {
        Row: {
          company_id: string
          created_at: string
          date_of_joining: string
          date_of_leaving: string | null
          esi_number: string | null
          id: string
          is_active: boolean
          name: string
          pan: string | null
          uan: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          date_of_joining: string
          date_of_leaving?: string | null
          esi_number?: string | null
          id?: string
          is_active?: boolean
          name: string
          pan?: string | null
          uan?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          date_of_joining?: string
          date_of_leaving?: string | null
          esi_number?: string | null
          id?: string
          is_active?: boolean
          name?: string
          pan?: string | null
          uan?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      fixed_assets: {
        Row: {
          acquisition_date: string
          asset_code: string | null
          book_method: string
          category_code: string
          company_id: string
          created_at: string
          created_by: string | null
          disposal_date: string | null
          disposal_value: number | null
          gross_value: number
          id: string
          is_active: boolean
          it_block: string
          name: string
          put_to_use_date: string
          residual_value_percent: number
          updated_at: string
        }
        Insert: {
          acquisition_date: string
          asset_code?: string | null
          book_method?: string
          category_code: string
          company_id: string
          created_at?: string
          created_by?: string | null
          disposal_date?: string | null
          disposal_value?: number | null
          gross_value: number
          id?: string
          is_active?: boolean
          it_block: string
          name: string
          put_to_use_date: string
          residual_value_percent?: number
          updated_at?: string
        }
        Update: {
          acquisition_date?: string
          asset_code?: string | null
          book_method?: string
          category_code?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          disposal_date?: string | null
          disposal_value?: number | null
          gross_value?: number
          id?: string
          is_active?: boolean
          it_block?: string
          name?: string
          put_to_use_date?: string
          residual_value_percent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fixed_assets_category_code_fkey"
            columns: ["category_code"]
            isOneToOne: false
            referencedRelation: "ref_depreciation_categories"
            referencedColumns: ["category_code"]
          },
          {
            foreignKeyName: "fixed_assets_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_it_block_fkey"
            columns: ["it_block"]
            isOneToOne: false
            referencedRelation: "ref_depreciation_blocks_it"
            referencedColumns: ["block_code"]
          },
        ]
      }
      godowns: {
        Row: {
          address: string | null
          branch_id: string
          code: string
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          branch_id: string
          code: string
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          branch_id?: string
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "godowns_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "godowns_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      gst_registrations: {
        Row: {
          company_id: string
          created_at: string
          filing_frequency: string
          gstin: string
          id: string
          is_active: boolean
          legal_name: string | null
          registered_from: string
          registered_to: string | null
          registration_type: string
          state_code: string
          trade_name: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          filing_frequency?: string
          gstin: string
          id?: string
          is_active?: boolean
          legal_name?: string | null
          registered_from: string
          registered_to?: string | null
          registration_type?: string
          state_code: string
          trade_name?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          filing_frequency?: string
          gstin?: string
          id?: string
          is_active?: boolean
          legal_name?: string | null
          registered_from?: string
          registered_to?: string | null
          registration_type?: string
          state_code?: string
          trade_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gst_registrations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gst_registrations_state_code_fkey"
            columns: ["state_code"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
      }
      item_batches: {
        Row: {
          batch_no: string
          company_id: string
          created_at: string
          created_by: string | null
          expiry_date: string | null
          id: string
          item_id: string
          mfg_date: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          batch_no: string
          company_id: string
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          id?: string
          item_id: string
          mfg_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          batch_no?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          id?: string
          item_id?: string
          mfg_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_batches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_batches_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      items: {
        Row: {
          batch_tracking: string
          category: string | null
          cess_rate_percent: number
          code: string | null
          company_id: string
          created_at: string
          created_by: string | null
          default_tcs_section: string | null
          gst_rate_percent: number
          hsn_sac: string | null
          id: string
          is_active: boolean
          item_type: string
          maintain_stock: boolean
          name: string
          opening_quantity: number
          opening_value: number
          purchase_rate: number | null
          reorder_level: number | null
          sale_rate: number | null
          supply_nature: string
          uom: string
          updated_at: string
        }
        Insert: {
          batch_tracking?: string
          category?: string | null
          cess_rate_percent?: number
          code?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          default_tcs_section?: string | null
          gst_rate_percent?: number
          hsn_sac?: string | null
          id?: string
          is_active?: boolean
          item_type?: string
          maintain_stock?: boolean
          name: string
          opening_quantity?: number
          opening_value?: number
          purchase_rate?: number | null
          reorder_level?: number | null
          sale_rate?: number | null
          supply_nature?: string
          uom?: string
          updated_at?: string
        }
        Update: {
          batch_tracking?: string
          category?: string | null
          cess_rate_percent?: number
          code?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          default_tcs_section?: string | null
          gst_rate_percent?: number
          hsn_sac?: string | null
          id?: string
          is_active?: boolean
          item_type?: string
          maintain_stock?: boolean
          name?: string
          opening_quantity?: number
          opening_value?: number
          purchase_rate?: number | null
          reorder_level?: number | null
          sale_rate?: number | null
          supply_nature?: string
          uom?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "items_default_tcs_section_fkey"
            columns: ["default_tcs_section"]
            isOneToOne: false
            referencedRelation: "ref_tcs_sections"
            referencedColumns: ["section_code"]
          },
          {
            foreignKeyName: "items_uom_fkey"
            columns: ["uom"]
            isOneToOne: false
            referencedRelation: "ref_uom"
            referencedColumns: ["code"]
          },
        ]
      }
      job_work_challans: {
        Row: {
          branch_id: string
          challan_date: string
          company_id: string
          created_at: string
          created_by: string | null
          expected_return_date: string | null
          extended_due_date: string | null
          id: string
          item_id: string
          job_worker_ledger_id: string
          nature_of_job_work: string | null
          quantity_sent: number
          status: string
          statutory_due_date: string | null
          statutory_limit_type: string
          uom: string
          updated_at: string
          voucher_id: string
        }
        Insert: {
          branch_id: string
          challan_date: string
          company_id: string
          created_at?: string
          created_by?: string | null
          expected_return_date?: string | null
          extended_due_date?: string | null
          id?: string
          item_id: string
          job_worker_ledger_id: string
          nature_of_job_work?: string | null
          quantity_sent: number
          status?: string
          statutory_due_date?: string | null
          statutory_limit_type?: string
          uom: string
          updated_at?: string
          voucher_id: string
        }
        Update: {
          branch_id?: string
          challan_date?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          expected_return_date?: string | null
          extended_due_date?: string | null
          id?: string
          item_id?: string
          job_worker_ledger_id?: string
          nature_of_job_work?: string | null
          quantity_sent?: number
          status?: string
          statutory_due_date?: string | null
          statutory_limit_type?: string
          uom?: string
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_work_challans_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "job_work_challans_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_work_challans_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "job_work_challans_job_worker_ledger_id_company_id_fkey"
            columns: ["job_worker_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "job_work_challans_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      job_work_returns: {
        Row: {
          challan_id: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          quantity_loss_or_waste: number
          quantity_received: number
          return_date: string
          return_voucher_id: string | null
          returned_item_id: string | null
        }
        Insert: {
          challan_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          quantity_loss_or_waste?: number
          quantity_received?: number
          return_date: string
          return_voucher_id?: string | null
          returned_item_id?: string | null
        }
        Update: {
          challan_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          quantity_loss_or_waste?: number
          quantity_received?: number
          return_date?: string
          return_voucher_id?: string | null
          returned_item_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_work_returns_challan_id_fkey"
            columns: ["challan_id"]
            isOneToOne: false
            referencedRelation: "job_work_challans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_work_returns_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_work_returns_return_voucher_id_fkey"
            columns: ["return_voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_work_returns_returned_item_id_company_id_fkey"
            columns: ["returned_item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      ledgers: {
        Row: {
          address: string | null
          city: string | null
          company_id: string
          contact_person: string | null
          created_at: string
          created_by: string | null
          credit_days: number | null
          credit_limit: number | null
          default_currency: string
          default_tds_section: string | null
          email: string | null
          group_id: string
          gst_registration_type: string | null
          gstin: string | null
          id: string
          is_active: boolean
          is_loan_or_deposit: boolean
          is_partner_remuneration: boolean
          is_related_party: boolean
          is_tds_deductee: boolean
          ldc_amount_cap: number | null
          ldc_number: string | null
          ldc_rate: number | null
          ldc_valid_from: string | null
          ldc_valid_to: string | null
          msme_category: string | null
          msme_payment_days: number | null
          name: string
          notes: string | null
          opening_balance_amount: number
          opening_balance_type: string
          pan: string | null
          party_type: string | null
          phone: string | null
          pincode: string | null
          sec43b_category: string | null
          state_code: string | null
          udyam_number: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          city?: string | null
          company_id: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          credit_days?: number | null
          credit_limit?: number | null
          default_currency?: string
          default_tds_section?: string | null
          email?: string | null
          group_id: string
          gst_registration_type?: string | null
          gstin?: string | null
          id?: string
          is_active?: boolean
          is_loan_or_deposit?: boolean
          is_partner_remuneration?: boolean
          is_related_party?: boolean
          is_tds_deductee?: boolean
          ldc_amount_cap?: number | null
          ldc_number?: string | null
          ldc_rate?: number | null
          ldc_valid_from?: string | null
          ldc_valid_to?: string | null
          msme_category?: string | null
          msme_payment_days?: number | null
          name: string
          notes?: string | null
          opening_balance_amount?: number
          opening_balance_type?: string
          pan?: string | null
          party_type?: string | null
          phone?: string | null
          pincode?: string | null
          sec43b_category?: string | null
          state_code?: string | null
          udyam_number?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          city?: string | null
          company_id?: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          credit_days?: number | null
          credit_limit?: number | null
          default_currency?: string
          default_tds_section?: string | null
          email?: string | null
          group_id?: string
          gst_registration_type?: string | null
          gstin?: string | null
          id?: string
          is_active?: boolean
          is_loan_or_deposit?: boolean
          is_partner_remuneration?: boolean
          is_related_party?: boolean
          is_tds_deductee?: boolean
          ldc_amount_cap?: number | null
          ldc_number?: string | null
          ldc_rate?: number | null
          ldc_valid_from?: string | null
          ldc_valid_to?: string | null
          msme_category?: string | null
          msme_payment_days?: number | null
          name?: string
          notes?: string | null
          opening_balance_amount?: number
          opening_balance_type?: string
          pan?: string | null
          party_type?: string | null
          phone?: string | null
          pincode?: string | null
          sec43b_category?: string | null
          state_code?: string | null
          udyam_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledgers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledgers_default_tds_section_fkey"
            columns: ["default_tds_section"]
            isOneToOne: false
            referencedRelation: "ref_tds_sections"
            referencedColumns: ["section_code"]
          },
          {
            foreignKeyName: "ledgers_group_id_company_id_fkey"
            columns: ["group_id", "company_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "ledgers_state_code_fkey"
            columns: ["state_code"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
      }
      member_branches: {
        Row: {
          branch_id: string
          company_id: string
          company_member_id: string
          created_at: string
          id: string
        }
        Insert: {
          branch_id: string
          company_id: string
          company_member_id: string
          created_at?: string
          id?: string
        }
        Update: {
          branch_id?: string
          company_id?: string
          company_member_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_branches_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "member_branches_company_member_id_company_id_fkey"
            columns: ["company_member_id", "company_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      notices: {
        Row: {
          amount_involved: number | null
          authority: string
          company_id: string
          created_at: string
          created_by: string | null
          description: string
          due_date: string | null
          id: string
          notice_date: string
          notice_number: string | null
          notice_type: string
          received_date: string
          response_date: string | null
          response_note: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_involved?: number | null
          authority: string
          company_id: string
          created_at?: string
          created_by?: string | null
          description: string
          due_date?: string | null
          id?: string
          notice_date: string
          notice_number?: string | null
          notice_type: string
          received_date: string
          response_date?: string | null
          response_note?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount_involved?: number | null
          authority?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          description?: string
          due_date?: string | null
          id?: string
          notice_date?: string
          notice_number?: string | null
          notice_type?: string
          received_date?: string
          response_date?: string | null
          response_note?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notices_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          amount: number
          company_id: string
          description: string
          id: string
          item_id: string | null
          line_order: number
          order_id: string
          quantity: number
          rate: number
          uom: string | null
        }
        Insert: {
          amount?: number
          company_id: string
          description: string
          id?: string
          item_id?: string | null
          line_order?: number
          order_id: string
          quantity: number
          rate?: number
          uom?: string | null
        }
        Update: {
          amount?: number
          company_id?: string
          description?: string
          id?: string
          item_id?: string | null
          line_order?: number
          order_id?: string
          quantity?: number
          rate?: number
          uom?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          branch_id: string
          company_id: string
          created_at: string
          created_by: string | null
          expected_date: string | null
          fulfilled_note: string | null
          fulfilled_voucher_id: string | null
          id: string
          notes: string | null
          order_date: string
          order_reference: string | null
          order_type: string
          party_ledger_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          fulfilled_note?: string | null
          fulfilled_voucher_id?: string | null
          id?: string
          notes?: string | null
          order_date: string
          order_reference?: string | null
          order_type: string
          party_ledger_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          fulfilled_note?: string | null
          fulfilled_voucher_id?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          order_reference?: string | null
          order_type?: string
          party_ledger_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "orders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_fulfilled_voucher_id_company_id_fkey"
            columns: ["fulfilled_voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "orders_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      payroll_ledger_map: {
        Row: {
          company_id: string
          id: string
          ledger_id: string
          purpose: string
        }
        Insert: {
          company_id: string
          id?: string
          ledger_id: string
          purpose: string
        }
        Update: {
          company_id?: string
          id?: string
          ledger_id?: string
          purpose?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_ledger_map_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_ledger_map_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      payroll_postings: {
        Row: {
          company_id: string
          id: string
          period_month: string
          posted_at: string
          posted_by: string | null
          voucher_id: string
        }
        Insert: {
          company_id: string
          id?: string
          period_month: string
          posted_at?: string
          posted_by?: string | null
          voucher_id: string
        }
        Update: {
          company_id?: string
          id?: string
          period_month?: string
          posted_at?: string
          posted_by?: string | null
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_postings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_postings_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      ref_depreciation_blocks_it: {
        Row: {
          block_code: string
          description: string
          is_active: boolean
          rate_percent: number
          sort_order: number
        }
        Insert: {
          block_code: string
          description: string
          is_active?: boolean
          rate_percent: number
          sort_order: number
        }
        Update: {
          block_code?: string
          description?: string
          is_active?: boolean
          rate_percent?: number
          sort_order?: number
        }
        Relationships: []
      }
      ref_depreciation_categories: {
        Row: {
          category_code: string
          description: string
          is_active: boolean
          is_nesd: boolean
          sort_order: number
          useful_life_years: number
        }
        Insert: {
          category_code: string
          description: string
          is_active?: boolean
          is_nesd?: boolean
          sort_order: number
          useful_life_years: number
        }
        Update: {
          category_code?: string
          description?: string
          is_active?: boolean
          is_nesd?: boolean
          sort_order?: number
          useful_life_years?: number
        }
        Relationships: []
      }
      ref_entity_types: {
        Row: {
          code: string
          governing_act: string | null
          interest_on_capital_cap_percent: number | null
          itr_form: string
          name: string
          presumptive_allowed: boolean
          remuneration_section: string | null
          roc_applicable: boolean
          roc_forms: string[] | null
          sort_order: number
          special_provisions: string[] | null
          statement_format: string
          statutory_audit_note: string | null
          statutory_audit_rule: string
          tax_audit_report_form: string
        }
        Insert: {
          code: string
          governing_act?: string | null
          interest_on_capital_cap_percent?: number | null
          itr_form: string
          name: string
          presumptive_allowed?: boolean
          remuneration_section?: string | null
          roc_applicable?: boolean
          roc_forms?: string[] | null
          sort_order?: number
          special_provisions?: string[] | null
          statement_format: string
          statutory_audit_note?: string | null
          statutory_audit_rule: string
          tax_audit_report_form: string
        }
        Update: {
          code?: string
          governing_act?: string | null
          interest_on_capital_cap_percent?: number | null
          itr_form?: string
          name?: string
          presumptive_allowed?: boolean
          remuneration_section?: string | null
          roc_applicable?: boolean
          roc_forms?: string[] | null
          sort_order?: number
          special_provisions?: string[] | null
          statement_format?: string
          statutory_audit_note?: string | null
          statutory_audit_rule?: string
          tax_audit_report_form?: string
        }
        Relationships: []
      }
      ref_income_tax_slabs: {
        Row: {
          from_rupees: number
          rate_percent: number
          sort_order: number
          to_rupees: number
        }
        Insert: {
          from_rupees: number
          rate_percent: number
          sort_order: number
          to_rupees: number
        }
        Update: {
          from_rupees?: number
          rate_percent?: number
          sort_order?: number
          to_rupees?: number
        }
        Relationships: []
      }
      ref_modules: {
        Row: {
          activates_when: Json | null
          code: string
          depends_on: string[]
          description: string | null
          name: string
          sort_order: number
          tier: string
        }
        Insert: {
          activates_when?: Json | null
          code: string
          depends_on?: string[]
          description?: string | null
          name: string
          sort_order?: number
          tier: string
        }
        Update: {
          activates_when?: Json | null
          code?: string
          depends_on?: string[]
          description?: string | null
          name?: string
          sort_order?: number
          tier?: string
        }
        Relationships: []
      }
      ref_states: {
        Row: {
          code: string
          intra_state_component: string
          is_active: boolean
          jurisdiction: string
          name: string
          obsolete_note: string | null
          qrmp_category: string | null
        }
        Insert: {
          code: string
          intra_state_component: string
          is_active?: boolean
          jurisdiction: string
          name: string
          obsolete_note?: string | null
          qrmp_category?: string | null
        }
        Update: {
          code?: string
          intra_state_component?: string
          is_active?: boolean
          jurisdiction?: string
          name?: string
          obsolete_note?: string | null
          qrmp_category?: string | null
        }
        Relationships: []
      }
      ref_tcs_sections: {
        Row: {
          description: string
          is_active: boolean
          no_pan_rate_percent: number
          rate_percent: number
          section_code: string
          sort_order: number
          threshold_note: string | null
          threshold_rupees: number | null
        }
        Insert: {
          description: string
          is_active?: boolean
          no_pan_rate_percent: number
          rate_percent: number
          section_code: string
          sort_order: number
          threshold_note?: string | null
          threshold_rupees?: number | null
        }
        Update: {
          description?: string
          is_active?: boolean
          no_pan_rate_percent?: number
          rate_percent?: number
          section_code?: string
          sort_order?: number
          threshold_note?: string | null
          threshold_rupees?: number | null
        }
        Relationships: []
      }
      ref_tds_sections: {
        Row: {
          description: string
          is_active: boolean
          no_pan_rate_percent: number
          rate_percent: number
          section_code: string
          sort_order: number
          threshold_aggregate_rupees: number | null
          threshold_note: string | null
          threshold_single_rupees: number | null
        }
        Insert: {
          description: string
          is_active?: boolean
          no_pan_rate_percent: number
          rate_percent: number
          section_code: string
          sort_order: number
          threshold_aggregate_rupees?: number | null
          threshold_note?: string | null
          threshold_single_rupees?: number | null
        }
        Update: {
          description?: string
          is_active?: boolean
          no_pan_rate_percent?: number
          rate_percent?: number
          section_code?: string
          sort_order?: number
          threshold_aggregate_rupees?: number | null
          threshold_note?: string | null
          threshold_single_rupees?: number | null
        }
        Relationships: []
      }
      ref_uom: {
        Row: {
          code: string
          decimals: number
          name: string
        }
        Insert: {
          code: string
          decimals?: number
          name: string
        }
        Update: {
          code?: string
          decimals?: number
          name?: string
        }
        Relationships: []
      }
      statutory_rules: {
        Row: {
          attrs: Json
          authority: string | null
          created_at: string
          domain: string
          effective_from: string
          effective_to: string | null
          id: string
          notes: string | null
          rule_key: string
          scope: Json
          value: number | null
        }
        Insert: {
          attrs?: Json
          authority?: string | null
          created_at?: string
          domain: string
          effective_from: string
          effective_to?: string | null
          id?: string
          notes?: string | null
          rule_key: string
          scope?: Json
          value?: number | null
        }
        Update: {
          attrs?: Json
          authority?: string | null
          created_at?: string
          domain?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          notes?: string | null
          rule_key?: string
          scope?: Json
          value?: number | null
        }
        Relationships: []
      }
      statutory_update_notes: {
        Row: {
          applied_note: string | null
          area: string
          citation_text: string | null
          citation_url: string | null
          created_at: string
          created_by: string | null
          description: string
          effective_date: string
          id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          applied_note?: string | null
          area: string
          citation_text?: string | null
          citation_url?: string | null
          created_at?: string
          created_by?: string | null
          description: string
          effective_date: string
          id?: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          applied_note?: string | null
          area?: string
          citation_text?: string | null
          citation_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string
          effective_date?: string
          id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      tax_ledger_map: {
        Row: {
          company_id: string
          created_at: string
          gst_registration_id: string | null
          id: string
          ledger_id: string
          purpose: string
        }
        Insert: {
          company_id: string
          created_at?: string
          gst_registration_id?: string | null
          id?: string
          ledger_id: string
          purpose: string
        }
        Update: {
          company_id?: string
          created_at?: string
          gst_registration_id?: string | null
          id?: string
          ledger_id?: string
          purpose?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_ledger_map_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_ledger_map_gst_registration_id_company_id_fkey"
            columns: ["gst_registration_id", "company_id"]
            isOneToOne: false
            referencedRelation: "gst_registrations"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "tax_ledger_map_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      tax_payments: {
        Row: {
          amount: number
          branch_id: string | null
          bsr_code: string | null
          challan_reference: string | null
          challan_serial: string | null
          company_id: string
          created_at: string
          created_by: string | null
          financial_year_label: string
          id: string
          minor_head: string | null
          notes: string | null
          payment_date: string
          tax_type: string
          tds_section: string | null
          updated_at: string
          voucher_id: string | null
        }
        Insert: {
          amount: number
          branch_id?: string | null
          bsr_code?: string | null
          challan_reference?: string | null
          challan_serial?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          financial_year_label: string
          id?: string
          minor_head?: string | null
          notes?: string | null
          payment_date: string
          tax_type: string
          tds_section?: string | null
          updated_at?: string
          voucher_id?: string | null
        }
        Update: {
          amount?: number
          branch_id?: string | null
          bsr_code?: string | null
          challan_reference?: string | null
          challan_serial?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          financial_year_label?: string
          id?: string
          minor_head?: string | null
          notes?: string | null
          payment_date?: string
          tax_type?: string
          tds_section?: string | null
          updated_at?: string
          voucher_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      voucher_entries: {
        Row: {
          branch_id: string
          company_id: string
          created_at: string
          credit_amount: number
          debit_amount: number
          dimensions: Json
          fc_amount: number | null
          id: string
          ledger_id: string
          line_order: number
          narration: string | null
          updated_at: string
          voucher_id: string
        }
        Insert: {
          branch_id: string
          company_id: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          dimensions?: Json
          fc_amount?: number | null
          id?: string
          ledger_id: string
          line_order?: number
          narration?: string | null
          updated_at?: string
          voucher_id: string
        }
        Update: {
          branch_id?: string
          company_id?: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          dimensions?: Json
          fc_amount?: number | null
          id?: string
          ledger_id?: string
          line_order?: number
          narration?: string | null
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_entries_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_entries_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_entries_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      voucher_item_batches: {
        Row: {
          batch_id: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          quantity: number
          voucher_item_id: string
        }
        Insert: {
          batch_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          quantity: number
          voucher_item_id: string
        }
        Update: {
          batch_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          quantity?: number
          voucher_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_item_batches_batch_id_company_id_fkey"
            columns: ["batch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "item_batches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_item_batches_voucher_item_id_fkey"
            columns: ["voucher_item_id"]
            isOneToOne: false
            referencedRelation: "voucher_items"
            referencedColumns: ["id"]
          },
        ]
      }
      voucher_items: {
        Row: {
          amount: number
          branch_id: string
          company_id: string
          created_at: string
          description: string | null
          direction: string
          godown_id: string
          hsn_sac: string | null
          id: string
          item_id: string
          line_order: number
          quantity: number
          rate: number
          uom: string
          updated_at: string
          voucher_id: string
        }
        Insert: {
          amount?: number
          branch_id: string
          company_id: string
          created_at?: string
          description?: string | null
          direction: string
          godown_id: string
          hsn_sac?: string | null
          id?: string
          item_id: string
          line_order?: number
          quantity: number
          rate?: number
          uom: string
          updated_at?: string
          voucher_id: string
        }
        Update: {
          amount?: number
          branch_id?: string
          company_id?: string
          created_at?: string
          description?: string | null
          direction?: string
          godown_id?: string
          hsn_sac?: string | null
          id?: string
          item_id?: string
          line_order?: number
          quantity?: number
          rate?: number
          uom?: string
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_items_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_items_godown_id_company_id_fkey"
            columns: ["godown_id", "company_id"]
            isOneToOne: false
            referencedRelation: "godowns"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_items_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_items_uom_fkey"
            columns: ["uom"]
            isOneToOne: false
            referencedRelation: "ref_uom"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "voucher_items_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      voucher_number_sequences: {
        Row: {
          branch_id: string
          company_id: string
          financial_year_label: string
          next_number: number
          padding: number
          prefix: string
          voucher_type: string
        }
        Insert: {
          branch_id: string
          company_id: string
          financial_year_label: string
          next_number?: number
          padding?: number
          prefix: string
          voucher_type: string
        }
        Update: {
          branch_id?: string
          company_id?: string
          financial_year_label?: string
          next_number?: number
          padding?: number
          prefix?: string
          voucher_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_number_sequences_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_number_sequences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      vouchers: {
        Row: {
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          branch_id: string
          company_id: string
          created_at: string
          created_by: string | null
          exchange_rate: number
          fc_last_revalued_at: string | null
          fc_last_revalued_rate: number | null
          fc_revalues_voucher_id: string | null
          fc_settled_at: string | null
          fc_settlement_voucher_id: string | null
          financial_year_label: string
          id: string
          is_deleted: boolean
          narration: string | null
          party_ledger_id: string | null
          place_of_supply: string | null
          rate_source: string | null
          reference_date: string | null
          reference_number: string | null
          sequence_number: number
          supply_type: string | null
          total_amount: number
          txn_currency: string
          updated_at: string
          updated_by: string | null
          voucher_date: string
          voucher_number: string
          voucher_type: string
        }
        Insert: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          branch_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          exchange_rate?: number
          fc_last_revalued_at?: string | null
          fc_last_revalued_rate?: number | null
          fc_revalues_voucher_id?: string | null
          fc_settled_at?: string | null
          fc_settlement_voucher_id?: string | null
          financial_year_label: string
          id?: string
          is_deleted?: boolean
          narration?: string | null
          party_ledger_id?: string | null
          place_of_supply?: string | null
          rate_source?: string | null
          reference_date?: string | null
          reference_number?: string | null
          sequence_number: number
          supply_type?: string | null
          total_amount?: number
          txn_currency?: string
          updated_at?: string
          updated_by?: string | null
          voucher_date: string
          voucher_number: string
          voucher_type: string
        }
        Update: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          exchange_rate?: number
          fc_last_revalued_at?: string | null
          fc_last_revalued_rate?: number | null
          fc_revalues_voucher_id?: string | null
          fc_settled_at?: string | null
          fc_settlement_voucher_id?: string | null
          financial_year_label?: string
          id?: string
          is_deleted?: boolean
          narration?: string | null
          party_ledger_id?: string | null
          place_of_supply?: string | null
          rate_source?: string | null
          reference_date?: string | null
          reference_number?: string | null
          sequence_number?: number
          supply_type?: string | null
          total_amount?: number
          txn_currency?: string
          updated_at?: string
          updated_by?: string | null
          voucher_date?: string
          voucher_number?: string
          voucher_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "vouchers_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "vouchers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vouchers_fc_revalues_voucher_id_fkey"
            columns: ["fc_revalues_voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vouchers_fc_settlement_voucher_id_fkey"
            columns: ["fc_settlement_voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vouchers_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "vouchers_place_of_supply_fkey"
            columns: ["place_of_supply"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_gst_registration: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_filing_frequency?: string
          p_gstin: string
          p_registered_from: string
          p_registration_type?: string
        }
        Returns: string
      }
      advance_order_status: {
        Args: {
          p_company_id: string
          p_fulfilled_note?: string
          p_new_status: string
          p_order_id: string
        }
        Returns: undefined
      }
      allocate_voucher_item_to_batch: {
        Args: {
          p_batch_id: string
          p_company_id: string
          p_quantity: number
          p_voucher_item_id: string
        }
        Returns: string
      }
      api_get_dashboard_kpis: {
        Args: { p_api_key: string }
        Returns: {
          cash_bank: number
          gst_liability: number
          payables: number
          receivables: number
          receivables_overdue: number
          tds_payable: number
        }[]
      }
      api_get_trial_balance: {
        Args: { p_api_key: string; p_from: string; p_to: string }
        Returns: {
          closing_credit: number
          closing_debit: number
          group_name: string
          ledger_name: string
          nature: string
          opening_credit: number
          opening_debit: number
          period_credit: number
          period_debit: number
        }[]
      }
      approve_voucher: {
        Args: { p_company_id: string; p_voucher_id: string }
        Returns: undefined
      }
      auto_match_bank_lines: {
        Args: { p_company_id: string; p_ledger_id: string }
        Returns: number
      }
      close_period: {
        Args: { p_company_id: string; p_lock_date: string }
        Returns: undefined
      }
      create_api_key: {
        Args: { p_company_id: string; p_name: string }
        Returns: string
      }
      create_company: {
        Args: {
          p_book_beginning_date: string
          p_compliance_mode?: string
          p_entity_type: string
          p_financial_year_start_month?: number
          p_name: string
          p_pan?: string
          p_state_code: string
        }
        Returns: string
      }
      create_invoice: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_exchange_rate?: number
          p_godown_id: string
          p_items: Json
          p_narration?: string
          p_party_ledger_id: string
          p_place_of_supply?: string
          p_rate_source?: string
          p_reference_date?: string
          p_reference_number?: string
          p_trading_ledger_id: string
          p_txn_currency?: string
          p_voucher_date: string
          p_voucher_type: string
        }
        Returns: string
      }
      create_invoices_bulk: {
        Args: { p_company_id: string; p_groups: Json }
        Returns: {
          error_message: string
          group_key: string
          voucher_id: string
        }[]
      }
      create_job_work_challan: {
        Args: {
          p_branch_id: string
          p_challan_date: string
          p_company_id: string
          p_expected_return_date?: string
          p_godown_id: string
          p_item_id: string
          p_job_worker_ledger_id: string
          p_narration?: string
          p_nature_of_job_work?: string
          p_quantity: number
          p_rate: number
          p_statutory_limit_type?: string
          p_uom: string
        }
        Returns: string
      }
      create_job_work_return: {
        Args: {
          p_branch_id: string
          p_challan_id: string
          p_company_id: string
          p_godown_id?: string
          p_notes?: string
          p_quantity_loss_or_waste?: number
          p_quantity_received?: number
          p_rate?: number
          p_return_date: string
          p_returned_item_id?: string
        }
        Returns: string
      }
      create_order: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_expected_date?: string
          p_items?: Json
          p_notes?: string
          p_order_date?: string
          p_order_reference?: string
          p_order_type: string
          p_party_ledger_id?: string
        }
        Returns: string
      }
      create_production_voucher: {
        Args: {
          p_additional_cost?: number
          p_bom_id: string
          p_branch_id: string
          p_company_id: string
          p_component_godown_id: string
          p_narration?: string
          p_output_godown_id: string
          p_quantity_produced: number
          p_voucher_date: string
        }
        Returns: string
      }
      create_voucher: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_exchange_rate?: number
          p_lines: Json
          p_narration?: string
          p_party_ledger_id?: string
          p_rate_source?: string
          p_reference_date?: string
          p_reference_number?: string
          p_txn_currency?: string
          p_voucher_date: string
          p_voucher_type: string
        }
        Returns: string
      }
      create_vouchers_bulk: {
        Args: { p_company_id: string; p_groups: Json }
        Returns: {
          error_message: string
          group_key: string
          voucher_id: string
        }[]
      }
      delete_company: { Args: { p_company_id: string }; Returns: undefined }
      delete_voucher: {
        Args: { p_company_id: string; p_voucher_id: string }
        Returns: undefined
      }
      ensure_cash_sales_ledger: {
        Args: { p_company_id: string }
        Returns: string
      }
      ensure_exchange_gain_loss_ledger: {
        Args: { p_company_id: string }
        Returns: string
      }
      ensure_job_work_movement_ledger: {
        Args: { p_company_id: string }
        Returns: string
      }
      ensure_manufacturing_clearing_ledger: {
        Args: { p_company_id: string }
        Returns: string
      }
      find_duplicate_bills: {
        Args: {
          p_company_id: string
          p_exclude_voucher_id?: string
          p_party_ledger_id: string
          p_reference_number: string
        }
        Returns: {
          id: string
          total_amount: number
          voucher_date: string
          voucher_number: string
        }[]
      }
      get_allocatable_entries: {
        Args: {
          p_company_id: string
          p_from: string
          p_to: string
          p_unallocated_only?: boolean
        }
        Returns: {
          amount: number
          cost_centre_id: string
          cost_centre_name: string
          entry_id: string
          is_expense: boolean
          ledger_name: string
          narration: string
          nature: string
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_audit_trail: {
        Args: {
          p_company_id: string
          p_from?: string
          p_limit?: number
          p_table_name?: string
          p_to?: string
        }
        Returns: {
          changed_at: string
          changed_by: string
          changed_by_name: string
          changed_fields: string[]
          derived_note: string
          id: string
          operation: string
          record_id: string
          table_name: string
        }[]
      }
      get_balance_sheet: {
        Args: { p_as_at: string; p_branch_id?: string; p_company_id: string }
        Returns: {
          amount: number
          group_name: string
          ledger_name: string
          nature: string
          side: string
        }[]
      }
      get_bank_reconciliation_summary: {
        Args: { p_as_at?: string; p_company_id: string; p_ledger_id: string }
        Returns: {
          book_balance: number
          unmatched_book_count: number
          unmatched_book_total: number
          unmatched_statement_count: number
          unmatched_statement_total: number
        }[]
      }
      get_batch_stock_summary: {
        Args: { p_as_at?: string; p_company_id: string; p_godown_id?: string }
        Returns: {
          batch_id: string
          batch_no: string
          days_to_expiry: number
          expiry_date: string
          item_id: string
          item_name: string
          mfg_date: string
          quantity_in: number
          quantity_on_hand: number
          quantity_out: number
          uom: string
        }[]
      }
      get_boms: {
        Args: { p_company_id: string }
        Returns: {
          bom_id: string
          component_cost_at_yield: number
          component_count: number
          is_active: boolean
          name: string
          output_item_id: string
          output_item_name: string
          output_uom: string
          yield_quantity: number
        }[]
      }
      get_budget_variance: {
        Args: {
          p_budget_id: string
          p_company_id: string
          p_from: string
          p_to: string
        }
        Returns: {
          actual: number
          budgeted: number
          ledger_id: string
          ledger_name: string
          nature: string
          variance: number
          variance_percent: number
        }[]
      }
      get_cma_ratios: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          benchmark: number
          benchmark_note: string
          is_healthy: boolean
          metric_code: string
          metric_label: string
          section: string
          unit: string
          value: number
        }[]
      }
      get_company_modules: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          active: boolean
          can_toggle: boolean
          code: string
          depends_on: string[]
          description: string
          licensed: boolean
          locked_reason: string
          name: string
          tier: string
        }[]
      }
      get_company_profile: {
        Args: { p_company_id: string }
        Returns: {
          company_id: string
          compliance_mode: string
          entity_name: string
          entity_type: string
          financial_year_start_month: number
          has_iec: boolean
          has_pan: boolean
          has_tan: boolean
          itr_form: string
          name: string
          presumptive_allowed: boolean
          remuneration_section: string
          roc_applicable: boolean
          roc_forms: string[]
          special_provisions: string[]
          statement_format: string
          statutory_audit_rule: string
          tax_audit_report_form: string
        }[]
      }
      get_compliance_calendar: {
        Args: { p_company_id: string; p_from?: string; p_to?: string }
        Returns: {
          category: string
          detail: string
          due_date: string
          label: string
        }[]
      }
      get_cost_centre_pnl: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          code: string
          cost_centre_id: string
          entry_count: number
          expense: number
          income: number
          kind: string
          name: string
          net: number
        }[]
      }
      get_dashboard_kpis: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          cash_bank: number
          gst_liability: number
          payables: number
          receivables: number
          receivables_overdue: number
          tds_payable: number
        }[]
      }
      get_daybook: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_from: string
          p_to: string
        }
        Returns: {
          branch_code: string
          line_count: number
          narration: string
          party_name: string
          reference_number: string
          total_amount: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_drawing_power: {
        Args: { p_as_at?: string; p_company_id: string; p_facility_id?: string }
        Returns: {
          bank_name: string
          closing_stock_value: number
          debtor_eligibility_days: number
          debtor_margin_percent: number
          dp_from_debtors: number
          dp_from_stock: number
          eligible_debtors: number
          facility_id: string
          ineligible_debtors: number
          paid_stock: number
          sanctioned_limit: number
          stock_margin_percent: number
          sundry_creditors: number
          total_debtors: number
          total_drawing_power: number
        }[]
      }
      get_fixed_asset_book_reconciliation: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          accumulated_gap: number
          books_accumulated: number
          books_gross: number
          gross_gap: number
          register_accumulated: number
          register_gross: number
        }[]
      }
      get_fixed_asset_register: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          accumulated_depreciation: number
          acquisition_date: string
          asset_code: string
          asset_id: string
          book_method: string
          category_code: string
          category_description: string
          disposal_date: string
          disposal_value: number
          gross_value: number
          is_active: boolean
          it_block: string
          name: string
          net_book_value: number
          put_to_use_date: string
          residual_value_percent: number
        }[]
      }
      get_form_3cd_particulars: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          clause: string
          source_note: string
          title: string
          value_numeric: number
          value_text: string
          value_type: string
        }[]
      }
      get_general_sec43b_dues: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          category: string
          ledger_id: string
          ledger_name: string
          outstanding_amount: number
        }[]
      }
      get_gst_input_register: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          igst: number
          invoice_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          sgst: number
          supply_type: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_gst_output_register: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          igst: number
          invoice_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          sgst: number
          supply_type: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_gstr1_hsn_summary: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          effective_rate_percent: number
          hsn_sac: string
          igst: number
          sgst: number
          taxable_value: number
          total_quantity: number
          total_value: number
          uom: string
        }[]
      }
      get_gstr1_table8: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          description: string
          exempted: number
          nil_rated: number
          non_gst: number
          table_ref: string
          total: number
        }[]
      }
      get_income_tax_computation: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          advance_tax_paid: number
          applicable: boolean
          book_depreciation_addback: number
          book_depreciation_per_register: number
          book_profit: number
          business_income: number
          business_loss_carried_forward: number
          capital_loss_carried_forward: number
          cess: number
          entity_type: string
          gross_total_income: number
          msme_disallowance_addback: number
          net_tax_payable: number
          note: string
          partner_remuneration_booked: number
          partner_remuneration_disallowed: number
          rebate_87a: number
          regime_used: string
          self_assessment_tax_paid: number
          short_term_capital_gain: number
          short_term_capital_loss: number
          surcharge: number
          tax_after_rebate: number
          tax_before_rebate: number
          tax_depreciation_deduction: number
          taxable_income: number
          tds_tcs_credit: number
          total_tax: number
        }[]
      }
      get_isd_distribution: {
        Args: {
          p_company_id: string
          p_isd_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          distributed_cess: number
          distributed_cgst: number
          distributed_igst: number
          distributed_sgst: number
          distributed_total: number
          recipient_gstin: string
          recipient_registration_id: string
          recipient_state: string
          recipient_turnover: number
          same_state: boolean
          turnover_ratio: number
        }[]
      }
      get_itc04_table4: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          challan_date: string
          challan_id: string
          challan_number: string
          hsn_sac: string
          item_name: string
          job_worker_gstin: string
          job_worker_name: string
          nature_of_job_work: string
          quantity_sent: number
          uom: string
        }[]
      }
      get_itc04_table5a: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          hsn_sac: string
          job_worker_gstin: string
          job_worker_name: string
          original_challan_date: string
          original_challan_number: string
          quantity_loss_or_waste: number
          quantity_received: number
          return_date: string
          return_id: string
          returned_item_name: string
          uom: string
        }[]
      }
      get_job_work_outstanding: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          challan_date: string
          challan_id: string
          challan_number: string
          extended_due_date: string
          is_overdue: boolean
          item_id: string
          item_name: string
          job_worker_name: string
          quantity_loss: number
          quantity_outstanding: number
          quantity_received: number
          quantity_sent: number
          status: string
          statutory_due_date: string
          uom: string
        }[]
      }
      get_ledger_statement: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_from: string
          p_ledger_id: string
          p_to: string
        }
        Returns: {
          contra_ledgers: string
          credit_amount: number
          debit_amount: number
          narration: string
          running_balance: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_needs_attention: {
        Args: { p_company_id: string }
        Returns: {
          category: string
          detail: string
          href: string
          label: string
          severity: string
        }[]
      }
      get_notices: {
        Args: { p_company_id: string; p_status_filter?: string }
        Returns: {
          amount_involved: number
          authority: string
          days_remaining: number
          description: string
          due_date: string
          id: string
          is_overdue: boolean
          notice_date: string
          notice_number: string
          notice_type: string
          received_date: string
          response_date: string
          response_note: string
          status: string
        }[]
      }
      get_open_fc_vouchers: {
        Args: { p_company_id: string }
        Returns: {
          carrying_rate: number
          direction: string
          exchange_rate: number
          fc_amount: number
          inr_amount: number
          last_revalued_at: string
          party_ledger_id: string
          party_ledger_name: string
          txn_currency: string
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_orders: {
        Args: {
          p_company_id: string
          p_order_type?: string
          p_status_filter?: string
        }
        Returns: {
          expected_date: string
          fulfilled_note: string
          fulfilled_voucher_id: string
          fulfilled_voucher_number: string
          id: string
          item_count: number
          notes: string
          order_date: string
          order_reference: string
          order_type: string
          party_name: string
          status: string
          total_amount: number
        }[]
      }
      get_overdue_receivables: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          days_overdue: number
          due_date: string
          outstanding: number
          party_name: string
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_party_outstanding: {
        Args: { p_as_at?: string; p_company_id: string; p_role?: string }
        Returns: {
          days_0_30: number
          days_31_60: number
          days_61_90: number
          days_over_90: number
          ledger_id: string
          ledger_name: string
          not_due: number
          oldest_date: string
          outstanding: number
        }[]
      }
      get_payroll_run: {
        Args: { p_company_id: string; p_period_month: string }
        Returns: {
          basic: number
          days_in_month: number
          days_paid: number
          dearness_allowance: number
          edli_employer: number
          employee_id: string
          employee_name: string
          esi_applicable: boolean
          esi_employee: number
          esi_employer: number
          gross_pay: number
          hra: number
          net_pay: number
          other_allowance: number
          pf_employee: number
          pf_employer: number
          pf_wage: number
          professional_tax: number
          special_allowance: number
          tds: number
        }[]
      }
      get_profit_and_loss: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_from: string
          p_to: string
        }
        Returns: {
          amount: number
          group_name: string
          ledger_name: string
          nature: string
          section: string
        }[]
      }
      get_quantitative_stock_details: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          closing_quantity: number
          hsn_sac: string
          is_principal_item: boolean
          item_id: string
          item_name: string
          opening_quantity: number
          purchases_quantity: number
          sales_quantity: number
          uom: string
        }[]
      }
      get_related_party_payments: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          amount_paid: number
          ledger_id: string
          ledger_name: string
          pan: string
        }[]
      }
      get_salary_tds_estimate: {
        Args: { p_company_id: string; p_period_month: string }
        Returns: {
          annual_projected_gross: number
          annual_tax: number
          employee_id: string
          employee_name: string
          monthly_gross: number
          monthly_tds: number
          standard_deduction: number
          taxable_salary_income: number
        }[]
      }
      get_sec269ss_loan_receipts: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          amount_received: number
          balance_after: number
          ledger_id: string
          ledger_name: string
          receipt_date: string
          voucher_id: string
        }[]
      }
      get_sec269t_loan_repayments: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          amount_repaid: number
          balance_before: number
          ledger_id: string
          ledger_name: string
          repayment_date: string
          voucher_id: string
        }[]
      }
      get_sec40a3_cash_payments: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          cash_amount: number
          payee_ledger_id: string
          payee_name: string
          payment_count: number
          payment_date: string
        }[]
      }
      get_stock_summary: {
        Args: { p_as_at?: string; p_company_id: string; p_godown_id?: string }
        Returns: {
          average_rate: number
          closing_quantity: number
          closing_value: number
          hsn_sac: string
          item_id: string
          item_name: string
          quantity_in: number
          quantity_out: number
          uom: string
        }[]
      }
      get_tax_audit_applicability: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          audit_required: boolean
          cash_payment_percent: number
          cash_payments: number
          cash_receipt_percent: number
          cash_receipts: number
          due_date: string
          entity_type: string
          is_professional: boolean
          reason: string
          report_form: string
          threshold_used: number
          total_payments: number
          total_receipts: number
          turnover: number
        }[]
      }
      get_tax_depreciation_blocks: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          additions: number
          block_ceased: boolean
          block_code: string
          block_description: string
          closing_wdv: number
          depreciation_for_year: number
          disposals: number
          opening_wdv: number
          rate_percent: number
          short_term_capital_gain: number
          short_term_capital_loss: number
        }[]
      }
      get_tds_deductee_summary: {
        Args: {
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          deductee_ledger_id: string
          deductee_name: string
          pan: string
          party_ledger_movement: number
          section_code: string
          section_description: string
          section_rate_percent: number
          tds_deducted: number
          voucher_count: number
        }[]
      }
      get_trial_balance: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_from: string
          p_to: string
        }
        Returns: {
          closing_credit: number
          closing_debit: number
          group_name: string
          ledger_id: string
          ledger_name: string
          nature: string
          opening_credit: number
          opening_debit: number
          period_credit: number
          period_debit: number
        }[]
      }
      get_unallocated_stock_lines: {
        Args: {
          p_company_id: string
          p_direction?: string
          p_from?: string
          p_to?: string
        }
        Returns: {
          allocated_quantity: number
          direction: string
          godown_id: string
          godown_name: string
          item_id: string
          item_name: string
          line_quantity: number
          unallocated_quantity: number
          uom: string
          voucher_date: string
          voucher_id: string
          voucher_item_id: string
          voucher_number: string
        }[]
      }
      mark_order_converted: {
        Args: { p_company_id: string; p_order_id: string; p_voucher_id: string }
        Returns: undefined
      }
      match_bank_line: {
        Args: { p_statement_line_id: string; p_voucher_entry_id: string }
        Returns: undefined
      }
      post_closing_stock: {
        Args: {
          p_as_at: string
          p_branch_id: string
          p_company_id: string
          p_narration?: string
        }
        Returns: string
      }
      post_depreciation: {
        Args: {
          p_as_at: string
          p_branch_id: string
          p_company_id: string
          p_narration?: string
        }
        Returns: string
      }
      post_payroll_run: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_period_month: string
        }
        Returns: string
      }
      record_forex_revaluation: {
        Args: {
          p_as_at: string
          p_branch_id: string
          p_closing_rate: number
          p_company_id: string
          p_narration?: string
          p_original_voucher_id: string
          p_rate_source?: string
        }
        Returns: string
      }
      record_forex_settlement: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_narration?: string
          p_original_voucher_id: string
          p_rate_source?: string
          p_settlement_date: string
          p_settlement_ledger_id: string
          p_settlement_rate: number
        }
        Returns: string
      }
      reopen_period: {
        Args: { p_company_id: string; p_new_lock_date?: string }
        Returns: undefined
      }
      resolve_statutory_rule: {
        Args: {
          p_as_at: string
          p_domain: string
          p_rule_key: string
          p_scope?: Json
        }
        Returns: {
          attrs: Json
          authority: string
          value: number
        }[]
      }
      revoke_api_key: {
        Args: { p_company_id: string; p_key_id: string }
        Returns: undefined
      }
      set_budget_lines: {
        Args: { p_budget_id: string; p_company_id: string; p_lines: Json }
        Returns: number
      }
      set_company_password: {
        Args: { p_company_id: string; p_password: string }
        Returns: undefined
      }
      set_entry_cost_centre: {
        Args: {
          p_company_id: string
          p_cost_centre_id?: string
          p_entry_ids: string[]
        }
        Returns: number
      }
      set_module: {
        Args: {
          p_company_id: string
          p_enabled: boolean
          p_from_date?: string
          p_module_code: string
        }
        Returns: undefined
      }
      unmatch_bank_line: {
        Args: { p_statement_line_id: string }
        Returns: undefined
      }
      update_invoice: {
        Args: {
          p_godown_id: string
          p_items: Json
          p_narration?: string
          p_party_ledger_id: string
          p_place_of_supply?: string
          p_reference_date?: string
          p_reference_number?: string
          p_trading_ledger_id: string
          p_voucher_date: string
          p_voucher_id: string
        }
        Returns: string
      }
      update_voucher: {
        Args: {
          p_lines: Json
          p_narration?: string
          p_party_ledger_id?: string
          p_reference_date?: string
          p_reference_number?: string
          p_voucher_date: string
          p_voucher_id: string
        }
        Returns: string
      }
      upsert_item_batch: {
        Args: {
          p_batch_no: string
          p_company_id: string
          p_expiry_date?: string
          p_item_id: string
          p_mfg_date?: string
          p_notes?: string
        }
        Returns: string
      }
      verify_company_password: {
        Args: { p_company_id: string; p_password: string }
        Returns: boolean
      }
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

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
