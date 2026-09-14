import type { Env } from "../env.ts";
import { loadCampaignAttendance, type CampaignAttendance } from "../stats/campaign.ts";
import { loadScheduleStats, type ScheduleStats } from "../stats/schedule.ts";
import { loadDaysStats, type DayStats } from "../stats/game-day.ts";

/**
 * The two stats views, assembled from the three compute functions and nothing
 * else.
 *
 * **Read-only in the strict sense.** Nothing here writes a row, enqueues a
 * message or calls Discord. #47's third checkbox says nothing posts to Discord,
 * and a stats page is exactly the kind of thing somebody later wants a weekly
 * summary post for — so the tests assert the outbox is empty and no message was
 * sent, rather than leaving it to be reasoned about.
 *
 * Neither function computes anything. If a number here were derived rather than
 * passed through, the page would be a second implementation of a statistic and
 * the two would disagree the first time one of them was corrected.
 */
export interface CampaignStats {
  campaignId: string;
  attendance: CampaignAttendance;
  schedule: ScheduleStats;
}

export async function campaignStats(env: Env, campaignId: string): Promise<CampaignStats> {
  return {
    campaignId,
    attendance: await loadCampaignAttendance(env, campaignId),
    schedule: await loadScheduleStats(env, campaignId),
  };
}

export interface GameDayStats {
  days: DayStats[];
  /**
   * The mean fill rate across the days that have one, or null when none does.
   *
   * Averaged over the days with a capacity only — a multi day has no fill rate,
   * and folding its null in as a zero would drag the average down with evenings
   * that were never going to be full.
   */
  averageFillRate: number | null;
}

export async function gameDayStats(env: Env): Promise<GameDayStats> {
  const days = await loadDaysStats(env);
  const rates = days
    .map((day) => day.fillRate)
    .filter((rate): rate is number => rate !== null);

  return {
    days,
    averageFillRate:
      rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length,
  };
}
