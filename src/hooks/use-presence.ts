import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type StoredPresence = "online" | "away" | "offline";

export interface PresenceRow {
  status: StoredPresence;
  last_seen_at: string;
}

const ONLINE_WINDOW_MS = 60 * 1000;
const AWAY_WINDOW_MS = 5 * 60 * 1000;
const RE_DERIVE_MS = 15 * 1000;

export type DerivedPresence = "online" | "away" | "offline";

export function derivePresence(row: PresenceRow | undefined, nowMs: number): DerivedPresence {
  if (!row) return "offline";
  const lastSeenMs = new Date(row.last_seen_at).getTime();
  if (isNaN(lastSeenMs)) return "offline";
  const ageMs = nowMs - lastSeenMs;
  if (ageMs < 0) return row.status === "away" ? "away" : "online";
  if (ageMs <= ONLINE_WINDOW_MS) return row.status === "away" ? "away" : "online";
  if (ageMs <= AWAY_WINDOW_MS) return "away";
  return "offline";
}

export function usePresence(accountId?: string | null | undefined): {
  presenceMap: Map<string, PresenceRow>;
  getPresence: (userId: string | null | undefined) => DerivedPresence;
  getRow: (userId: string | null | undefined) => PresenceRow | undefined;
  now: number;
} {
  const [rows, setRows] = useState<Map<string, PresenceRow>>(() => new Map());
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!accountId) return;

    const supabase = createClient();
    let cancelled = false;

    const applyRow = (payload: {
      user_id: string;
      status: StoredPresence;
      last_seen_at: string;
    }) => {
      if (!payload.user_id) return;
      setRows((prev) => {
        const next = new Map(prev);
        next.set(payload.user_id, {
          status: payload.status,
          last_seen_at: payload.last_seen_at,
        });
        return next;
      });
    };

    const channel = supabase
      .channel(`presence:${accountId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "member_presence",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as { user_id?: string };
            if (!old.user_id) return;
            setRows((prev) => {
              if (!prev.has(old.user_id!)) return prev;
              const next = new Map(prev);
              next.delete(old.user_id!);
              return next;
            });
            return;
          }
          applyRow(
            payload.new as {
              user_id: string;
              status: StoredPresence;
              last_seen_at: string;
            },
          );
        },
      )
      .subscribe();

    supabase
      .from("member_presence")
      .select("user_id, status, last_seen_at")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn("[usePresence] presence table check:", error.message);
          return;
        }
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of data ?? []) {
            const userId = r.user_id as string;
            const incoming: PresenceRow = {
              status: r.status as StoredPresence,
              last_seen_at: r.last_seen_at as string,
            };
            const existing = next.get(userId);
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(userId, incoming);
            }
          }
          return next;
        });
      });

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      void supabase.removeChannel(channel);
    };
  }, [accountId]);

  const getPresence = (userId: string | null | undefined): DerivedPresence => {
    if (!userId) return "offline";
    return derivePresence(rows.get(userId), now);
  };

  const getRow = (userId: string | null | undefined): PresenceRow | undefined => {
    if (!userId) return undefined;
    return rows.get(userId);
  };

  return { presenceMap: rows, getPresence, getRow, now };
}
