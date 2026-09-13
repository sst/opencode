import type { DatabaseMigration } from "./migration.js"
import m00 from "./migration/20260127222353_familiar_lady_ursula.js"
import m01 from "./migration/20260211171708_add_project_commands.js"
import m02 from "./migration/20260213144116_wakeful_the_professor.js"
import m03 from "./migration/20260225215848_workspace.js"
import m04 from "./migration/20260227213759_add_session_workspace_id.js"
import m05 from "./migration/20260228203230_blue_harpoon.js"
import m06 from "./migration/20260303231226_add_workspace_fields.js"
import m07 from "./migration/20260309230000_move_org_to_state.js"
import m08 from "./migration/20260312043431_session_message_cursor.js"
import m09 from "./migration/20260323234822_events.js"
import m10 from "./migration/20260410174513_workspace-name.js"
import m11 from "./migration/20260413175956_chief_energizer.js"
import m12 from "./migration/20260423070820_add_icon_url_override.js"
import m13 from "./migration/20260427172553_slow_nightmare.js"
import m14 from "./migration/20260428004200_add_session_path.js"
import m15 from "./migration/20260501142318_next_venus.js"
import m16 from "./migration/20260504145000_add_sync_owner.js"
import m17 from "./migration/20260507164347_add_workspace_time.js"
import m18 from "./migration/20260510033149_session_usage.js"
import m19 from "./migration/20260511000411_data_migration_state.js"
import m20 from "./migration/20260511173437_session-metadata.js"
import m21 from "./migration/20260601010001_normalize_storage_paths.js"
import m22 from "./migration/20260601202201_amazing_prowler.js"
import m23 from "./migration/20260602002951_lowly_union_jack.js"
import m24 from "./migration/20260602182828_add_project_directories.js"
import m25 from "./migration/20260603001617_session_message_projection_indexes.js"
import m26 from "./migration/20260603040000_session_message_projection_order.js"
import m27 from "./migration/20260603141458_session_input_inbox.js"
import m28 from "./migration/20260603160727_jittery_ezekiel_stane.js"
import m29 from "./migration/20260604172448_event_sourced_session_input.js"
import m30 from "./migration/20260605003541_add_session_context_snapshot.js"
import m31 from "./migration/20260605042240_add_context_epoch_agent.js"
import m32 from "./migration/20260611035744_credential.js"
import m33 from "./migration/20260611192811_lush_chimera.js"
import m34 from "./migration/20260612174303_project_dir_strategy.js"
import m35 from "./migration/20260622142730_simplify_session_context_epoch.js"
import m36 from "./migration/20260622170816_reset_v2_session_state.js"
import m37 from "./migration/20260622202450_simplify_session_input.js"
import m38 from "./migration/20260804233008_loose_psylocke.js"
import m39 from "./migration/20260805200742_import_legacy_credentials.js"
import m40 from "./migration/20260808023530_workspace_domain.js"
import m41 from "./migration/20260811161259_execution_claim_attempts.js"
import m42 from "./migration/20260812181746_session_inbox.js"
import m43 from "./migration/20260812213948_worktree.js"
import m44 from "./migration/20260819222447_session_viewed_state.js"
import m45 from "./migration/20260823191254_nullable_workspace_binding.js"
import m46 from "./migration/20260910120000_clear_v1_session_permission.js"

export const migrations = [
  m00,
  m01,
  m02,
  m03,
  m04,
  m05,
  m06,
  m07,
  m08,
  m09,
  m10,
  m11,
  m12,
  m13,
  m14,
  m15,
  m16,
  m17,
  m18,
  m19,
  m20,
  m21,
  m22,
  m23,
  m24,
  m25,
  m26,
  m27,
  m28,
  m29,
  m30,
  m31,
  m32,
  m33,
  m34,
  m35,
  m36,
  m37,
  m38,
  m39,
  m40,
  m41,
  m42,
  m43,
  m44,
  m45,
  m46,
] satisfies DatabaseMigration.Migration[]
