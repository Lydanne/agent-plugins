import { renderContextData } from "./context-sections.js";
import type { FeishuConfig } from "./types.js";

// Match only directory names for the current event sender, never message text,
// department IDs, inferred job titles, or names from other participants.
export function buildDepartmentReplyStyleContext(params: {
  senderOpenId: string;
  departments?: { id: string; name?: string; code?: number }[];
  rules?: FeishuConfig["departmentReplyStyles"];
}): string {
  if (!params.senderOpenId || !params.rules?.length) return "";
  const names = (params.departments ?? [])
    .filter((department) => !department.code && department.name?.trim())
    .map((department) => department.name!.trim().toLowerCase());
  for (const rule of params.rules) {
    const matched = rule.departmentKeywords.some((keyword) => {
      const normalized = keyword.trim().toLowerCase();
      return normalized.length > 0 && names.some((name) => name.includes(normalized));
    });
    if (!matched || !rule.style.trim()) continue;
    return "\n\n" + renderContextData('DepartmentReplyStyle', { senderOpenId: params.senderOpenId, source: "department_config", style: rule.style.trim() });
  }
  return "";
}
