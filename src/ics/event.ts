import type { Env } from "../env.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { eventIdFor } from "../google/event-id.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import type { IcsEvent } from "./serialise.ts";

/**
 * One session as an ICS event, from the same session-plus-campaign shape the
 * Google projector already loads.
 *
 * The `UID` is `eventIdFor(session.id)` with an `@orrey` suffix, so the ICS
 * event and the Google event carry one identity and a support question about
 * either can be answered from the other. Whether a client merges two
 * subscriptions sharing a UID is the client's business; Orrey does not rely on
 * that and does not promise it.
 */
export async function icsEventFor(target: ProjectionTarget): Promise<IcsEvent> {
  const { session } = target;
  const uid = `${await eventIdFor(session.id)}@orrey`;

  return {
    uid,
    sequence: session.icsSequence,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    summary: sessionTitle(target),
    location: session.location ?? target.gameDay?.venue ?? null,
    // A session nobody has confirmed is `TENTATIVE`, which is a real ICS status
    // and reads in a client exactly as it reads in Discord. `CANCELLED` is
    // emitted rather than the event being dropped: dropping it leaves the event
    // in every subscriber's calendar for ever.
    status:
      session.state === "CANCELLED"
        ? "CANCELLED"
        : session.state === "CONFIRMED" || session.state === "PLAYED"
          ? "CONFIRMED"
          : "TENTATIVE",
  };
}

/** The zone the feed's `DTSTART`s are written in. */
export function feedZone(env: Env): Promise<string> {
  return settingOr<string>(env, SETTING_KEYS.timezone, SETTING_DEFAULTS[SETTING_KEYS.timezone]);
}
