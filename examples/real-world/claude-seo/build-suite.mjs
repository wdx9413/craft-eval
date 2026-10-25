// Generate the claude-seo suite: one case per capability area.
//
// claude-seo ships 76 test files. Running them as one blob tells you "something
// broke"; splitting them by area means a failing case names the capability that
// regressed (auth hardening, cost tracking, agentic output, ...). Every case runs
// pytest on its own file group and converts the JUnit XML to JSON, so the
// verdict is per-area rather than all-or-nothing.
import { writeFileSync } from 'node:fs';

const groups = {
  'agentic-output': ['test_agentic.py'],
  'agent-mcp-permissions': ['test_agent_mcp_permissions.py'],
  'agent-untrusted-content': ['test_agent_untrusted_content.py'],
  'audit-instructions': ['test_audit_instructions.py', 'test_audit_agent_turn_budget.py'],
  'backlinks-auth-hardening': ['test_backlinks_auth_hardening.py', 'test_backlink_score_gate.py'],
  'banana-api-key-safety': ['test_banana_api_key_safety.py', 'test_banana_key_masking.py'],
  'banana-cost-tracking': ['test_banana_cost_tracker.py', 'test_dataforseo_costs.py'],
  'banana-install-layout': ['test_banana_install_layout.py', 'test_banana_setup_mcp_atomic_write.py'],
  'webmaster-integrations': ['test_bing_webmaster.py', 'test_domain_history.py'],
  'canonical-facts': ['test_canonical_facts.py', 'test_consistency_check.py'],
  'capture-paths': ['test_capture_screenshot_paths.py'],
  'cluster-escaping': ['test_cluster_map_escaping.py'],
  'commoncrawl-graph': ['test_commoncrawl_graph.py'],
  'content-quality': ['test_content_quality.py', 'test_content_humanize.py'],
  'contributors': ['test_contributors.py'],
  'cross-platform-hooks': ['test_cross_platform_hooks.py'],
  'dataforseo-tool-names': ['test_dataforseo_tool_names.py'],
  'drift-portability': ['test_drift_portability.py'],
  'extension-installer': ['test_extension_installer_injection.py', 'test_extension_mirrors.py'],
  'fetch-page-cli': ['test_fetch_page_cli.py'],
  'ai-crawler-claims': ['test_ai_crawler_claims.py'],
  'manual-install-layout': ['test_manual_install_layout.py'],
  'gcloud-adc': ['test_google_gcloud_adc.py'],
  'report-dependencies': ['test_google_report_full_audit.py'],
};

const cases = Object.entries(groups).map(([id, files]) => ({
  id,
  argv: ['py', '-3', 'run-group.py', ...files],
  timeout_s: 300,
  checks: [
    { id: 'ran', kind: 'exit_code', equals: 0 },
    { id: 'collected', kind: 'script', path: 'assert-collected.py', interpreter: ['py', '-3'], args: ['outputs/group-result.json'], pass_exit_codes: [0] },
    { id: 'passed', kind: 'json_equals', path: 'outputs/group-result.json', key: 'ok', equals: true },
  ],
}));

const suite = {
  schema: 'craft-eval.eval.v1',
  suite_id: 'claude-seo-areas',
  subject_kind: 'software',
  partition: 'development',
  sanitized: true,
  cases,
};

writeFileSync('suite.json', JSON.stringify(suite, null, 2) + '\n');
console.log(`wrote suite.json with ${cases.length} cases`);
