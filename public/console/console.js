/**
 * The console, as one module and no build step.
 *
 * It reads and renders and does nothing else yet — the write half is the PR
 * above this one. Everything it shows comes from Orrey's own API, which reads
 * D1: nothing here asks Discord what it holds.
 */
const main = document.getElementById("main");
const status = document.getElementById("status");
const who = document.getElementById("who");

/** Every response is JSON; the interesting part is what a refusal means. */
async function api(path, init) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(init ?? {}),
    ...(init?.body === undefined ? {} : { headers: { "content-type": "application/json" } }),
  });

  if (response.status === 401) throw new Refusal("Not signed in. Run /console in Discord.");
  if (response.status === 403) throw new Refusal("That is an organiser's to do.");
  if (response.status === 503) {
    const body = await response.json().catch(() => ({}));
    throw new Refusal(body.error ?? "Orrey is not configured yet.");
  }
  // 400 is the domain saying no to what was asked — a sentence meant to be read,
  // not a failure to log.
  if (response.status === 400) {
    const body = await response.json().catch(() => ({}));
    throw new Refusal(body.error ?? "Orrey would not take that.");
  }
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);

  return response.json();
}

class Refusal extends Error {}

function text(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Unix seconds to something a person reads, in their own zone. */
function when(seconds) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function cadence(campaign) {
  if (!campaign.intervalWeeks) return "—";
  const every = campaign.intervalWeeks === 1 ? "weekly" : `every ${campaign.intervalWeeks} weeks`;
  return `${every}, from ${when(campaign.recurrenceAnchor)}`;
}

function cell(row, value, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = value;
  row.append(td);
  return td;
}

function campaignsTable(campaigns) {
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent =
    campaigns.length === 1 ? "1 campaign" : `${campaigns.length} campaigns`;
  table.append(caption);

  const head = document.createElement("tr");
  for (const [label, className] of [
    ["Campaign", ""],
    ["State", ""],
    ["Game", ""],
    ["Cadence", ""],
    ["Roster", "numeric"],
    ["Sessions", "numeric"],
    ["", ""],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const campaign of campaigns) {
    const row = document.createElement("tr");

    const name = cell(row, "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "link";
    open.textContent = campaign.name;
    open.addEventListener("click", () => {
      // Toggling rather than only opening: a second click on the name you just
      // opened is the obvious way back out of a long page.
      campaignState.selected = campaignState.selected === campaign.id ? null : campaign.id;
      load();
    });
    name.append(open);
    const id = document.createElement("div");
    id.className = "muted";
    id.textContent = campaign.id;
    name.append(id);
    if (campaignState.selected === campaign.id) row.setAttribute("aria-selected", "true");

    const state = cell(row, campaign.state);
    state.className = "state";
    state.dataset.state = campaign.state;

    cell(row, text(campaign.gameName ?? campaign.gameId));
    cell(row, cadence(campaign));
    cell(row, String(campaign.members), "numeric");
    cell(row, String(campaign.sessions), "numeric");
    lifecycleCell(row, campaign);

    body.append(row);
  }
  table.append(body);
  return table;
}

function gamesTable(games) {
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = games.length === 1 ? "1 game" : `${games.length} games`;
  table.append(caption);

  const head = document.createElement("tr");
  for (const [label, className] of [
    ["Game", ""],
    ["Players", "numeric"],
    ["Usual length", "numeric"],
    ["Held by", ""],
    ["", ""],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const game of games) {
    const row = document.createElement("tr");
    cell(row, game.name);
    cell(
      row,
      game.minPlayers || game.maxPlayers
        ? `${text(game.minPlayers)}–${text(game.maxPlayers)}`
        : "any",
      "numeric",
    );
    cell(
      row,
      game.defaultDurationMinutes ? `${game.defaultDurationMinutes} min` : "—",
      "numeric",
    );
    heldBy(row, game);
    gameActions(row, game);
    body.append(row);
  }
  table.append(body);
  return table;
}

/**
 * The agenda: the worklist, and the record.
 *
 * Two views, and the split is the whole point of the page. **What I'm
 * scheduling** is sessions still waiting on something, and it is the only place
 * on the screen with a primary action. **What's confirmed** carries none: it is
 * the record, not the work, and a button there would invite somebody to do
 * something to a session that does not need anything done to it.
 *
 * It reads `/api/agenda` and nothing else. Nothing on this page is derived here
 * — not the quorum, not the tally, and not the day a session falls on. Anything
 * computed in the browser is a thing no test in this repo can reach, and the
 * day in particular is a fact about the table rather than about the reader's
 * laptop.
 */
const UNSETTLED = new Set(["SCHEDULED", "JEOPARDY"]);

const AGENDA_VIEWS = {
  scheduling: {
    title: "What I'm scheduling",
    lede: "Sessions still waiting on something — an answer, a poll, or a post.",
    empty: "Nothing outstanding. Every session in the window has an answer.",
    count: "open",
    match: (row) => UNSETTLED.has(row.state),
    filters: {
      All: () => true,
      "Quorum short": (row) => row.inJeopardy,
      "Not yet asked": (row) => row.tally.in + row.tally.out + row.tally.maybe === 0,
    },
  },
  confirmed: {
    title: "What's confirmed",
    lede: "Quorum met, Discord posted, calendar written. Nothing here needs you.",
    empty: "Nothing confirmed in this window yet.",
    count: "settled",
    match: (row) => !UNSETTLED.has(row.state),
    filters: {
      All: () => true,
      "Campaign sessions": (row) => row.campaignId !== null,
      "Game days": (row) => row.gameDayId !== null,
    },
  },
};

const agendaState = { mode: "scheduling", grouped: true, filter: "All", selected: null };

function segmented(options, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "segmented";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option;
    if (option === value) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => onChange(option));
    wrap.append(button);
  }
  return wrap;
}

/** In / maybe / out against the roster, as a bar and a sentence. */
function quorumMeter(row) {
  const cell = document.createElement("td");
  const bar = document.createElement("div");
  bar.className = "meter";
  for (const [kind, n] of [
    ["in", row.tally.in],
    ["maybe", row.tally.maybe],
    ["out", row.tally.out],
    ["none", row.tally.noReply],
  ]) {
    if (n === 0) continue;
    const part = document.createElement("span");
    part.dataset.kind = kind;
    part.style.flexGrow = String(n);
    bar.append(part);
  }
  cell.append(bar);

  const line = document.createElement("div");
  line.className = "muted";
  // The quorum line the post carries, or the tally on its own when nothing has
  // asked for a number.
  line.textContent =
    row.quorum.required === null
      ? `${row.tally.in} in, ${row.tally.noReply} not heard from`
      : `${row.quorum.saidIn} of ${row.quorum.required} in`;
  cell.append(line);
  return cell;
}

function agendaTable(rows) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  const columns = agendaState.grouped
    ? ["Session", "Responses", "Status"]
    : ["When", "Session", "Responses", "Status"];
  for (const label of columns) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  let lastDay = null;

  for (const row of rows) {
    if (agendaState.grouped && row.day !== lastDay) {
      const header = document.createElement("tr");
      header.className = "day";
      const cell = document.createElement("th");
      cell.colSpan = columns.length;
      // The label comes from the server, in the guild's zone.
      cell.textContent = row.dayLabel;
      header.append(cell);
      body.append(header);
      lastDay = row.day;
    }

    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    if (agendaState.selected === row.sessionId) tr.setAttribute("aria-selected", "true");
    tr.addEventListener("click", () => {
      agendaState.selected = row.sessionId;
      load();
    });

    if (!agendaState.grouped) cell(tr, when(row.startsAt));

    const title = cell(tr, row.title);
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = agendaState.grouped
      ? [time(row.startsAt), row.location].filter(Boolean).join(" · ")
      : text(row.location);
    title.append(sub);

    tr.append(quorumMeter(row));

    const state = cell(tr, row.state);
    state.className = "state";
    state.dataset.state = row.state;

    body.append(tr);
  }

  table.append(body);
  return table;
}

/** Just the time of day, for a row that already sits under its day's header. */
function time(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The detail rail.
 *
 * The design puts session detail in a 300px rail beside the list rather than on
 * a page of its own, and the month grid will click through to the same one. It
 * is read-only: the three writes are the slice above this.
 *
 * Projection state sits in it rather than behind a button, because it is
 * ambient — a thing to glance at. A dead event link is expected rather than
 * broken: a lapsed Discord event is replaced rather than revived, so the id
 * going missing is the system working.
 */
function detailRail(detail) {
  const rail = document.createElement("aside");
  rail.className = "rail";

  if (!detail) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Pick a session.";
    rail.append(empty);
    return rail;
  }

  const h2 = document.createElement("h2");
  h2.textContent = detail.title;
  rail.append(h2);

  const when_ = document.createElement("p");
  when_.className = "muted";
  when_.textContent = [when(detail.startsAt), detail.location].filter(Boolean).join(" · ");
  rail.append(when_);

  const state = document.createElement("p");
  state.className = "state";
  state.dataset.state = detail.state;
  state.textContent = detail.state;
  rail.append(state);

  const quorum = document.createElement("p");
  quorum.className = "muted";
  quorum.textContent =
    detail.quorum.required === null
      ? `${detail.quorum.saidIn} in`
      : `${detail.quorum.saidIn} of ${detail.quorum.required} in`;
  rail.append(quorum);

  rail.append(
    rosterList(detail.roster),
    syncLog(detail.sync),
    railLinks(detail),
    railActions(detail),
  );
  return rail;
}

/**
 * The three writes, each behind one sentence of confirmation — the same shape
 * the campaign lifecycle actions use, and for the same reason: all three are
 * hard to take back. Cancelling posts a message nobody can unpost; locking does
 * not unlock; opening a poll claims the session until it closes.
 *
 * Each calls the domain function the bot calls. There is no second cancel here.
 */
function railActions(detail) {
  const box = document.createElement("p");
  // Nothing left to do to a session that is over or already off.
  if (detail.state === "PLAYED" || detail.state === "CANCELLED") return box;

  const id = encodeURIComponent(detail.sessionId);

  if (detail.state !== "LOCKED") {
    box.append(
      action("Lock", `Lock ${detail.title}? Nothing unlocks.`, () =>
        api(`/api/sessions/${id}/lock`, { method: "POST", body: "{}" }),
      ),
    );
  }

  box.append(
    action("Suggest another day", `Open a poll to move ${detail.title}?`, () => {
      const dates = prompt("Which days might work? One per line.");
      if (!dates) return null;
      return api(`/api/sessions/${id}/poll`, {
        method: "POST",
        body: JSON.stringify({ dates }),
      });
    }),
    action("Cancel", `Call off ${detail.title}? The thread is told and the calendar cleared.`, () =>
      api(`/api/sessions/${id}/cancel`, { method: "POST", body: "{}" }),
    ),
  );

  return box;
}

function action(label, confirmation, work) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (!confirm(confirmation)) return;
    button.disabled = true;
    await act(async () => {
      const started = work();
      if (started) await started;
    });
  });
  return button;
}

/** Intent and attended side by side. No reply is its own answer, never "out". */
function rosterList(roster) {
  const list = document.createElement("dl");
  list.className = "roster";
  for (const row of roster) {
    const name = document.createElement("dt");
    name.textContent = row.name;
    const said = document.createElement("dd");
    said.dataset.intent = row.intent ?? "none";
    said.textContent = [
      row.intent ?? "not heard from",
      row.attended === null ? null : row.attended ? "came" : "did not come",
      row.corrected ? "(corrected)" : null,
      row.note,
    ]
      .filter(Boolean)
      .join(" · ");
    list.append(name, said);
  }
  return list;
}

function syncLog(sync) {
  const box = document.createElement("p");
  box.className = "sync";
  box.dataset.state = sync.state;
  box.textContent =
    sync.state === "not-projected"
      ? "Not on the calendar yet."
      : sync.state === "failing"
        ? `Last sync failed: ${sync.lastError}`
        : `Synced ${when(sync.syncedAt)}.`;
  return box;
}

function railLinks(detail) {
  const links = document.createElement("p");
  for (const [label, href] of [
    ["Thread", detail.threadUrl],
    ["Event", detail.eventUrl],
  ]) {
    if (!href) continue;
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noreferrer";
    a.target = "_blank";
    a.textContent = label;
    links.append(a, document.createTextNode(" "));
  }
  return links;
}

function agendaSection(agenda) {
  const view = AGENDA_VIEWS[agendaState.mode];
  const filters = Object.keys(view.filters);
  if (!filters.includes(agendaState.filter)) agendaState.filter = "All";

  const rows = agenda.rows.filter(view.match).filter(view.filters[agendaState.filter]);

  const section = document.createElement("section");

  const heading = document.createElement("div");
  heading.className = "bar-inline";
  const h1 = document.createElement("h1");
  h1.textContent = view.title;
  const count = document.createElement("span");
  count.className = "muted";
  count.textContent = `${rows.length} ${view.count}`;
  heading.append(h1, count);
  section.append(heading);

  const lede = document.createElement("p");
  lede.className = "note";
  lede.textContent = view.lede;
  section.append(lede);

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.append(
    segmented(Object.keys(AGENDA_VIEWS).map(modeLabel), modeLabel(agendaState.mode), (label) => {
      agendaState.mode = label === modeLabel("scheduling") ? "scheduling" : "confirmed";
      agendaState.filter = "All";
      load();
    }),
    segmented(filters, agendaState.filter, (value) => {
      agendaState.filter = value;
      load();
    }),
    segmented(["By day", "Flat"], agendaState.grouped ? "By day" : "Flat", (value) => {
      agendaState.grouped = value === "By day";
      load();
    }),
  );
  // The one primary action on the screen, and only on the view that has work in
  // it. "What's confirmed" is the record, not the work.
  if (agendaState.mode === "scheduling") {
    const primary = document.createElement("button");
    primary.className = "primary";
    primary.type = "button";
    primary.textContent = "+ Session";
    primary.disabled = true;
    primary.title = "Entering a session by hand is the campaign page's, one slice up.";
    controls.append(primary);
  }
  section.append(controls);

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = view.empty;
    section.append(empty);
  } else {
    section.append(agendaTable(rows));
  }

  const asOf = document.createElement("p");
  asOf.className = "muted as-of";
  asOf.textContent = `As of ${when(agenda.asOf)}.`;
  section.append(asOf);

  return section;
}

function modeLabel(mode) {
  return AGENDA_VIEWS[mode].title;
}

function gameDaysTable(days) {
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = days.length === 1 ? "1 game day" : `${days.length} game days`;
  table.append(caption);

  const head = document.createElement("tr");
  for (const [label, className] of [
    ["Day", ""],
    ["State", ""],
    ["When", ""],
    ["Venue", ""],
    ["Seated", "numeric"],
    ["Waiting", "numeric"],
    ["", ""],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const day of days) {
    const row = document.createElement("tr");

    const name = cell(row, text(day.gameName ?? day.title ?? "Game day"));
    const id = document.createElement("div");
    id.className = "muted";
    id.textContent = `${day.kind} · ${day.id}`;
    name.append(id);

    const state = cell(row, day.state);
    state.className = "state";
    state.dataset.state = day.state;

    cell(row, when(day.startsAt));
    cell(row, text(day.venue));
    // The seat count as the day itself knows it, never as the post shows it.
    cell(row, day.capacity ? `${day.seated}/${day.capacity}` : String(day.seated), "numeric");
    cell(row, String(day.waitlisted), "numeric");
    dayLifecycleCell(row, day);

    body.append(row);
  }
  table.append(body);
  return table;
}

/** What a day in this state may do next. `src/game-days/lifecycle.ts` holds the
 *  map that decides; this is the same shape, for buttons. */
const DAY_NEXT = {
  PROPOSED: [
    ["SEATING", "Open seating"],
    ["CANCELLED", "Call it off"],
  ],
  SEATING: [
    ["LOCKED", "Lock now"],
    ["CANCELLED", "Call it off"],
  ],
  LOCKED: [["CANCELLED", "Call it off"]],
  PLAYED: [],
  CANCELLED: [],
};

function dayLifecycleCell(row, day) {
  const td = document.createElement("td");
  for (const [to, label] of DAY_NEXT[day.state] ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      // Opening seating posts a message nobody can unpost, and calling a day off
      // is the end of it. Both are worth one sentence of friction.
      const name = day.gameName ?? day.title ?? "this day";
      if (!confirm(`${label} — ${name}?`)) return;

      button.disabled = true;
      await act(() =>
        api(`/api/game-days/${encodeURIComponent(day.id)}/transition`, {
          method: "POST",
          body: JSON.stringify({ to }),
        }),
      );
    });
    buttons.push(button);
  }
  return buttons;
}

/** What a campaign in this state may do next. The map that says so lives in
 *  `src/campaigns/lifecycle.ts`; this is the same shape, for buttons. */
const NEXT = {
  FORMING: [["RUNNING", "Start"]],
  RUNNING: [
    ["HIATUS", "Pause"],
    ["CONCLUDED", "Conclude"],
  ],
  HIATUS: [
    ["RUNNING", "Resume"],
    ["CONCLUDED", "Conclude"],
  ],
  CONCLUDED: [],
};

function lifecycleCell(row, campaign) {
  const td = document.createElement("td");
  td.append(...lifecycleButtons(campaign));
  row.append(td);
}

/**
 * The edges a campaign may take, as buttons.
 *
 * Split out of the cell so the campaign page offers exactly the same ones. Two
 * places offering different transitions for one campaign is how a console grows
 * a second, wrong copy of the lifecycle.
 */
function lifecycleButtons(campaign) {
  const buttons = [];
  for (const [to, label] of NEXT[campaign.state] ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      // Concluding is terminal and starting closes the roster for good. Both are
      // worth one sentence of friction.
      const grave = to === "CONCLUDED" || to === "RUNNING";
      if (grave && !confirm(`${label} ${campaign.name}?`)) return;

      button.disabled = true;
      await act(() =>
        api(`/api/campaigns/${encodeURIComponent(campaign.id)}/transition`, {
          method: "POST",
          body: JSON.stringify({ to }),
        }),
      );
    });
    td.append(button);
  }
  row.append(td);
}

const FIELDS = [
  ["name", "Name", "text"],
  ["kind", "Kind", "text"],
  ["gameId", "Game id", "text"],
  ["discordChannelId", "Channel id", "text"],
  ["discordRoleId", "Role id", "text"],
  ["recurrenceAnchor", "Anchor (unix seconds)", "number"],
  ["intervalWeeks", "Interval (weeks)", "number"],
  ["quorum", "Quorum", "number"],
  ["capacity", "Capacity", "number"],
  ["maxSessions", "Max sessions", "number"],
  ["firstSessionNumber", "First session number", "number"],
];

function createForm() {
  const form = document.createElement("form");
  form.className = "stack";

  const legend = document.createElement("h2");
  legend.textContent = "New campaign";
  form.append(legend);

  for (const [name, label, type] of FIELDS) {
    const wrap = document.createElement("label");
    wrap.textContent = label;
    const input = document.createElement("input");
    input.name = name;
    input.type = type;
    if (name === "kind") input.placeholder = "run, play or tracked";
    wrap.append(input);
    form.append(wrap);
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Create";
  form.append(submit);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;

    const body = {};
    for (const [name, , type] of FIELDS) {
      const raw = form.elements[name].value.trim();
      // An empty box is a field this form says nothing about, which is what the
      // API reads `undefined` as. It is not "set this to nothing".
      if (raw === "") continue;
      body[name] = type === "number" ? Number(raw) : raw;
    }

    await act(() => api("/api/campaigns", { method: "POST", body: JSON.stringify(body) }));
  });

  return form;
}

/** Do it, then re-read. The page is a view of D1, never of what it just sent. */
async function act(work) {
  try {
    await work();
    await load();
  } catch (error) {
    const p = document.createElement("p");
    p.className = error instanceof Refusal ? "note" : "error";
    p.textContent =
      error instanceof Refusal ? error.message : "Orrey could not do that. Try again.";
    main.prepend(p);
    if (!(error instanceof Refusal)) console.error(error);
  }
}

/** Which campaign's page is open, if any. None, until a name is clicked. */
const campaignState = { selected: null };

/**
 * One campaign's plan.
 *
 * Where it is and where it may go, what it runs on, who is on it, and what is
 * coming — and, when nothing is coming, the sentence saying which of several
 * reasons that is. An empty table under a heading is the one thing this must
 * never render.
 */
function campaignPageSection(plan, history, polls) {
  const section = document.createElement("section");
  section.className = "campaign-page";

  const title = document.createElement("h3");
  title.textContent = plan.name;
  const state = document.createElement("span");
  state.className = "state";
  state.dataset.state = plan.state;
  state.textContent = plan.state;
  title.append(" ", state);
  section.append(title);

  const actions = document.createElement("p");
  actions.append(...lifecycleButtons(plan));
  if (actions.childElementCount > 0) section.append(actions);

  section.append(campaignFacts(plan), subheading("Roster"), memberList(plan.roster));
  section.append(subheading("Coming up"));

  if (plan.upcoming.length === 0) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = plan.upcomingNote;
    section.append(note);
  } else {
    section.append(upcomingTable(plan.upcoming));
  }

  if (history) section.append(historySection(history));
  if (polls) section.append(pollsSection(polls));

  return section;
}

function campaignFacts(plan) {
  const list = document.createElement("dl");
  list.className = "facts";
  const facts = [
    ["Game", text(plan.gameName ?? plan.gameId)],
    ["Cadence", cadence({ intervalWeeks: plan.cadence.intervalWeeks, recurrenceAnchor: plan.cadence.anchor })],
    ["Quorum", text(plan.quorum)],
    ["Capacity", text(plan.capacity)],
    ["Sessions left", plan.maxSessions === null ? "open-ended" : String(plan.remaining)],
    ["Numbering from", String(plan.firstSessionNumber)],
  ];
  for (const [label, value] of facts) {
    const term = document.createElement("dt");
    term.textContent = label;
    const said = document.createElement("dd");
    said.textContent = value;
    list.append(term, said);
  }
  if (plan.channelUrl) {
    const term = document.createElement("dt");
    term.textContent = "Channel";
    const said = document.createElement("dd");
    const link = document.createElement("a");
    link.href = plan.channelUrl;
    link.rel = "noreferrer";
    link.target = "_blank";
    link.textContent = "Open in Discord";
    said.append(link);
    list.append(term, said);
  }
  return list;
}

/**
 * Who is on it.
 *
 * Not `rosterList`: that one is a *session's* roster and its second column is
 * what each person said about that session. A campaign's roster has no intent to
 * show, and reusing the shape would print "not heard from" beside people who
 * were never asked anything.
 */
function memberList(roster) {
  if (roster.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "Nobody on it yet.";
    return empty;
  }
  const list = document.createElement("dl");
  list.className = "roster";
  for (const member of roster) {
    const name = document.createElement("dt");
    name.textContent = member.name;
    const said = document.createElement("dd");
    // Null role means a claimant: nobody is GM of a campaign that has not started.
    said.textContent = [member.role ?? "claimed a place", member.characterName]
      .filter(Boolean)
      .join(" · ");
    list.append(name, said);
  }
  return list;
}

function upcomingTable(rows) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["When", "Session", "Responses", "Status", "Calendar"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    // The rail is the one place a session is read in full, wherever it was
    // clicked from.
    tr.addEventListener("click", () => {
      agendaState.selected = row.sessionId;
      load();
    });

    // The day label comes from the server, in the guild's zone: two people in
    // two zones must not see a session fall on different days.
    cell(tr, `${row.dayLabel}, ${time(row.startsAt)}`);
    const title = cell(tr, row.title);
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = text(row.location);
    title.append(sub);

    tr.append(quorumMeter(row));

    const state = cell(tr, row.state);
    state.className = "state";
    state.dataset.state = row.state;

    const sync = document.createElement("td");
    sync.append(syncLog(row.sync));
    tr.append(sync);

    body.append(tr);
  }
  table.append(body);
  return table;
}

/**
 * What the campaign has already done, and what that implies.
 *
 * The two tables are one section on purpose: every number in the first is
 * counted from the second, and a streak shown without the sessions it came from
 * is a number nobody can check. Flake memory is information for the organiser
 * and never an automatic consequence — nothing reads it back.
 */
function historySection(history) {
  const section = document.createElement("section");
  section.append(subheading("Record"));

  if (history.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = history.note;
    section.append(note);
  }

  if (history.members.length > 0) section.append(recordTable(history.members));
  if (history.sessions.length > 0) section.append(playedTable(history.sessions));
  return section;
}

function recordTable(members) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const [label, className] of [
    ["Player", ""],
    ["Came", "numeric"],
    ["Of", "numeric"],
    ["Rate", "numeric"],
    ["Said in, missed", "numeric"],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const member of members) {
    const tr = document.createElement("tr");
    cell(tr, member.name);
    cell(tr, String(member.attended), "numeric");
    cell(tr, String(member.played), "numeric");
    // No number at all below the threshold: "1 of 2" reads as a judgement
    // rather than as the shrug it should be.
    cell(tr, member.rate === null ? "—" : `${Math.round(member.rate * 100)}%`, "numeric");
    cell(tr, member.noShowStreak === 0 ? "—" : String(member.noShowStreak), "numeric");
    body.append(tr);
  }
  table.append(body);
  return table;
}

function playedTable(sessions) {
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = "What the numbers were counted from";
  table.append(caption);

  const head = document.createElement("tr");
  for (const [label, className] of [
    ["When", ""],
    ["Session", ""],
    ["Came", "numeric"],
    ["Missed", "numeric"],
    ["No register", "numeric"],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  for (const played of sessions) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.addEventListener("click", () => {
      agendaState.selected = played.sessionId;
      load();
    });
    cell(tr, when(played.startsAt));
    const title = cell(tr, played.number === null ? played.sessionId : `Session ${played.number}`);
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = text(played.location);
    title.append(sub);
    cell(tr, String(played.came), "numeric");
    cell(tr, String(played.missed), "numeric");
    // Never folded into "missed": nobody wrote the register is not the same
    // answer as they did not turn up.
    cell(tr, played.unrecorded === 0 ? "—" : String(played.unrecorded), "numeric");
    body.append(tr);
  }
  table.append(body);
  return table;
}

const WAITING = {
  responses: "Waiting on responses.",
  gm: "Past its threshold, but not on a night the GM has marked available. Waiting on the GM.",
  organiser: "Ready. Canonise is on the poll post — this page only shows it.",
};

/**
 * The campaign's open date polls, and the one boolean beside them.
 *
 * Every row ends at a link to the post. Canonise is not here and is not in phase
 * 6: it is an organiser-only button on the poll post, and a second way to reach
 * the same decision would put it behind two different confirmations.
 */
function pollsSection(polls) {
  const section = document.createElement("section");
  section.append(subheading("Date polls"));
  section.append(autoResolveToggle(polls));

  if (polls.polls.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No open polls.";
    section.append(empty);
    return section;
  }

  for (const poll of polls.polls) section.append(pollCard(poll));
  return section;
}

function autoResolveToggle(polls) {
  const wrap = document.createElement("p");
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = polls.autoResolvePolls;
  box.addEventListener("change", async () => {
    box.disabled = true;
    await act(() =>
      api(`/api/campaigns/${encodeURIComponent(campaignState.selected)}`, {
        method: "PATCH",
        body: JSON.stringify({ autoResolvePolls: box.checked }),
      }),
    );
  });
  label.append(box, document.createTextNode(" Resolve polls automatically"));
  wrap.append(label);

  // The constraint in the copy and not only in the code. A control labelled
  // "resolve polls automatically" that quietly does something narrower is a
  // control somebody turns on and then blames for the wrong thing.
  const caveat = document.createElement("span");
  caveat.className = "note";
  caveat.textContent =
    " — only onto a date the GM has marked available, and only for a rule with a fixed bar.";
  wrap.append(caveat);
  return wrap;
}

function pollCard(poll) {
  const card = document.createElement("article");
  card.className = "poll";

  const line = document.createElement("p");
  line.textContent = [
    poll.winRule.replace(/_/g, " "),
    poll.required === null ? null : `needs ${poll.required}`,
    `${poll.rosterSize} on the roster`,
  ]
    .filter(Boolean)
    .join(" · ");
  card.append(line);

  const waiting = document.createElement("p");
  waiting.className = "note";
  waiting.textContent = WAITING[poll.waitingOn];
  card.append(waiting);

  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const [label, className] of [
    ["Date", ""],
    ["Yes", "numeric"],
    ["GM", ""],
    ["", ""],
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  table.append(thead);

  const body = document.createElement("tbody");
  const proposed = new Set(poll.proposed);
  for (const date of poll.dates) {
    const tr = document.createElement("tr");
    cell(tr, when(date.startsAt));
    cell(tr, String(date.yes), "numeric");
    // Null is "nobody was asked" — a campaign with no GM is a real state, and
    // rendering it as a refusal blames somebody who does not exist.
    cell(tr, date.gmAvailable === null ? "no GM" : date.gmAvailable ? "yes" : "—");
    cell(tr, proposed.has(date.pollDateId) ? "proposed" : "");
    body.append(tr);
  }
  table.append(body);
  card.append(table);

  if (poll.postUrl) {
    const links = document.createElement("p");
    const link = document.createElement("a");
    link.href = poll.postUrl;
    link.rel = "noreferrer";
    link.target = "_blank";
    link.textContent = "Open the poll post";
    links.append(link);
    card.append(links);
  }

  return card;
}

function subheading(label) {
  const h = document.createElement("h4");
  h.textContent = label;
  return h;
}

/**
 * Who is holding this game.
 *
 * Shown in the row rather than only in the refusal, so the cost of a delete is
 * legible before anybody reaches for it.
 */
function heldBy(row, game) {
  const usage = game.usage;
  if (!usage) return cell(row, "—");

  const names = usage.campaigns.map((held) => held.name);
  if (usage.gameDays > 0) {
    names.push(`${usage.gameDays} game ${usage.gameDays === 1 ? "day" : "days"}`);
  }
  const td = cell(row, names.length === 0 ? "nobody" : names.join(", "));
  if (names.length === 0) td.className = "muted";
  return td;
}

function gameActions(row, game) {
  const td = document.createElement("td");
  const usage = game.usage;
  // No button at all while somebody holds it. The server refuses either way —
  // the guard is a query there, not in here — but offering a button that always
  // refuses trains people to ignore refusals.
  if (usage && usage.campaigns.length === 0 && usage.gameDays === 0) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${game.name}?`)) return;
      remove.disabled = true;
      await act(() => api(`/api/games/${encodeURIComponent(game.id)}`, { method: "DELETE" }));
    });
    td.append(remove);
  }
  row.append(td);
}

function heading(label) {
  const h = document.createElement("h2");
  h.textContent = label;
  return h;
}

async function load() {
  try {
    const [me, agenda, { campaigns }, { games }, { gameDays }] = await Promise.all([
      api("/api/me"),
      api("/api/agenda"),
      api("/api/campaigns"),
      // The admin list rather than the plain summaries: this page offers a
      // delete, and a delete needs to know what it would break.
      api("/api/games/usage"),
      api("/api/game-days"),
    ]);

    // The rail is a second read rather than part of the agenda's: one session's
    // roster is not something the list needs, and asking for it per row would be
    // a query per row.
    const detail = agendaState.selected
      ? await api(`/api/sessions/${encodeURIComponent(agendaState.selected)}`).catch(() => null)
      : null;

    // Likewise the campaign page: the summaries table needs none of it, and a
    // campaign nobody has opened is a query nobody has asked for.
    const [plan, history, polls] = campaignState.selected
      ? await Promise.all([
          api(`/api/campaigns/${encodeURIComponent(campaignState.selected)}/page`).catch(
            () => null,
          ),
          api(`/api/campaigns/${encodeURIComponent(campaignState.selected)}/history`).catch(
            () => null,
          ),
          api(`/api/campaigns/${encodeURIComponent(campaignState.selected)}/polls`).catch(
            () => null,
          ),
        ])
      : [null, null, null];

    who.textContent = `signed in as ${me.userId}`;
    const split = document.createElement("div");
    split.className = "split";
    split.append(agendaSection(agenda), detailRail(detail));
    main.replaceChildren(split);
    main.append(heading("Campaigns"), campaignsTable(campaigns));
    if (plan) main.append(campaignPageSection(plan.campaign, history, polls));
    main.append(heading("Game days"), gameDaysTable(gameDays));
    main.append(heading("Games"), gamesTable(games), createForm());
  } catch (error) {
    const message =
      error instanceof Refusal ? error.message : "Orrey could not load that. Try again.";
    const p = document.createElement("p");
    p.className = error instanceof Refusal ? "note" : "error";
    p.textContent = message;
    main.replaceChildren(p);
    if (!(error instanceof Refusal)) console.error(error);
  } finally {
    main.setAttribute("aria-busy", "false");
    if (status.isConnected) status.remove();
  }
}

load();


