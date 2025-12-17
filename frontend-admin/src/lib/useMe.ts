import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./api";

export type AdminMe = { username: string; role: string; workspace_id: string };

export function useMe() {
  return useQuery({
    queryKey: ["adminMe"],
    queryFn: () => apiFetch<AdminMe>("/admin/api/auth/me"),
  });
}

