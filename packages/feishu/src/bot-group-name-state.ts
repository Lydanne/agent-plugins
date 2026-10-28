export type FeishuGroupInfo = {
  status: "available" | "unavailable";
  name?: string;
  description?: string;
  fetchedAt: number;
};

export const feishuGroupNameCache = new Map<string, FeishuGroupInfo & { expiresAt: number }>();
