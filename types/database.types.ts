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
    PostgrestVersion: "14.17"
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
          external_txn_id: string
          id: string
          ledger_id: string
          matched_at: string | null
          matched_by: string | null
          matched_entry_id: string | null
          reference: string | null
          source_format: string
          txn_date: string
        }
        Insert: {
          company_id: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          description?: string | null
          external_txn_id: string
          id?: string
          ledger_id: string
          matched_at?: string | null
          matched_by?: string | null
          matched_entry_id?: string | null
          reference?: string | null
          source_format?: string
          txn_date: string
        }
        Update: {
          company_id?: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          description?: string | null
          external_txn_id?: string
          id?: string
          ledger_id?: string
          matched_at?: string | null
          matched_by?: string | null
          matched_entry_id?: string | null
          reference?: string | null
          source_format?: string
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
      bom_outputs: {
        Row: {
          bom_id: string
          company_id: string
          created_at: string
          id: string
          line_order: number
          nrv_rate: number
          output_item_id: string
          output_type: string
          quantity: number
          updated_at: string
        }
        Insert: {
          bom_id: string
          company_id: string
          created_at?: string
          id?: string
          line_order?: number
          nrv_rate?: number
          output_item_id: string
          output_type: string
          quantity: number
          updated_at?: string
        }
        Update: {
          bom_id?: string
          company_id?: string
          created_at?: string
          id?: string
          line_order?: number
          nrv_rate?: number
          output_item_id?: string
          output_type?: string
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bom_outputs_bom_id_company_id_fkey"
            columns: ["bom_id", "company_id"]
            isOneToOne: false
            referencedRelation: "bill_of_materials"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "bom_outputs_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "bill_of_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_outputs_output_item_id_company_id_fkey"
            columns: ["output_item_id", "company_id"]
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
          lwf_establishment_code: string | null
          name: string
          pincode: string | null
          pt_enrolment_number: string | null
          pt_registration_number: string | null
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
          lwf_establishment_code?: string | null
          name: string
          pincode?: string | null
          pt_enrolment_number?: string | null
          pt_registration_number?: string | null
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
          lwf_establishment_code?: string | null
          name?: string
          pincode?: string | null
          pt_enrolment_number?: string | null
          pt_registration_number?: string | null
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
      charges: {
        Row: {
          amount_secured: number
          assets_charged: string
          charge_holder_name: string
          charge_type: string
          chg1_filing_date: string | null
          chg1_srn: string | null
          chg4_filing_date: string | null
          chg4_srn: string | null
          company_id: string
          created_at: string
          created_by: string | null
          date_of_creation: string
          date_of_satisfaction: string | null
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          amount_secured: number
          assets_charged: string
          charge_holder_name: string
          charge_type: string
          chg1_filing_date?: string | null
          chg1_srn?: string | null
          chg4_filing_date?: string | null
          chg4_srn?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          date_of_creation: string
          date_of_satisfaction?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          amount_secured?: number
          assets_charged?: string
          charge_holder_name?: string
          charge_type?: string
          chg1_filing_date?: string | null
          chg1_srn?: string | null
          chg4_filing_date?: string | null
          chg4_srn?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          date_of_creation?: string
          date_of_satisfaction?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "charges_company_id_fkey"
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
          esi_employer_code: string | null
          financial_year_start_month: number
          id: string
          iec: string | null
          incorporation_date: string | null
          inventory_valuation_method: string
          is_active: boolean
          is_professional: boolean
          leave_accrual_days_per_month: number
          leave_carry_forward_cap_days: number
          legal_name: string | null
          lin: string | null
          lock_date: string | null
          logo_url: string | null
          name: string
          pan: string | null
          password_hash: string | null
          password_protected: boolean | null
          pf_establishment_code: string | null
          print_footer_note: string | null
          print_terms_and_conditions: string | null
          shops_establishment_reg: string | null
          stock_margin_percent: number
          tan: string | null
          udyam_category: string | null
          udyam_number: string | null
          updated_at: string
          upi_vpa: string | null
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
          esi_employer_code?: string | null
          financial_year_start_month?: number
          id?: string
          iec?: string | null
          incorporation_date?: string | null
          inventory_valuation_method?: string
          is_active?: boolean
          is_professional?: boolean
          leave_accrual_days_per_month?: number
          leave_carry_forward_cap_days?: number
          legal_name?: string | null
          lin?: string | null
          lock_date?: string | null
          logo_url?: string | null
          name: string
          pan?: string | null
          password_hash?: string | null
          password_protected?: boolean | null
          pf_establishment_code?: string | null
          print_footer_note?: string | null
          print_terms_and_conditions?: string | null
          shops_establishment_reg?: string | null
          stock_margin_percent?: number
          tan?: string | null
          udyam_category?: string | null
          udyam_number?: string | null
          updated_at?: string
          upi_vpa?: string | null
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
          esi_employer_code?: string | null
          financial_year_start_month?: number
          id?: string
          iec?: string | null
          incorporation_date?: string | null
          inventory_valuation_method?: string
          is_active?: boolean
          is_professional?: boolean
          leave_accrual_days_per_month?: number
          leave_carry_forward_cap_days?: number
          legal_name?: string | null
          lin?: string | null
          lock_date?: string | null
          logo_url?: string | null
          name?: string
          pan?: string | null
          password_hash?: string | null
          password_protected?: boolean | null
          pf_establishment_code?: string | null
          print_footer_note?: string | null
          print_terms_and_conditions?: string | null
          shops_establishment_reg?: string | null
          stock_margin_percent?: number
          tan?: string | null
          udyam_category?: string | null
          udyam_number?: string | null
          updated_at?: string
          upi_vpa?: string | null
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
      company_directors: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          date_of_appointment: string
          date_of_cessation: string | null
          designation: string
          din: string | null
          din_allotment_date: string | null
          id: string
          is_opc_nominee: boolean
          name: string
          pan: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          date_of_appointment: string
          date_of_cessation?: string | null
          designation: string
          din?: string | null
          din_allotment_date?: string | null
          id?: string
          is_opc_nominee?: boolean
          name: string
          pan?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          date_of_appointment?: string
          date_of_cessation?: string | null
          designation?: string
          din?: string | null
          din_allotment_date?: string | null
          id?: string
          is_opc_nominee?: boolean
          name?: string
          pan?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_directors_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
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
      contingent_liabilities: {
        Row: {
          amount: number
          category: string
          company_id: string
          created_at: string
          created_by: string | null
          description: string
          id: string
          raised_date: string
          related_ledger_id: string | null
          resolution_note: string | null
          resolved_date: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          category: string
          company_id: string
          created_at?: string
          created_by?: string | null
          description: string
          id?: string
          raised_date: string
          related_ledger_id?: string | null
          resolution_note?: string | null
          resolved_date?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          category?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          description?: string
          id?: string
          raised_date?: string
          related_ledger_id?: string | null
          resolution_note?: string | null
          resolved_date?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contingent_liabilities_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contingent_liabilities_related_ledger_id_company_id_fkey"
            columns: ["related_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
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
      delivery_challan_ewb_details: {
        Row: {
          approx_distance_km: number | null
          challan_id: string
          company_id: string
          created_at: string
          created_by: string | null
          ewb_generated_date: string | null
          ewb_number: string | null
          ewb_valid_until: string | null
          id: string
          status: string
          to_pincode: string | null
          to_state_code: string | null
          transport_doc_date: string | null
          transport_doc_number: string | null
          transport_mode: string
          transporter_id: string | null
          transporter_name: string | null
          updated_at: string
          vehicle_number: string | null
        }
        Insert: {
          approx_distance_km?: number | null
          challan_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          ewb_generated_date?: string | null
          ewb_number?: string | null
          ewb_valid_until?: string | null
          id?: string
          status?: string
          to_pincode?: string | null
          to_state_code?: string | null
          transport_doc_date?: string | null
          transport_doc_number?: string | null
          transport_mode?: string
          transporter_id?: string | null
          transporter_name?: string | null
          updated_at?: string
          vehicle_number?: string | null
        }
        Update: {
          approx_distance_km?: number | null
          challan_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          ewb_generated_date?: string | null
          ewb_number?: string | null
          ewb_valid_until?: string | null
          id?: string
          status?: string
          to_pincode?: string | null
          to_state_code?: string | null
          transport_doc_date?: string | null
          transport_doc_number?: string | null
          transport_mode?: string
          transporter_id?: string | null
          transporter_name?: string | null
          updated_at?: string
          vehicle_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_challan_ewb_details_challan_id_company_id_fkey"
            columns: ["challan_id", "company_id"]
            isOneToOne: false
            referencedRelation: "delivery_challans"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challan_ewb_details_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_challan_ewb_details_to_state_code_fkey"
            columns: ["to_state_code"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
      }
      delivery_challan_receipts: {
        Row: {
          challan_id: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          quantity_received: number
          received_date: string
        }
        Insert: {
          challan_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          quantity_received: number
          received_date: string
        }
        Update: {
          challan_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          quantity_received?: number
          received_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_challan_receipts_challan_id_company_id_fkey"
            columns: ["challan_id", "company_id"]
            isOneToOne: false
            referencedRelation: "delivery_challans"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challan_receipts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_challans: {
        Row: {
          branch_id: string
          challan_date: string
          company_id: string
          created_at: string
          created_by: string | null
          destination_branch_id: string | null
          gst_rate_percent: number | null
          id: string
          item_id: string
          party_address: string | null
          party_ledger_id: string | null
          party_name: string | null
          purpose: string
          quantity_sent: number
          rate: number
          reason_for_movement: string | null
          status: string
          transporter_name: string | null
          uom: string
          updated_at: string
          vehicle_number: string | null
          voucher_id: string
        }
        Insert: {
          branch_id: string
          challan_date: string
          company_id: string
          created_at?: string
          created_by?: string | null
          destination_branch_id?: string | null
          gst_rate_percent?: number | null
          id?: string
          item_id: string
          party_address?: string | null
          party_ledger_id?: string | null
          party_name?: string | null
          purpose: string
          quantity_sent: number
          rate?: number
          reason_for_movement?: string | null
          status?: string
          transporter_name?: string | null
          uom: string
          updated_at?: string
          vehicle_number?: string | null
          voucher_id: string
        }
        Update: {
          branch_id?: string
          challan_date?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          destination_branch_id?: string | null
          gst_rate_percent?: number | null
          id?: string
          item_id?: string
          party_address?: string | null
          party_ledger_id?: string | null
          party_name?: string | null
          purpose?: string
          quantity_sent?: number
          rate?: number
          reason_for_movement?: string | null
          status?: string
          transporter_name?: string | null
          uom?: string
          updated_at?: string
          vehicle_number?: string | null
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_challans_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challans_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_challans_destination_branch_id_company_id_fkey"
            columns: ["destination_branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challans_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challans_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "delivery_challans_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      digital_signature_certificates: {
        Row: {
          certifying_authority: string
          company_id: string
          created_at: string
          created_by: string | null
          dsc_class: string
          holder_director_id: string | null
          holder_name: string | null
          id: string
          notes: string | null
          token_serial_number: string | null
          updated_at: string
          valid_from: string
          valid_to: string
        }
        Insert: {
          certifying_authority: string
          company_id: string
          created_at?: string
          created_by?: string | null
          dsc_class?: string
          holder_director_id?: string | null
          holder_name?: string | null
          id?: string
          notes?: string | null
          token_serial_number?: string | null
          updated_at?: string
          valid_from: string
          valid_to: string
        }
        Update: {
          certifying_authority?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          dsc_class?: string
          holder_director_id?: string | null
          holder_name?: string | null
          id?: string
          notes?: string | null
          token_serial_number?: string | null
          updated_at?: string
          valid_from?: string
          valid_to?: string
        }
        Relationships: [
          {
            foreignKeyName: "digital_signature_certificate_holder_director_id_company_i_fkey"
            columns: ["holder_director_id", "company_id"]
            isOneToOne: false
            referencedRelation: "company_directors"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "digital_signature_certificates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      discount_agreement_links: {
        Row: {
          agreement_id: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          original_invoice_voucher_id: string | null
          voucher_id: string
          voucher_item_id: string | null
        }
        Insert: {
          agreement_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          original_invoice_voucher_id?: string | null
          voucher_id: string
          voucher_item_id?: string | null
        }
        Update: {
          agreement_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          original_invoice_voucher_id?: string | null
          voucher_id?: string
          voucher_item_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "discount_agreement_links_agreement_id_company_id_fkey"
            columns: ["agreement_id", "company_id"]
            isOneToOne: false
            referencedRelation: "discount_agreements"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "discount_agreement_links_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discount_agreement_links_original_invoice_voucher_id_compa_fkey"
            columns: ["original_invoice_voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "discount_agreement_links_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "discount_agreement_links_voucher_item_id_voucher_id_compan_fkey"
            columns: ["voucher_item_id", "voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "voucher_items"
            referencedColumns: ["id", "voucher_id", "company_id"]
          },
        ]
      }
      discount_agreements: {
        Row: {
          agreed_date: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          party_ledger_id: string
          standard_discount_percent: number | null
          terms: string
          updated_at: string
        }
        Insert: {
          agreed_date: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          party_ledger_id: string
          standard_discount_percent?: number | null
          terms: string
          updated_at?: string
        }
        Update: {
          agreed_date?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          party_ledger_id?: string
          standard_discount_percent?: number | null
          terms?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discount_agreements_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discount_agreements_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
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
      einvoice_details: {
        Row: {
          ack_date: string | null
          ack_number: string | null
          company_id: string
          created_at: string
          created_by: string | null
          generated_at: string | null
          generated_json: Json | null
          id: string
          irn: string | null
          signed_qr_payload: string | null
          status: string
          updated_at: string
          voucher_id: string
        }
        Insert: {
          ack_date?: string | null
          ack_number?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          generated_at?: string | null
          generated_json?: Json | null
          id?: string
          irn?: string | null
          signed_qr_payload?: string | null
          status?: string
          updated_at?: string
          voucher_id: string
        }
        Update: {
          ack_date?: string | null
          ack_number?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          generated_at?: string | null
          generated_json?: Json | null
          id?: string
          irn?: string | null
          signed_qr_payload?: string | null
          status?: string
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "einvoice_details_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "einvoice_details_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      employee_exit_settlements: {
        Row: {
          bonus_amount: number
          company_id: string
          employee_id: string
          exit_date: string
          exit_reason: string
          finalized_at: string
          finalized_by: string | null
          gratuity_amount: number
          gratuity_completed_years: number | null
          gratuity_eligible: boolean
          gratuity_ineligibility_reason: string | null
          gratuity_last_drawn_wage: number | null
          id: string
          leave_encashment_amount: number
          leave_encashment_days: number
          net_payable: number
          notes: string | null
          recoveries_amount: number
          unpaid_salary_amount: number
        }
        Insert: {
          bonus_amount?: number
          company_id: string
          employee_id: string
          exit_date: string
          exit_reason: string
          finalized_at?: string
          finalized_by?: string | null
          gratuity_amount?: number
          gratuity_completed_years?: number | null
          gratuity_eligible: boolean
          gratuity_ineligibility_reason?: string | null
          gratuity_last_drawn_wage?: number | null
          id?: string
          leave_encashment_amount?: number
          leave_encashment_days?: number
          net_payable: number
          notes?: string | null
          recoveries_amount?: number
          unpaid_salary_amount?: number
        }
        Update: {
          bonus_amount?: number
          company_id?: string
          employee_id?: string
          exit_date?: string
          exit_reason?: string
          finalized_at?: string
          finalized_by?: string | null
          gratuity_amount?: number
          gratuity_completed_years?: number | null
          gratuity_eligible?: boolean
          gratuity_ineligibility_reason?: string | null
          gratuity_last_drawn_wage?: number | null
          id?: string
          leave_encashment_amount?: number
          leave_encashment_days?: number
          net_payable?: number
          notes?: string | null
          recoveries_amount?: number
          unpaid_salary_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_exit_settlements_employee_id_company_id_fkey"
            columns: ["employee_id", "company_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      employee_leave_ledger: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          days: number
          employee_id: string
          entry_type: string
          id: string
          notes: string | null
          period_month: string | null
          transaction_date: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          days: number
          employee_id: string
          entry_type: string
          id?: string
          notes?: string | null
          period_month?: string | null
          transaction_date: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          days?: number
          employee_id?: string
          entry_type?: string
          id?: string
          notes?: string | null
          period_month?: string | null
          transaction_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_leave_ledger_employee_id_company_id_fkey"
            columns: ["employee_id", "company_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      employee_perquisites: {
        Row: {
          accommodation_ownership: string | null
          actual_running_maintenance_cost: number
          amount_recovered_from_employee: number
          car_actual_cost_or_hire_charges: number
          car_cc_class: string | null
          car_is_hired: boolean
          car_usage: string | null
          city_population_tier: string | null
          company_id: string
          created_at: string
          created_by: string | null
          driver_provided: boolean
          driver_salary_paid_by_employer: number
          employee_id: string
          financial_year_label: string
          id: string
          lease_rent_paid_by_employer: number
          months_applicable: number
          notes: string | null
          other_cost_to_employer: number
          other_perquisite_description: string | null
          perquisite_type: string
          running_cost_borne_by: string | null
          updated_at: string
        }
        Insert: {
          accommodation_ownership?: string | null
          actual_running_maintenance_cost?: number
          amount_recovered_from_employee?: number
          car_actual_cost_or_hire_charges?: number
          car_cc_class?: string | null
          car_is_hired?: boolean
          car_usage?: string | null
          city_population_tier?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          driver_provided?: boolean
          driver_salary_paid_by_employer?: number
          employee_id: string
          financial_year_label: string
          id?: string
          lease_rent_paid_by_employer?: number
          months_applicable?: number
          notes?: string | null
          other_cost_to_employer?: number
          other_perquisite_description?: string | null
          perquisite_type: string
          running_cost_borne_by?: string | null
          updated_at?: string
        }
        Update: {
          accommodation_ownership?: string | null
          actual_running_maintenance_cost?: number
          amount_recovered_from_employee?: number
          car_actual_cost_or_hire_charges?: number
          car_cc_class?: string | null
          car_is_hired?: boolean
          car_usage?: string | null
          city_population_tier?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          driver_provided?: boolean
          driver_salary_paid_by_employer?: number
          employee_id?: string
          financial_year_label?: string
          id?: string
          lease_rent_paid_by_employer?: number
          months_applicable?: number
          notes?: string | null
          other_cost_to_employer?: number
          other_perquisite_description?: string | null
          perquisite_type?: string
          running_cost_borne_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_perquisites_employee_id_company_id_fkey"
            columns: ["employee_id", "company_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id", "company_id"]
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
      employee_tax_declarations: {
        Row: {
          company_id: string
          created_at: string
          declaration_date: string
          deduction_80c: number
          deduction_80d: number
          employee_id: string
          financial_year_label: string
          home_loan_interest_24b: number
          hra_exemption_claimed: number
          id: string
          notes: string | null
          previous_employer_income: number
          previous_employer_tds_deducted: number
          regime: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          declaration_date: string
          deduction_80c?: number
          deduction_80d?: number
          employee_id: string
          financial_year_label: string
          home_loan_interest_24b?: number
          hra_exemption_claimed?: number
          id?: string
          notes?: string | null
          previous_employer_income?: number
          previous_employer_tds_deducted?: number
          regime: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          declaration_date?: string
          deduction_80c?: number
          deduction_80d?: number
          employee_id?: string
          financial_year_label?: string
          home_loan_interest_24b?: number
          hra_exemption_claimed?: number
          id?: string
          notes?: string | null
          previous_employer_income?: number
          previous_employer_tds_deducted?: number
          regime?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_tax_declarations_employee_id_company_id_fkey"
            columns: ["employee_id", "company_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      employees: {
        Row: {
          branch_id: string | null
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
          branch_id?: string | null
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
          branch_id?: string | null
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
            foreignKeyName: "employees_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "employees_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      ewb_details: {
        Row: {
          approx_distance_km: number | null
          company_id: string
          created_at: string
          created_by: string | null
          ewb_generated_date: string | null
          ewb_number: string | null
          ewb_valid_until: string | null
          id: string
          ship_to_address: string | null
          ship_to_gstin: string | null
          ship_to_name: string | null
          ship_to_pincode: string | null
          ship_to_state_code: string | null
          status: string
          transport_doc_date: string | null
          transport_doc_number: string | null
          transport_mode: string
          transporter_id: string | null
          transporter_name: string | null
          updated_at: string
          vehicle_number: string | null
          voucher_id: string
        }
        Insert: {
          approx_distance_km?: number | null
          company_id: string
          created_at?: string
          created_by?: string | null
          ewb_generated_date?: string | null
          ewb_number?: string | null
          ewb_valid_until?: string | null
          id?: string
          ship_to_address?: string | null
          ship_to_gstin?: string | null
          ship_to_name?: string | null
          ship_to_pincode?: string | null
          ship_to_state_code?: string | null
          status?: string
          transport_doc_date?: string | null
          transport_doc_number?: string | null
          transport_mode?: string
          transporter_id?: string | null
          transporter_name?: string | null
          updated_at?: string
          vehicle_number?: string | null
          voucher_id: string
        }
        Update: {
          approx_distance_km?: number | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          ewb_generated_date?: string | null
          ewb_number?: string | null
          ewb_valid_until?: string | null
          id?: string
          ship_to_address?: string | null
          ship_to_gstin?: string | null
          ship_to_name?: string | null
          ship_to_pincode?: string | null
          ship_to_state_code?: string | null
          status?: string
          transport_doc_date?: string | null
          transport_doc_number?: string | null
          transport_mode?: string
          transporter_id?: string | null
          transporter_name?: string | null
          updated_at?: string
          vehicle_number?: string | null
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ewb_details_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ewb_details_ship_to_state_code_fkey"
            columns: ["ship_to_state_code"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "ewb_details_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      ewb_vehicle_updates: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          ewb_detail_id: string
          id: string
          reason: string | null
          reason_code: string | null
          updated_at: string
          vehicle_number: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          ewb_detail_id: string
          id?: string
          reason?: string | null
          reason_code?: string | null
          updated_at?: string
          vehicle_number: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          ewb_detail_id?: string
          id?: string
          reason?: string | null
          reason_code?: string | null
          updated_at?: string
          vehicle_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "ewb_vehicle_updates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ewb_vehicle_updates_ewb_detail_id_company_id_fkey"
            columns: ["ewb_detail_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ewb_details"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      exim_shipment_details: {
        Row: {
          brc_date: string | null
          brc_number: string | null
          company_id: string
          created_at: string
          created_by: string | null
          document_date: string
          document_number: string
          document_type: string
          export_realisation_due_date: string | null
          id: string
          port_code: string
          realised_date: string | null
          updated_at: string
          voucher_id: string
        }
        Insert: {
          brc_date?: string | null
          brc_number?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          document_date: string
          document_number: string
          document_type: string
          export_realisation_due_date?: string | null
          id?: string
          port_code: string
          realised_date?: string | null
          updated_at?: string
          voucher_id: string
        }
        Update: {
          brc_date?: string | null
          brc_number?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          document_date?: string
          document_number?: string
          document_type?: string
          export_realisation_due_date?: string | null
          id?: string
          port_code?: string
          realised_date?: string | null
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exim_shipment_details_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exim_shipment_details_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      filing_register: {
        Row: {
          acknowledgement_number: string | null
          additional_fee: number
          company_id: string
          created_at: string
          created_by: string | null
          fee_paid: number
          filed_date: string | null
          form_code: string
          gst_registration_id: string | null
          id: string
          notes: string | null
          period_label: string
          status: string
          updated_at: string
        }
        Insert: {
          acknowledgement_number?: string | null
          additional_fee?: number
          company_id: string
          created_at?: string
          created_by?: string | null
          fee_paid?: number
          filed_date?: string | null
          form_code: string
          gst_registration_id?: string | null
          id?: string
          notes?: string | null
          period_label: string
          status?: string
          updated_at?: string
        }
        Update: {
          acknowledgement_number?: string | null
          additional_fee?: number
          company_id?: string
          created_at?: string
          created_by?: string | null
          fee_paid?: number
          filed_date?: string | null
          form_code?: string
          gst_registration_id?: string | null
          id?: string
          notes?: string | null
          period_label?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "filing_register_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "filing_register_gst_registration_id_company_id_fkey"
            columns: ["gst_registration_id", "company_id"]
            isOneToOne: false
            referencedRelation: "gst_registrations"
            referencedColumns: ["id", "company_id"]
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
          lut_arn: string | null
          lut_number: string | null
          lut_valid_from: string | null
          lut_valid_to: string | null
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
          lut_arn?: string | null
          lut_number?: string | null
          lut_valid_from?: string | null
          lut_valid_to?: string | null
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
          lut_arn?: string | null
          lut_number?: string | null
          lut_valid_from?: string | null
          lut_valid_to?: string | null
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
      gst_tds_tcs_suffered: {
        Row: {
          cgst_amount: number
          claimed_in_gstr3b: boolean
          company_id: string
          created_at: string
          created_by: string | null
          deductor_or_operator_gstin: string
          deductor_or_operator_name: string
          financial_year_label: string
          gst_registration_id: string
          id: string
          igst_amount: number
          notes: string | null
          period_label: string
          sgst_amount: number
          source_type: string
          taxable_value: number
          updated_at: string
        }
        Insert: {
          cgst_amount?: number
          claimed_in_gstr3b?: boolean
          company_id: string
          created_at?: string
          created_by?: string | null
          deductor_or_operator_gstin: string
          deductor_or_operator_name: string
          financial_year_label: string
          gst_registration_id: string
          id?: string
          igst_amount?: number
          notes?: string | null
          period_label: string
          sgst_amount?: number
          source_type: string
          taxable_value?: number
          updated_at?: string
        }
        Update: {
          cgst_amount?: number
          claimed_in_gstr3b?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          deductor_or_operator_gstin?: string
          deductor_or_operator_name?: string
          financial_year_label?: string
          gst_registration_id?: string
          id?: string
          igst_amount?: number
          notes?: string | null
          period_label?: string
          sgst_amount?: number
          source_type?: string
          taxable_value?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gst_tds_tcs_suffered_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gst_tds_tcs_suffered_gst_registration_id_company_id_fkey"
            columns: ["gst_registration_id", "company_id"]
            isOneToOne: false
            referencedRelation: "gst_registrations"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      gstr2b_lines: {
        Row: {
          cess: number
          cgst: number
          company_id: string
          created_at: string
          document_type: string
          gst_registration_id: string
          gstr2b_table: string | null
          id: string
          igst: number
          invoice_date: string
          invoice_number: string
          invoice_number_normalized: string | null
          invoice_value: number
          itc_availability: string
          itc_reason: string | null
          return_period: string
          sgst: number
          supplier_gstin: string
          supplier_name: string | null
          taxable_value: number
          uploaded_by: string | null
        }
        Insert: {
          cess?: number
          cgst?: number
          company_id: string
          created_at?: string
          document_type: string
          gst_registration_id: string
          gstr2b_table?: string | null
          id?: string
          igst?: number
          invoice_date: string
          invoice_number: string
          invoice_number_normalized?: string | null
          invoice_value?: number
          itc_availability: string
          itc_reason?: string | null
          return_period: string
          sgst?: number
          supplier_gstin: string
          supplier_name?: string | null
          taxable_value?: number
          uploaded_by?: string | null
        }
        Update: {
          cess?: number
          cgst?: number
          company_id?: string
          created_at?: string
          document_type?: string
          gst_registration_id?: string
          gstr2b_table?: string | null
          id?: string
          igst?: number
          invoice_date?: string
          invoice_number?: string
          invoice_number_normalized?: string | null
          invoice_value?: number
          itc_availability?: string
          itc_reason?: string | null
          return_period?: string
          sgst?: number
          supplier_gstin?: string
          supplier_name?: string | null
          taxable_value?: number
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gstr2b_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gstr2b_lines_gst_registration_id_company_id_fkey"
            columns: ["gst_registration_id", "company_id"]
            isOneToOne: false
            referencedRelation: "gst_registrations"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      income_tax_statement_lines: {
        Row: {
          amount_paid_credited: number
          company_id: string
          created_at: string
          deductor_name: string | null
          deductor_tan: string | null
          deductor_tan_normalized: string | null
          financial_year_label: string
          id: string
          information_category: string | null
          section_code: string | null
          source: string
          status_of_booking: string | null
          tax_deducted: number
          tax_deposited: number
          transaction_date: string | null
          transaction_type: string
          uploaded_by: string | null
        }
        Insert: {
          amount_paid_credited?: number
          company_id: string
          created_at?: string
          deductor_name?: string | null
          deductor_tan?: string | null
          deductor_tan_normalized?: string | null
          financial_year_label: string
          id?: string
          information_category?: string | null
          section_code?: string | null
          source: string
          status_of_booking?: string | null
          tax_deducted?: number
          tax_deposited?: number
          transaction_date?: string | null
          transaction_type?: string
          uploaded_by?: string | null
        }
        Update: {
          amount_paid_credited?: number
          company_id?: string
          created_at?: string
          deductor_name?: string | null
          deductor_tan?: string | null
          deductor_tan_normalized?: string | null
          financial_year_label?: string
          id?: string
          information_category?: string | null
          section_code?: string | null
          source?: string
          status_of_booking?: string | null
          tax_deducted?: number
          tax_deposited?: number
          transaction_date?: string | null
          transaction_type?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "income_tax_statement_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
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
      item_uom_conversions: {
        Row: {
          alternate_uom: string
          company_id: string
          conversion_factor: number
          created_at: string
          created_by: string | null
          id: string
          is_purchase_uom: boolean
          is_sales_uom: boolean
          item_id: string
          updated_at: string
        }
        Insert: {
          alternate_uom: string
          company_id: string
          conversion_factor: number
          created_at?: string
          created_by?: string | null
          id?: string
          is_purchase_uom?: boolean
          is_sales_uom?: boolean
          item_id: string
          updated_at?: string
        }
        Update: {
          alternate_uom?: string
          company_id?: string
          conversion_factor?: number
          created_at?: string
          created_by?: string | null
          id?: string
          is_purchase_uom?: boolean
          is_sales_uom?: boolean
          item_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_uom_conversions_alternate_uom_fkey"
            columns: ["alternate_uom"]
            isOneToOne: false
            referencedRelation: "ref_uom"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "item_uom_conversions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_uom_conversions_item_company_fkey"
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
          is_rcm_applicable: boolean
          itc_blocked_clause: string | null
          itc_eligibility: string
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
          is_rcm_applicable?: boolean
          itc_blocked_clause?: string | null
          itc_eligibility?: string
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
          is_rcm_applicable?: boolean
          itc_blocked_clause?: string | null
          itc_eligibility?: string
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
          ledger_role: string | null
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
          relationship_type: string | null
          sec43b_category: string | null
          state_code: string | null
          tan: string | null
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
          ledger_role?: string | null
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
          relationship_type?: string | null
          sec43b_category?: string | null
          state_code?: string | null
          tan?: string | null
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
          ledger_role?: string | null
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
          relationship_type?: string | null
          sec43b_category?: string | null
          state_code?: string | null
          tan?: string | null
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
      llp_partner_contributions: {
        Row: {
          amount: number
          company_id: string
          contribution_date: string
          contribution_type: string
          created_at: string
          created_by: string | null
          director_id: string
          id: string
          notes: string | null
          valuation_certificate_reference: string | null
        }
        Insert: {
          amount: number
          company_id: string
          contribution_date: string
          contribution_type: string
          created_at?: string
          created_by?: string | null
          director_id: string
          id?: string
          notes?: string | null
          valuation_certificate_reference?: string | null
        }
        Update: {
          amount?: number
          company_id?: string
          contribution_date?: string
          contribution_type?: string
          created_at?: string
          created_by?: string | null
          director_id?: string
          id?: string
          notes?: string | null
          valuation_certificate_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "llp_partner_contributions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llp_partner_contributions_director_company_fkey"
            columns: ["director_id", "company_id"]
            isOneToOne: false
            referencedRelation: "company_directors"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      meetings: {
        Row: {
          agenda: string
          company_id: string
          created_at: string
          created_by: string | null
          financial_year_start_year: number | null
          id: string
          meeting_date: string
          meeting_type: string
          minutes_signed_date: string | null
          notice_date: string | null
          updated_at: string
        }
        Insert: {
          agenda: string
          company_id: string
          created_at?: string
          created_by?: string | null
          financial_year_start_year?: number | null
          id?: string
          meeting_date: string
          meeting_type: string
          minutes_signed_date?: string | null
          notice_date?: string | null
          updated_at?: string
        }
        Update: {
          agenda?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          financial_year_start_year?: number | null
          id?: string
          meeting_date?: string
          meeting_type?: string
          minutes_signed_date?: string | null
          notice_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
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
          contingent_amount: number | null
          created_at: string
          created_by: string | null
          description: string
          due_date: string | null
          id: string
          is_disclosed_as_contingent: boolean
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
          contingent_amount?: number | null
          created_at?: string
          created_by?: string | null
          description: string
          due_date?: string | null
          id?: string
          is_disclosed_as_contingent?: boolean
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
          contingent_amount?: number | null
          created_at?: string
          created_by?: string | null
          description?: string
          due_date?: string | null
          id?: string
          is_disclosed_as_contingent?: boolean
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
      notifications: {
        Row: {
          body_summary: string
          category: string
          channel: string
          company_id: string
          created_at: string
          id: string
          recipient_user_id: string | null
          related_entity_id: string | null
          related_entity_type: string | null
          sent_at: string | null
          status: string
          subject: string
        }
        Insert: {
          body_summary: string
          category: string
          channel?: string
          company_id: string
          created_at?: string
          id?: string
          recipient_user_id?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          sent_at?: string | null
          status?: string
          subject: string
        }
        Update: {
          body_summary?: string
          category?: string
          channel?: string
          company_id?: string
          created_at?: string
          id?: string
          recipient_user_id?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          sent_at?: string | null
          status?: string
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_company_id_fkey"
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
      price_list_items: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          effective_from: string
          id: string
          item_id: string
          price: number
          price_list_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          item_id: string
          price: number
          price_list_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          item_id?: string
          price?: number
          price_list_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_list_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_list_items_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "price_list_items_price_list_id_company_id_fkey"
            columns: ["price_list_id", "company_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      price_lists: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_lists_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
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
      recurring_voucher_generation_log: {
        Row: {
          company_id: string
          generated_at: string
          generated_by: string | null
          id: string
          run_date: string
          template_id: string
          voucher_id: string | null
        }
        Insert: {
          company_id: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          run_date: string
          template_id: string
          voucher_id?: string | null
        }
        Update: {
          company_id?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          run_date?: string
          template_id?: string
          voucher_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recurring_voucher_generation_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_voucher_generation_log_template_id_company_id_fkey"
            columns: ["template_id", "company_id"]
            isOneToOne: false
            referencedRelation: "recurring_voucher_templates"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "recurring_voucher_generation_log_voucher_id_fkey"
            columns: ["voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_voucher_template_lines: {
        Row: {
          company_id: string
          credit_amount: number
          debit_amount: number
          id: string
          ledger_id: string
          line_order: number
          narration: string | null
          template_id: string
        }
        Insert: {
          company_id: string
          credit_amount?: number
          debit_amount?: number
          id?: string
          ledger_id: string
          line_order?: number
          narration?: string | null
          template_id: string
        }
        Update: {
          company_id?: string
          credit_amount?: number
          debit_amount?: number
          id?: string
          ledger_id?: string
          line_order?: number
          narration?: string | null
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_voucher_template_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_voucher_template_lines_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "recurring_voucher_template_lines_template_id_company_id_fkey"
            columns: ["template_id", "company_id"]
            isOneToOne: false
            referencedRelation: "recurring_voucher_templates"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      recurring_voucher_templates: {
        Row: {
          branch_id: string
          company_id: string
          created_at: string
          created_by: string | null
          day_of_month: number
          end_date: string | null
          frequency: string
          id: string
          is_active: boolean
          narration_template: string | null
          next_run_date: string
          party_ledger_id: string | null
          start_date: string
          template_name: string
          updated_at: string
          updated_by: string | null
          voucher_type: string
        }
        Insert: {
          branch_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          day_of_month: number
          end_date?: string | null
          frequency: string
          id?: string
          is_active?: boolean
          narration_template?: string | null
          next_run_date: string
          party_ledger_id?: string | null
          start_date: string
          template_name: string
          updated_at?: string
          updated_by?: string | null
          voucher_type: string
        }
        Update: {
          branch_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          day_of_month?: number
          end_date?: string | null
          frequency?: string
          id?: string
          is_active?: boolean
          narration_template?: string | null
          next_run_date?: string
          party_ledger_id?: string | null
          start_date?: string
          template_name?: string
          updated_at?: string
          updated_by?: string | null
          voucher_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_voucher_templates_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "recurring_voucher_templates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_voucher_templates_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
        ]
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
      ref_income_tax_slabs_old_regime: {
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
      ref_state_ewb_thresholds: {
        Row: {
          effective_from: string | null
          intra_state_threshold_amount: number
          notes: string | null
          source_reference: string
          state_code: string
        }
        Insert: {
          effective_from?: string | null
          intra_state_threshold_amount: number
          notes?: string | null
          source_reference: string
          state_code: string
        }
        Update: {
          effective_from?: string | null
          intra_state_threshold_amount?: number
          notes?: string | null
          source_reference?: string
          state_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "ref_state_ewb_thresholds_state_code_fkey"
            columns: ["state_code"]
            isOneToOne: true
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
        ]
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
      sec186_investments: {
        Row: {
          amount: number
          board_resolution_date: string
          company_id: string
          created_at: string
          created_by: string | null
          date: string
          id: string
          purpose: string
          recipient_entity_name: string
          shareholder_resolution_date: string | null
          transaction_type: string
          updated_at: string
        }
        Insert: {
          amount: number
          board_resolution_date: string
          company_id: string
          created_at?: string
          created_by?: string | null
          date: string
          id?: string
          purpose: string
          recipient_entity_name: string
          shareholder_resolution_date?: string | null
          transaction_type: string
          updated_at?: string
        }
        Update: {
          amount?: number
          board_resolution_date?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          date?: string
          id?: string
          purpose?: string
          recipient_entity_name?: string
          shareholder_resolution_date?: string | null
          transaction_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sec186_investments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      service_advance_receipts: {
        Row: {
          adjusted_at: string | null
          adjusted_note: string | null
          adjusted_voucher_id: string | null
          advance_amount: number
          cess_rate_percent: number
          company_id: string
          created_at: string
          created_by: string | null
          gst_rate_percent: number
          id: string
          notes: string | null
          party_ledger_id: string
          place_of_supply: string
          rate_not_determinable: boolean
          status: string
          updated_at: string
          voucher_id: string
        }
        Insert: {
          adjusted_at?: string | null
          adjusted_note?: string | null
          adjusted_voucher_id?: string | null
          advance_amount: number
          cess_rate_percent?: number
          company_id: string
          created_at?: string
          created_by?: string | null
          gst_rate_percent: number
          id?: string
          notes?: string | null
          party_ledger_id: string
          place_of_supply: string
          rate_not_determinable?: boolean
          status?: string
          updated_at?: string
          voucher_id: string
        }
        Update: {
          adjusted_at?: string | null
          adjusted_note?: string | null
          adjusted_voucher_id?: string | null
          advance_amount?: number
          cess_rate_percent?: number
          company_id?: string
          created_at?: string
          created_by?: string | null
          gst_rate_percent?: number
          id?: string
          notes?: string | null
          party_ledger_id?: string
          place_of_supply?: string
          rate_not_determinable?: boolean
          status?: string
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_advance_receipts_adjusted_voucher_id_company_id_fkey"
            columns: ["adjusted_voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "service_advance_receipts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_advance_receipts_party_ledger_id_company_id_fkey"
            columns: ["party_ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "service_advance_receipts_place_of_supply_fkey"
            columns: ["place_of_supply"]
            isOneToOne: false
            referencedRelation: "ref_states"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "service_advance_receipts_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      share_classes: {
        Row: {
          authorized_shares: number
          class_name: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          nominal_value_per_share: number
          updated_at: string
        }
        Insert: {
          authorized_shares: number
          class_name: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          nominal_value_per_share: number
          updated_at?: string
        }
        Update: {
          authorized_shares?: number
          class_name?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          nominal_value_per_share?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "share_classes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      share_holdings: {
        Row: {
          company_id: string
          consideration: string | null
          created_at: string
          created_by: string | null
          date_of_allotment: string
          date_of_cessation: string | null
          folio_number: string | null
          holder_address: string | null
          holder_name: string
          holder_occupation: string | null
          holder_pan: string | null
          id: string
          share_class_id: string
          shares_held: number
          updated_at: string
        }
        Insert: {
          company_id: string
          consideration?: string | null
          created_at?: string
          created_by?: string | null
          date_of_allotment: string
          date_of_cessation?: string | null
          folio_number?: string | null
          holder_address?: string | null
          holder_name: string
          holder_occupation?: string | null
          holder_pan?: string | null
          id?: string
          share_class_id: string
          shares_held: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          consideration?: string | null
          created_at?: string
          created_by?: string | null
          date_of_allotment?: string
          date_of_cessation?: string | null
          folio_number?: string | null
          holder_address?: string | null
          holder_name?: string
          holder_occupation?: string | null
          holder_pan?: string | null
          id?: string
          share_class_id?: string
          shares_held?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "share_holdings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "share_holdings_share_class_id_company_id_fkey"
            columns: ["share_class_id", "company_id"]
            isOneToOne: false
            referencedRelation: "share_classes"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      signature_request_signers: {
        Row: {
          access_token: string | null
          company_id: string
          created_at: string
          decline_reason: string | null
          has_embedded_signature: boolean | null
          id: string
          request_id: string
          sign_order: number
          signature_check_note: string | null
          signed_at: string | null
          signed_document_id: string | null
          signer_email: string
          signer_name: string
          status: string
          token_last_used_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          company_id: string
          created_at?: string
          decline_reason?: string | null
          has_embedded_signature?: boolean | null
          id?: string
          request_id: string
          sign_order: number
          signature_check_note?: string | null
          signed_at?: string | null
          signed_document_id?: string | null
          signer_email: string
          signer_name: string
          status?: string
          token_last_used_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          company_id?: string
          created_at?: string
          decline_reason?: string | null
          has_embedded_signature?: boolean | null
          id?: string
          request_id?: string
          sign_order?: number
          signature_check_note?: string | null
          signed_at?: string | null
          signed_document_id?: string | null
          signer_email?: string
          signer_name?: string
          status?: string
          token_last_used_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signature_request_signers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_request_signers_request_id_company_id_fkey"
            columns: ["request_id", "company_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "signature_request_signers_signed_document_id_company_id_fkey"
            columns: ["signed_document_id", "company_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      signature_requests: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "signature_requests_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      significant_beneficial_owners: {
        Row: {
          ben1_received_date: string | null
          ben2_filed_date: string | null
          company_id: string
          created_at: string
          created_by: string | null
          date_became_sbo: string
          date_ceased_sbo: string | null
          held_through_entity_name: string | null
          held_through_entity_type: string | null
          id: string
          individual_name: string
          interest_nature: string
          notes: string | null
          pan: string | null
          percentage_held: number | null
          qualifying_basis: string[]
          updated_at: string
        }
        Insert: {
          ben1_received_date?: string | null
          ben2_filed_date?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          date_became_sbo: string
          date_ceased_sbo?: string | null
          held_through_entity_name?: string | null
          held_through_entity_type?: string | null
          id?: string
          individual_name: string
          interest_nature: string
          notes?: string | null
          pan?: string | null
          percentage_held?: number | null
          qualifying_basis?: string[]
          updated_at?: string
        }
        Update: {
          ben1_received_date?: string | null
          ben2_filed_date?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          date_became_sbo?: string
          date_ceased_sbo?: string | null
          held_through_entity_name?: string | null
          held_through_entity_type?: string | null
          id?: string
          individual_name?: string
          interest_nature?: string
          notes?: string | null
          pan?: string | null
          percentage_held?: number | null
          qualifying_basis?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "significant_beneficial_owners_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
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
      stock_verifications: {
        Row: {
          adjustment_voucher_id: string | null
          average_rate: number
          batch_id: string | null
          book_quantity: number
          branch_id: string
          company_id: string
          created_at: string
          created_by: string | null
          godown_id: string
          id: string
          item_id: string
          notes: string | null
          physical_quantity: number
          updated_at: string
          variance_quantity: number
          variance_value: number
          verification_date: string
        }
        Insert: {
          adjustment_voucher_id?: string | null
          average_rate?: number
          batch_id?: string | null
          book_quantity: number
          branch_id: string
          company_id: string
          created_at?: string
          created_by?: string | null
          godown_id: string
          id?: string
          item_id: string
          notes?: string | null
          physical_quantity: number
          updated_at?: string
          variance_quantity?: number
          variance_value?: number
          verification_date: string
        }
        Update: {
          adjustment_voucher_id?: string | null
          average_rate?: number
          batch_id?: string | null
          book_quantity?: number
          branch_id?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          godown_id?: string
          id?: string
          item_id?: string
          notes?: string | null
          physical_quantity?: number
          updated_at?: string
          variance_quantity?: number
          variance_value?: number
          verification_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_verifications_adjustment_voucher_id_company_id_fkey"
            columns: ["adjustment_voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "stock_verifications_batch_id_company_id_fkey"
            columns: ["batch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "item_batches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "stock_verifications_branch_id_company_id_fkey"
            columns: ["branch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "stock_verifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_verifications_godown_id_company_id_fkey"
            columns: ["godown_id", "company_id"]
            isOneToOne: false
            referencedRelation: "godowns"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "stock_verifications_item_id_company_id_fkey"
            columns: ["item_id", "company_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id", "company_id"]
          },
        ]
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
          period_end: string | null
          period_start: string | null
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
          period_end?: string | null
          period_start?: string | null
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
          period_end?: string | null
          period_start?: string | null
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
          amount_before_discount: number | null
          branch_id: string
          company_id: string
          created_at: string
          description: string | null
          direction: string
          discount_amount: number | null
          discount_percent: number
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
          amount_before_discount?: number | null
          branch_id: string
          company_id: string
          created_at?: string
          description?: string | null
          direction: string
          discount_amount?: number | null
          discount_percent?: number
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
          amount_before_discount?: number | null
          branch_id?: string
          company_id?: string
          created_at?: string
          description?: string | null
          direction?: string
          discount_amount?: number | null
          discount_percent?: number
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
      accept_company_invite: {
        Args: { p_token: string }
        Returns: {
          company_id: string
          company_name: string
          role: string
        }[]
      }
      accrue_leave_for_month: {
        Args: { p_company_id: string; p_period_month: string }
        Returns: {
          accrual_days_accrued: number
          accrual_employee_id: string
        }[]
      }
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
      build_delivery_challan_ewb_json: {
        Args: { p_challan_id: string }
        Returns: Json
      }
      build_einvoice_json: { Args: { p_voucher_id: string }; Returns: Json }
      build_ewb_json: { Args: { p_voucher_id: string }; Returns: Json }
      cancel_signature_request: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      close_period: {
        Args: { p_company_id: string; p_lock_date: string }
        Returns: undefined
      }
      convert_quantity: {
        Args: {
          p_from_uom: string
          p_item_id: string
          p_quantity: number
          p_to_uom: string
        }
        Returns: number
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
      create_company_invite: {
        Args: { p_company_id: string; p_email: string; p_role: string }
        Returns: string
      }
      create_delivery_challan: {
        Args: {
          p_branch_id: string
          p_challan_date: string
          p_company_id: string
          p_destination_branch_id?: string
          p_godown_id: string
          p_gst_rate_percent?: number
          p_item_id: string
          p_narration?: string
          p_party_address?: string
          p_party_ledger_id?: string
          p_party_name?: string
          p_place_of_supply?: string
          p_purpose: string
          p_quantity: number
          p_rate: number
          p_reason_for_movement?: string
          p_transporter_name?: string
          p_uom: string
          p_vehicle_number?: string
        }
        Returns: string
      }
      create_delivery_challan_receipt: {
        Args: {
          p_challan_id: string
          p_company_id: string
          p_notes?: string
          p_quantity_received: number
          p_received_date: string
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
      create_notifications_from_needs_attention: {
        Args: { p_company_id: string }
        Returns: number
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
      create_recurring_voucher_template: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_day_of_month: number
          p_end_date?: string
          p_frequency: string
          p_lines: Json
          p_narration_template?: string
          p_party_ledger_id?: string
          p_start_date: string
          p_template_name: string
          p_voucher_type: string
        }
        Returns: string
      }
      create_service_advance_receipt: {
        Args: {
          p_advance_amount: number
          p_cess_rate_percent?: number
          p_company_id: string
          p_gst_rate_percent: number
          p_notes?: string
          p_place_of_supply: string
          p_rate_not_determinable?: boolean
          p_voucher_id: string
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
      decline_signer: {
        Args: { p_reason?: string; p_request_id: string; p_signer_id: string }
        Returns: undefined
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
      ensure_delivery_challan_movement_ledger: {
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
      ensure_stock_verification_adjustment_ledger: {
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
      generate_due_recurring_vouchers: {
        Args: {
          p_as_of?: string
          p_company_id: string
          p_template_ids?: string[]
        }
        Returns: {
          run_date: string
          status: string
          template_id: string
          template_name: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_234e_late_fee: {
        Args: {
          p_actual_or_hypothetical_filing_date: string
          p_company_id: string
          p_financial_year_label: string
          p_quarter: number
        }
        Returns: {
          cap_applied: boolean
          days_late: number
          due_date: string
          fee_after_cap: number
          fee_before_cap: number
          filing_date: string
          note: string
          quarter_end: string
          quarter_label: string
          quarter_start: string
          tds_deductible_for_quarter: number
        }[]
      }
      get_advance_tax_status: {
        Args: { p_as_of_date?: string; p_company_id: string; p_fy_end: string }
        Returns: {
          advance_tax_liability_estimate: number
          applicable: boolean
          as_of_date: string
          cumulative_amount_paid: number
          cumulative_amount_required: number
          cumulative_percent_required: number
          due_date: string
          entity_type: string
          instalment_label: string
          instalment_no: number
          is_due: boolean
          liability_estimate_basis: string
          notes: string
          row_kind: string
          safe_harbour_percent: number
          sec208_applicable: boolean
          sec234b_interest: number
          sec234b_months: number
          sec234b_shortfall: number
          sec234c_interest: number
          sec234c_note: string
          shortfall_amount: number
          total_advance_tax_paid_for_year: number
          total_interest: number
        }[]
      }
      get_ageing_schedule: {
        Args: { p_as_at?: string; p_company_id: string; p_party_type?: string }
        Returns: {
          amount: number
          bucket_label: string
          bucket_order: number
          segment: string
        }[]
      }
      get_agm_status: {
        Args: { p_company_id: string }
        Returns: {
          agm_recorded: boolean
          applicable: boolean
          days_remaining: number
          deadline_date: string
          financial_year_start_year: number
          fy_end_date: string
          fy_label: string
          is_first_agm: boolean
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
          ledger_role: string
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
      get_cash_flow_statement: {
        Args: {
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          amount: number
          label: string
          line_item: string
          section: string
          step: number
        }[]
      }
      get_charges_summary: {
        Args: { p_company_id: string }
        Returns: {
          chg1_not_yet_filed_count: number
          chg1_overdue_count: number
          chg4_not_yet_filed_count: number
          chg4_overdue_count: number
          live_charge_count: number
          satisfied_charge_count: number
          total_amount_secured_live: number
          total_amount_secured_satisfied: number
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
      get_common_credit_apportionment: {
        Args: {
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          blocked_itc: number
          common_credit: number
          common_credit_cess: number
          common_credit_cgst: number
          common_credit_igst: number
          common_credit_sgst: number
          d1_reversal: number
          d2_reversal: number
          eligible_itc: number
          exempt_linked_itc: number
          exempt_turnover: number
          exempt_turnover_ratio: number
          net_common_credit_retained: number
          reversal_cess: number
          reversal_cgst: number
          reversal_igst: number
          reversal_sgst: number
          total_input_tax: number
          total_reversal: number
          total_turnover: number
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
      get_company_team: {
        Args: { p_company_id: string }
        Returns: {
          email: string
          full_name: string
          member_id: string
          member_since: string
          role: string
          status: string
          user_id: string
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
      get_contingent_liabilities_note: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          amount: number
          category: string
          description: string
          raised_date: string
          reference: string
          source: string
          status: string
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
      get_deferred_tax_reconciliation: {
        Args: { p_company_id: string; p_fy_end: string }
        Returns: {
          applicable: boolean
          cumulative_book_depreciation: number
          cumulative_tax_depreciation: number
          cumulative_timing_difference: number
          effective_tax_rate: number
          entity_type: string
          fy_end: string
          fy_start: string
          ledger_carried: number
          movement_to_post: number
          note: string
          target_deferred_tax_liability: number
        }[]
      }
      get_delivery_challan_ewb_requirement: {
        Args: { p_challan_id: string }
        Returns: {
          challan_id: string
          consignment_value: number
          is_ewb_required: boolean
          taxable_value: number
          threshold_amount: number
          total_gst_tax: number
        }[]
      }
      get_delivery_challan_ewb_status: {
        Args: { p_company_id: string }
        Returns: {
          challan_date: string
          challan_id: string
          challan_number: string
          consignment_value: number
          ewb_generated_date: string
          ewb_id: string
          ewb_number: string
          ewb_valid_until: string
          is_ewb_required: boolean
          party_display: string
          purpose: string
          status: string
          transport_mode: string
          vehicle_number: string
        }[]
      }
      get_delivery_challans: {
        Args: { p_company_id: string; p_status_filter?: string }
        Returns: {
          cgst_amount: number
          challan_date: string
          challan_id: string
          challan_number: string
          gst_rate_percent: number
          hsn_sac: string
          igst_amount: number
          item_id: string
          item_name: string
          party_display: string
          purpose: string
          quantity_outstanding: number
          quantity_received: number
          quantity_sent: number
          rate: number
          reason_for_movement: string
          sgst_amount: number
          status: string
          supply_type: string
          tax_amount: number
          taxable_value: number
          transporter_name: string
          uom: string
          vehicle_number: string
        }[]
      }
      get_discount_agreement_coverage: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          agreement_agreed_date: string
          agreement_id: string
          agreement_is_active: boolean
          agreement_terms: string
          amount_before_discount: number
          backed_reason: string
          discount_amount: number
          discount_percent: number
          is_backed: boolean
          item_description: string
          net_amount: number
          original_invoice_date: string
          original_invoice_number: string
          original_invoice_voucher_id: string
          party_ledger_id: string
          party_name: string
          row_scope: string
          voucher_date: string
          voucher_id: string
          voucher_item_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_dpt3_return_content: {
        Args: { p_company_id: string; p_fy_end: string }
        Returns: {
          category: string
          caveat: string
          ledger_id: string
          ledger_name: string
          match_basis: string
          matched_director_id: string
          matched_director_name: string
          outstanding_amount: number
          party_type: string
          rule_reference: string
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
      get_dsc_expiry_status: {
        Args: { p_company_id: string }
        Returns: {
          certifying_authority: string
          days_remaining: number
          designation: string
          dsc_class: string
          expiring_within_30_days: boolean
          expiring_within_60_days: boolean
          expiring_within_90_days: boolean
          holder_director_id: string
          holder_label: string
          id: string
          is_expired: boolean
          valid_from: string
          valid_to: string
        }[]
      }
      get_effective_item_price: {
        Args: {
          p_as_of_date?: string
          p_company_id: string
          p_item_id: string
          p_price_list_id?: string
        }
        Returns: number
      }
      get_einvoice_applicability: {
        Args: { p_as_of?: string; p_company_id: string }
        Returns: {
          current_fy_label: string
          current_fy_turnover_to_date: number
          fy_breakdown: Json
          highest_completed_fy_label: string
          highest_completed_fy_turnover: number
          is_applicable: boolean
          note: string
          threshold_amount: number
          triggering_fy_label: string
          triggering_fy_turnover: number
        }[]
      }
      get_einvoice_status: {
        Args: { p_company_id: string; p_from?: string; p_to?: string }
        Returns: {
          ack_date: string
          einvoice_id: string
          generated_at: string
          irn: string
          party_gstin: string
          party_name: string
          status: string
          supply_type: string
          total_amount: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_employee_perquisites_total: {
        Args: {
          p_company_id: string
          p_employee_id: string
          p_financial_year_label: string
        }
        Returns: number
      }
      get_employee_perquisites_valued: {
        Args: {
          p_company_id: string
          p_employee_id: string
          p_financial_year_label: string
        }
        Returns: {
          accommodation_ownership: string
          amount_recovered_from_employee: number
          car_cc_class: string
          car_usage: string
          city_population_tier: string
          computation_note: string
          driver_provided: boolean
          months_applicable: number
          other_perquisite_description: string
          perquisite_id: string
          perquisite_type: string
          rule_salary_base: number
          running_cost_borne_by: string
          taxable_value: number
        }[]
      }
      get_esi_mc_data: {
        Args: { p_company_id: string; p_period_month: string }
        Returns: {
          employee_id: string
          has_ip_number: boolean
          ip_name: string
          ip_number: string
          last_working_day: string
          no_of_days: number
          reason_code: number
          reason_label: string
          total_monthly_wages: number
        }[]
      }
      get_ewb_requirement: {
        Args: { p_voucher_id: string }
        Returns: {
          consignment_value: number
          is_ewb_required: boolean
          taxable_value: number
          threshold_amount: number
          total_gst_tax: number
          voucher_id: string
        }[]
      }
      get_ewb_status: {
        Args: { p_company_id: string }
        Returns: {
          consignment_value: number
          ewb_generated_date: string
          ewb_id: string
          ewb_number: string
          ewb_valid_until: string
          is_ewb_required: boolean
          party_name: string
          status: string
          transport_mode: string
          vehicle_number: string
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_exim_realisation_status: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          brc_date: string
          brc_number: string
          days_overdue: number
          document_date: string
          document_number: string
          document_type: string
          export_realisation_due_date: string
          is_overdue: boolean
          is_realised: boolean
          party_name: string
          port_code: string
          realised_date: string
          shipment_id: string
          status: string
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_filing_register: {
        Args: { p_company_id: string }
        Returns: {
          acknowledgement_number: string
          additional_fee: number
          created_at: string
          fee_paid: number
          filed_date: string
          form_code: string
          gst_registration_id: string
          gstin: string
          id: string
          notes: string
          period_label: string
          status: string
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
      get_fnf_preview: {
        Args: {
          p_company_id: string
          p_employee_id: string
          p_exit_date: string
          p_exit_reason: string
        }
        Returns: {
          date_of_joining: string
          employee_id: string
          employee_name: string
          exit_month_already_posted: boolean
          exit_month_reference_gross: number
          gratuity_amount: number
          gratuity_completed_years: number
          gratuity_eligible: boolean
          gratuity_ineligibility_reason: string
          leave_balance_days: number
          leave_daily_wage: number
          leave_encashment_amount: number
          statutory_monthly_wage: number
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
      get_form16_partb: {
        Args: {
          p_company_id: string
          p_employee_id: string
          p_financial_year_label: string
        }
        Returns: {
          basic_total: number
          dearness_allowance_total: number
          declaration_date: string
          declaration_exists: boolean
          declared_regime: string
          deduction_80c_allowed: number
          deduction_80c_claimed: number
          deduction_80d_allowed: number
          deduction_80d_claimed: number
          employee_id: string
          employee_name: string
          financial_year_label: string
          form_label: string
          gross_salary: number
          home_loan_interest_24b_allowed: number
          home_loan_interest_24b_claimed: number
          hra_exemption_claimed: number
          hra_total: number
          is_fy_complete: boolean
          months_with_payroll_data: number
          net_tax_payable: number
          new_cess: number
          new_income_chargeable_salary: number
          new_net_tax_payable: number
          new_rebate_87a: number
          new_surcharge: number
          new_tax_before_rebate: number
          new_taxable_income: number
          old_cess: number
          old_chapter_via_deductions: number
          old_gross_total_income: number
          old_income_chargeable_salary: number
          old_net_tax_payable: number
          old_rebate_87a: number
          old_surcharge: number
          old_tax_before_rebate: number
          old_taxable_income: number
          other_allowance_total: number
          pan: string
          period_from: string
          period_to: string
          perquisites_value: number
          previous_employer_income: number
          previous_employer_tds_deducted: number
          professional_tax_total: number
          regime_used: string
          special_allowance_total: number
          tds_deposited_per_payroll_projection: number
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
      get_gratuity_computation: {
        Args: {
          p_company_id: string
          p_employee_id: string
          p_exit_date: string
          p_exit_reason: string
        }
        Returns: {
          ceiling_applied: boolean
          completed_years_for_formula: number
          date_of_joining: string
          eligible: boolean
          employee_id: string
          employee_name: string
          exit_date: string
          exit_reason: string
          gratuity_ceiling: number
          gratuity_payable: number
          gratuity_uncapped: number
          ineligibility_reason: string
          statutory_monthly_wage: number
          tenure_days: number
          tenure_months: number
          tenure_years: number
        }[]
      }
      get_gratuity_estimates: {
        Args: { p_as_of?: string; p_company_id: string }
        Returns: {
          ceiling_applied: boolean
          completed_years_for_formula: number
          date_of_joining: string
          eligible: boolean
          employee_id: string
          employee_name: string
          gratuity_payable: number
          gratuity_uncapped: number
          ineligibility_reason: string
          statutory_monthly_wage: number
          tenure_days: number
          tenure_months: number
          tenure_years: number
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
      get_gst_refund_rule89_4: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          adjusted_total_turnover: number
          blocked_or_exempt_linked_itc_excluded: number
          exempt_turnover: number
          export_lut_turnover: number
          net_itc: number
          net_itc_cess: number
          net_itc_cgst: number
          net_itc_igst: number
          net_itc_sgst: number
          refund_amount: number
          sez_zero_tax_turnover: number
          total_turnover: number
          zero_rated_turnover_goods: number
          zero_rated_turnover_services: number
          zero_rated_turnover_total: number
        }[]
      }
      get_gst_refund_rule89_5: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          adjusted_total_turnover: number
          aggregate_input_rate_percent: number
          eligible_input_taxable_value: number
          exempt_turnover: number
          inverted_rated_turnover: number
          itc_availed_on_inputs_and_services: number
          net_itc: number
          net_itc_cess: number
          net_itc_cgst: number
          net_itc_igst: number
          net_itc_sgst: number
          refund_amount: number
          tax_payable_cess: number
          tax_payable_cgst: number
          tax_payable_igst: number
          tax_payable_on_inverted_turnover: number
          tax_payable_sgst: number
          total_turnover: number
        }[]
      }
      get_gst_refund_rule89_5_items: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          hsn_sac: string
          is_flagged_inverted_rated: boolean
          item_id: string
          item_name: string
          output_gst_rate_percent: number
          taxable_turnover: number
        }[]
      }
      get_gst_setoff_computation: {
        Args: {
          p_as_at: string
          p_company_id: string
          p_gst_registration_id: string
        }
        Returns: {
          amount: number
          credit_head: string
          narration: string
          row_kind: string
          step: number
          tax_head: string
        }[]
      }
      get_gst_tds_tcs_suffered_summary: {
        Args: {
          p_company_id: string
          p_financial_year_label?: string
          p_gst_registration_id?: string
        }
        Returns: {
          cgst_total: number
          claimed_count: number
          deductor_or_operator_gstin: string
          deductor_or_operator_name: string
          entry_count: number
          igst_total: number
          sgst_total: number
          source_type: string
          taxable_value_total: number
          total_credit: number
          unclaimed_count: number
          unclaimed_credit: number
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
          b2b_or_b2c: string
          cess: number
          cgst: number
          description: string
          gst_rate_percent: number
          hsn_sac: string
          igst: number
          sgst: number
          taxable_value: number
          total_quantity: number
          total_value: number
          uom: string
        }[]
      }
      get_gstr1_table11a: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cess_rate_percent: number
          cgst: number
          gross_advance: number
          igst: number
          place_of_supply: string
          place_of_supply_name: string
          rate_percent: number
          sgst: number
          supply_category: string
          taxable_value: number
        }[]
      }
      get_gstr1_table11b: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cess_rate_percent: number
          cgst: number
          gross_advance: number
          igst: number
          place_of_supply: string
          place_of_supply_name: string
          rate_percent: number
          sgst: number
          supply_category: string
          taxable_value: number
        }[]
      }
      get_gstr1_table13: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          branch_code: string
          branch_id: string
          cancelled: number
          financial_year_label: string
          nature_of_document: string
          net_issued: number
          range_has_gap: boolean
          serial_from: number
          serial_span: number
          serial_to: number
          series_prefix: string
          total_issued: number
          voucher_type: string
        }[]
      }
      get_gstr1_table6a: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          has_goods_line: boolean
          igst: number
          invoice_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          port_code: string
          sgst: number
          shipping_bill_date: string
          shipping_bill_number: string
          tax_payment: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_gstr1_table6b: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          has_goods_line: boolean
          igst: number
          invoice_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          port_code: string
          sgst: number
          shipping_bill_date: string
          shipping_bill_number: string
          tax_payment: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_gstr1_table6c: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cess: number
          cgst: number
          has_goods_line: boolean
          igst: number
          invoice_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          port_code: string
          sgst: number
          shipping_bill_date: string
          shipping_bill_number: string
          tax_payment: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
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
      get_gstr1_table9b: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          against_invoice_date: string
          against_invoice_number: string
          cess: number
          cgst: number
          igst: number
          note_date: string
          note_number: string
          note_type: string
          note_value: number
          party_gstin: string
          party_name: string
          place_of_supply: string
          sgst: number
          taxable_value: number
          voucher_id: string
        }[]
      }
      get_gstr3b_table4: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          a_total: number
          a1_import_of_goods: number
          a2_import_of_services: number
          a3_inward_rcm: number
          a3_rcm_memo_liability_accrued: number
          a4_isd: number
          a5_all_other_itc: number
          a5_all_other_itc_cess: number
          a5_all_other_itc_cgst: number
          a5_all_other_itc_igst: number
          a5_all_other_itc_sgst: number
          b_total: number
          b1_rule42_reversal: number
          b1_rule42_reversal_cess: number
          b1_rule42_reversal_cgst: number
          b1_rule42_reversal_igst: number
          b1_rule42_reversal_sgst: number
          b1_sec17_5_blocked: number
          b1_total: number
          b2_others_rule37: number
          c_net_itc_available: number
          d1_reclaimed_itc: number
          d2_ineligible_16_4_and_pos: number
          exempt_turnover_ratio: number
          note: string
        }[]
      }
      get_gstr3b_table5_1: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cash_tax_payable: number
          days_late: number
          due_date: string
          filing_frequency: string
          interest_amount: number
          interest_rate_percent: number
          is_nil_return_proxy: boolean
          is_provisional: boolean
          late_fee_amount: number
          late_fee_cap: number
          late_fee_rate_per_day: number
          matched_payment_count: number
          matched_payment_total: number
          note: string
          qrmp_category: string
          return_period_end: string
          return_period_start: string
          settlement_date: string
          tax_head: string
          turnover_preceding_fy: number
        }[]
      }
      get_gstr3b_table6_1: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          cash_tax_payable: number
          interest_payable: number
          itc_cess_utilised: number
          itc_cgst_utilised: number
          itc_igst_utilised: number
          itc_sgst_utilised: number
          itc_total_utilised: number
          late_fee_payable: number
          tax_head: string
          tax_payable: number
          tds_tcs_credit: number
        }[]
      }
      get_gstr9_table4_5: {
        Args: {
          p_company_id: string
          p_fy_end: string
          p_fy_start: string
          p_gst_registration_id: string
        }
        Returns: {
          cess: number
          cgst: number
          description: string
          igst: number
          note: string
          row_code: string
          sgst: number
          table_ref: string
          tax_total: number
          taxable_value: number
        }[]
      }
      get_gstr9_table8: {
        Args: {
          p_company_id: string
          p_fy_end: string
          p_fy_start: string
          p_gst_registration_id: string
        }
        Returns: {
          description: string
          document_count: number
          note: string
          row_code: string
          tax_total: number
          taxable_value: number
        }[]
      }
      get_gstr9c_turnover_reconciliation: {
        Args: {
          p_company_id: string
          p_fy_end: string
          p_fy_start: string
          p_gst_registration_id: string
        }
        Returns: {
          books_other_income: number
          books_revenue_from_operations: number
          difference: number
          gst_workpaper_turnover: number
          note: string
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
      get_invoice_outstanding: {
        Args: { p_as_at?: string; p_company_id: string; p_voucher_id: string }
        Returns: number
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
      get_itc_180day_reversal: {
        Args: { p_as_at?: string; p_company_id: string }
        Returns: {
          days_overdue: number
          interest_amount: number
          invoice_value: number
          itc_cess: number
          itc_cgst: number
          itc_igst: number
          itc_sgst: number
          itc_total: number
          outstanding_amount: number
          party_name: string
          reversal_itc: number
          total_reversal_due: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_itc_eligibility_summary: {
        Args: { p_company_id: string; p_from: string; p_to: string }
        Returns: {
          blocked_tax: number
          blocked_taxable_value: number
          eligible_tax: number
          eligible_taxable_value: number
          total_tax: number
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
      get_leave_balance: {
        Args: { p_as_of?: string; p_company_id: string; p_employee_id: string }
        Returns: number
      }
      get_leave_balances: {
        Args: { p_as_of?: string; p_company_id: string }
        Returns: {
          accrued: number
          adjusted: number
          availed: number
          balance: number
          carry_forward_cap: number
          date_of_joining: string
          employee_id: string
          employee_name: string
          encashed: number
          excess_over_cap: number
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
      get_llp_contribution_summary: {
        Args: { p_company_id: string }
        Returns: {
          contribution_count: number
          designation: string
          director_id: string
          is_current: boolean
          is_designated_partner: boolean
          last_contribution_date: string
          name: string
          total_cash: number
          total_contribution: number
          total_kind: number
        }[]
      }
      get_meetings: {
        Args: { p_company_id: string; p_type_filter?: string }
        Returns: {
          agenda: string
          days_since_meeting: number
          financial_year_start_year: number
          id: string
          meeting_date: string
          meeting_type: string
          minutes_overdue: boolean
          minutes_signed_date: string
          notice_date: string
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
      get_notes_employee_benefits_breakup: {
        Args: {
          p_branch_id?: string
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          amount: number
          bucket_label: string
          bucket_order: number
          ledger_id: string
          ledger_name: string
          source_basis: string
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
      get_pending_email_notifications: {
        Args: { p_company_id: string }
        Returns: {
          body_summary: string
          notification_id: string
          subject: string
          to_email: string
        }[]
      }
      get_pending_notification_summary: {
        Args: never
        Returns: {
          company_id: string
          company_name: string
          pending_count: number
        }[]
      }
      get_pf_ecr_data: {
        Args: { p_company_id: string; p_period_month: string }
        Returns: {
          edli_wages: number
          employee_id: string
          epf_contribution_employee: number
          epf_contribution_employer_diff: number
          epf_wages: number
          eps_contribution_employer: number
          eps_wages: number
          gross_wages: number
          has_uan: boolean
          member_name: string
          ncp_days: number
          refund_of_advances: number
          uan: string
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
          ledger_role: string
          nature: string
          section: string
        }[]
      }
      get_pt_liability_by_state: {
        Args: {
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          branch_id: string
          branch_name: string
          employee_count: number
          pt_liability: number
          state_code: string
          state_name: string
        }[]
      }
      get_quantitative_stock_details: {
        Args: { p_company_id: string; p_fy_end: string; p_fy_start: string }
        Returns: {
          closing_quantity: number
          excess_quantity: number
          hsn_sac: string
          is_principal_item: boolean
          item_id: string
          item_name: string
          opening_quantity: number
          purchases_quantity: number
          sales_quantity: number
          shortage_quantity: number
          uom: string
          verified_as_at: string
        }[]
      }
      get_related_party_note: {
        Args: {
          p_company_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          closing_balance: number
          closing_balance_type: string
          ledger_id: string
          ledger_name: string
          period_credit: number
          period_debit: number
          relationship_type: string
          voucher_type: string
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
          regime_used: string
          standard_deduction: number
          taxable_salary_income: number
        }[]
      }
      get_sec186_ceiling_check: {
        Args: { p_company_id: string }
        Returns: {
          board_only_limit: number
          caveat: string
          ceiling_100pct_reserves: number
          ceiling_60pct_capital_plus_reserves: number
          headroom_before_shareholder_approval: number
          is_approximate: boolean
          paid_up_capital: number
          reserves_and_securities_premium_approx: number
          total_recorded_loans_investments: number
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
      get_service_advance_receipts: {
        Args: { p_company_id: string; p_status_filter?: string }
        Returns: {
          adjusted_at: string
          adjusted_note: string
          adjusted_voucher_date: string
          adjusted_voucher_id: string
          adjusted_voucher_number: string
          advance_amount: number
          cess_amount: number
          cess_rate_percent: number
          created_at: string
          gst_amount: number
          gst_rate_percent: number
          id: string
          notes: string
          party_ledger_id: string
          party_name: string
          place_of_supply: string
          place_of_supply_name: string
          rate_not_determinable: boolean
          status: string
          taxable_value: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      get_share_capital_summary: {
        Args: { p_company_id: string }
        Returns: {
          authorized_capital: number
          authorized_shares: number
          class_name: string
          current_holder_count: number
          issued_shares: number
          nominal_value_per_share: number
          paid_up_capital: number
          share_class_id: string
          unissued_shares: number
        }[]
      }
      get_signature_request_by_token: {
        Args: { p_token: string }
        Returns: {
          company_id: string
          company_name: string
          decline_reason: string
          documents: Json
          request_description: string
          request_id: string
          request_status: string
          request_title: string
          sign_order: number
          signed_at: string
          signer_email: string
          signer_id: string
          signer_name: string
          signer_status: string
        }[]
      }
      get_statutory_bonus_computation: {
        Args: { p_company_id: string; p_fy_end: string }
        Returns: {
          annual_calculation_wage: number
          annual_salary_wage_earned: number
          date_of_joining: string
          date_of_leaving: string
          days_employed_in_fy: number
          eligible: boolean
          employee_id: string
          employee_name: string
          full_year_employment: boolean
          ineligibility_reason: string
          maximum_bonus_at_20pct: number
          minimum_bonus: number
          minimum_bonus_floor_applied: boolean
          monthly_wage_rate: number
        }[]
      }
      get_statutory_bonus_surplus_estimate: {
        Args: { p_company_id: string; p_fy_end: string }
        Returns: {
          act_applicable_by_headcount: boolean
          affordable_bonus_percent_approx: number
          allocable_surplus_approx: number
          allocable_surplus_percent: number
          available_surplus_approx: number
          book_depreciation_addback: number
          book_profit: number
          eligible_employee_count: number
          entity_type: string
          estimated_direct_tax: number
          fy_end: string
          fy_start: string
          headcount_this_fy: number
          note: string
          surplus_computable: boolean
          surplus_covers_minimum_bonus: boolean
          tax_depreciation_deduction: number
          total_annual_calculation_wage: number
          total_maximum_bonus_at_20pct: number
          total_minimum_bonus: number
        }[]
      }
      get_stock_ageing: {
        Args: { p_as_at?: string; p_company_id: string; p_godown_id?: string }
        Returns: {
          average_rate: number
          closing_quantity: number
          item_id: string
          item_name: string
          qty_0_30: number
          qty_181_365: number
          qty_31_60: number
          qty_61_90: number
          qty_91_180: number
          qty_over_365: number
          uom: string
          val_0_30: number
          val_181_365: number
          val_31_60: number
          val_61_90: number
          val_91_180: number
          val_over_365: number
        }[]
      }
      get_stock_fifo_layers: {
        Args: { p_as_at?: string; p_company_id: string; p_godown_id?: string }
        Returns: {
          hsn_sac: string
          item_id: string
          item_name: string
          layer_date: string
          layer_source: string
          layer_value: number
          original_quantity: number
          quantity_remaining: number
          unit_cost: number
          uom: string
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
      get_stock_summary_fifo: {
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
          unpriced_quantity: number
          uom: string
        }[]
      }
      get_stock_verifications: {
        Args: { p_company_id: string; p_from_date?: string; p_to_date?: string }
        Returns: {
          adjustment_voucher_id: string
          adjustment_voucher_number: string
          average_rate: number
          batch_id: string
          batch_no: string
          book_quantity: number
          created_at: string
          godown_id: string
          godown_name: string
          item_id: string
          item_name: string
          notes: string
          physical_quantity: number
          uom: string
          variance_quantity: number
          variance_value: number
          verification_date: string
          verification_id: string
        }[]
      }
      get_taggable_receipt_vouchers: {
        Args: { p_company_id: string }
        Returns: {
          already_tagged_amount: number
          available_amount: number
          party_ledger_id: string
          party_name: string
          received_amount: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
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
      get_tcs_collectee_summary: {
        Args: {
          p_company_id: string
          p_financial_year_label: string
          p_quarter: number
        }
        Returns: {
          collectee_ledger_id: string
          collectee_name: string
          pan: string
          party_ledger_movement: number
          section_code: string
          section_description: string
          section_rate_percent: number
          tcs_collected: number
          voucher_count: number
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
      get_tds_late_deposit_interest: {
        Args: { p_company_id: string; p_financial_year_label: string }
        Returns: {
          amount_matched: number
          challan_id: string
          deduction_date: string
          deduction_voucher_id: string
          deposit_date: string
          due_date: string
          interest_amount: number
          interest_rate_percent: number
          months_delayed: number
          status: string
        }[]
      }
      get_tds_threshold_status: {
        Args: {
          p_as_of?: string
          p_company_id: string
          p_deductee_ledger_id: string
          p_tds_section_code: string
        }
        Returns: {
          aggregate_threshold_crossed: boolean
          as_of_date: string
          basis_note: string
          cumulative_credited_this_fy: number
          financial_year_label: string
          fy_start_date: string
          largest_single_transaction: number
          no_pan_rate_percent: number
          rate_percent: number
          section_code: string
          section_description: string
          single_threshold_crossed: boolean
          taxable_basis_amount: number
          tds_applicable: boolean
          threshold_aggregate_rupees: number
          threshold_single_rupees: number
        }[]
      }
      get_tds_threshold_status_summary: {
        Args: { p_as_of?: string; p_company_id: string }
        Returns: {
          aggregate_threshold_crossed: boolean
          basis_note: string
          cumulative_credited_this_fy: number
          deductee_ledger_id: string
          deductee_name: string
          financial_year_label: string
          largest_single_transaction: number
          pan: string
          rate_percent: number
          section_code: string
          section_description: string
          single_threshold_crossed: boolean
          taxable_basis_amount: number
          tds_applicable: boolean
          threshold_aggregate_rupees: number
          threshold_single_rupees: number
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
      import_gstr2b_lines: {
        Args: {
          p_company_id: string
          p_gst_registration_id: string
          p_lines: Json
          p_return_period: string
        }
        Returns: number
      }
      import_income_tax_statement_lines: {
        Args: {
          p_company_id: string
          p_financial_year_label: string
          p_lines: Json
          p_source: string
        }
        Returns: number
      }
      list_gstr2b_periods: {
        Args: { p_company_id: string }
        Returns: {
          gst_registration_id: string
          gstin: string
          line_count: number
          return_period: string
          uploaded_at: string
        }[]
      }
      list_income_tax_statement_periods: {
        Args: { p_company_id: string }
        Returns: {
          financial_year_label: string
          line_count: number
          source: string
          tan_count: number
          uploaded_at: string
        }[]
      }
      list_recurring_voucher_templates: {
        Args: { p_company_id: string }
        Returns: {
          branch_id: string
          branch_name: string
          day_of_month: number
          end_date: string
          frequency: string
          id: string
          is_active: boolean
          is_due: boolean
          last_run_date: string
          last_run_voucher_id: string
          last_run_voucher_number: string
          line_count: number
          lines: Json
          narration_template: string
          next_run_date: string
          party_ledger_id: string
          party_ledger_name: string
          start_date: string
          template_amount: number
          template_name: string
          voucher_type: string
        }[]
      }
      mark_notification_sent: {
        Args: { p_notification_id: string; p_success: boolean }
        Returns: undefined
      }
      mark_order_converted: {
        Args: { p_company_id: string; p_order_id: string; p_voucher_id: string }
        Returns: undefined
      }
      mark_service_advance_adjusted: {
        Args: {
          p_adjusted_note?: string
          p_adjusted_voucher_id: string
          p_advance_id: string
          p_company_id: string
        }
        Returns: undefined
      }
      match_bank_line: {
        Args: { p_statement_line_id: string; p_voucher_entry_id: string }
        Returns: undefined
      }
      match_gstr2b_purchase_register: {
        Args: {
          p_company_id: string
          p_gst_registration_id?: string
          p_lookback_months?: number
          p_return_period: string
        }
        Returns: {
          amount_difference: number
          bucket: string
          invoice_date: string
          invoice_number: string
          itc_availability: string
          itc_reason: string
          supplier_gstin: string
          supplier_name: string
          tax_2b: number
          tax_register: number
          taxable_value_2b: number
          taxable_value_register: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
        }[]
      }
      match_income_tax_statement_tds_receivable: {
        Args: {
          p_company_id: string
          p_financial_year_label: string
          p_source: string
        }
        Returns: {
          amount_difference: number
          amount_paid_credited_statement: number
          bucket: string
          deductor_name: string
          deductor_tan: string
          ledger_id: string
          ledger_name: string
          tax_deducted_statement: number
          tax_deposited_statement: number
          tds_receivable_register: number
        }[]
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
      post_deferred_tax: {
        Args: {
          p_branch_id: string
          p_company_id: string
          p_fy_end: string
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
      post_gst_setoff: {
        Args: {
          p_as_at: string
          p_branch_id: string
          p_company_id: string
          p_gst_registration_id: string
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
      record_fnf_settlement: {
        Args: {
          p_bonus_amount?: number
          p_company_id: string
          p_employee_id: string
          p_exit_date: string
          p_exit_reason: string
          p_notes?: string
          p_recoveries_amount?: number
          p_unpaid_salary_amount?: number
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
      record_leave_transaction: {
        Args: {
          p_company_id: string
          p_days: number
          p_employee_id: string
          p_entry_type: string
          p_notes?: string
          p_transaction_date: string
        }
        Returns: string
      }
      record_signed_document: {
        Args: {
          p_document_id: string
          p_has_embedded_signature?: boolean
          p_request_id: string
          p_signature_check_note?: string
          p_signer_id: string
        }
        Returns: undefined
      }
      record_signed_document_by_token: {
        Args: {
          p_file_name: string
          p_has_embedded_signature?: boolean
          p_mime_type: string
          p_signature_check_note?: string
          p_size_bytes: number
          p_storage_path: string
          p_token: string
        }
        Returns: undefined
      }
      record_stock_verification: {
        Args: {
          p_batch_id?: string
          p_branch_id: string
          p_company_id: string
          p_godown_id: string
          p_item_id: string
          p_notes?: string
          p_physical_quantity: number
          p_verification_date: string
        }
        Returns: {
          adjustment_voucher_id: string
          average_rate: number
          book_quantity: number
          physical_quantity: number
          variance_quantity: number
          variance_value: number
          verification_id: string
        }[]
      }
      regenerate_signer_access_token: {
        Args: { p_signer_id: string }
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
      send_signature_request: {
        Args: { p_request_id: string }
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
      set_recurring_voucher_template_active: {
        Args: { p_is_active: boolean; p_template_id: string }
        Returns: undefined
      }
      unmark_service_advance_adjusted: {
        Args: { p_advance_id: string; p_company_id: string }
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
      update_recurring_voucher_template: {
        Args: {
          p_end_date?: string
          p_lines: Json
          p_narration_template?: string
          p_party_ledger_id?: string
          p_template_id: string
          p_template_name: string
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
