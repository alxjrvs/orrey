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

    const name = cell(row, campaign.name);
    const id = document.createElement("div");
    id.className = "muted";
    id.textContent = campaign.id;
    name.append(id);

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
      // Nothing to select into until the detail rail lands. Rather than link to
      // a page that does not exist, this marks the row and stops.
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
    td.append(button);
  }
  row.append(td);
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
      api("/api/games"),
      api("/api/game-days"),
    ]);

    who.textContent = `signed in as ${me.userId}`;
    main.replaceChildren(agendaSection(agenda));
    main.append(heading("Campaigns"), campaignsTable(campaigns));
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
