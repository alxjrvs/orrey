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

/**
 * The month the grid is showing, as a year and a 1-12 month.
 *
 * Held rather than derived from the clock so that stepping between months is a
 * state change and not a second kind of navigation.
 */
const monthState = { year: null, month: null };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A month, seven columns wide and always six rows deep.
 *
 * Six whatever the month would have fitted in: a grid that changes height when
 * somebody steps between months is one people misclick.
 *
 * There is no design for this screen — `design/readme.md` lists it under "Open
 * questions for the author" as not drawn — so it uses existing tokens only: the
 * `--campaign-1..5` identity colours as swatches, and no new component.
 */
function monthSection(month) {
  const section = document.createElement("section");

  const controls = document.createElement("p");
  controls.className = "month-controls";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "←";
  back.addEventListener("click", () => step(-1));
  const label = document.createElement("span");
  label.textContent = `${MONTHS[month.month - 1]} ${month.year}`;
  const forward = document.createElement("button");
  forward.type = "button";
  forward.textContent = "→";
  forward.addEventListener("click", () => step(1));
  controls.append(back, label, forward);
  section.append(controls);

  const grid = document.createElement("div");
  grid.className = "month";

  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    const head = document.createElement("div");
    head.className = "month-head";
    head.textContent = day;
    grid.append(head);
  }

  for (const week of month.weeks) {
    for (const cell of week) {
      const box = document.createElement("div");
      box.className = "month-cell";
      // Shown, because the grid draws it — but never dressed up as this month.
      if (!cell.inMonth) box.dataset.outside = "true";

      const number = document.createElement("div");
      number.className = "month-number";
      number.textContent = String(Number(cell.day.slice(8)));
      box.append(number);

      for (const row of cell.sessions) {
        const pip = document.createElement("button");
        pip.type = "button";
        pip.className = "pip";
        // The identity colour is assigned per campaign and never reused as UI.
        pip.style.background = `var(--campaign-${swatch(row.campaignId ?? row.gameDayId)})`;
        pip.title = row.title;
        pip.textContent = row.title;
        // The session rail arrives in `p6/3`, on the other side of this fork.
        // Until both are in main this selects and nothing opens, which is the
        // same gap the agenda has and not a reason to serialise the two.
        pip.addEventListener("click", () => {
          monthState.selected = row.sessionId;
        });
        box.append(pip);
      }

      grid.append(box);
    }
  }

  section.append(grid);
  return section;
}

/** Five identity colours, assigned by id so one campaign keeps one colour. */
function swatch(id) {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) % 5;
  return hash + 1;
}

function step(by) {
  const index = monthState.year * 12 + (monthState.month - 1) + by;
  monthState.year = Math.floor(index / 12);
  monthState.month = (index % 12) + 1;
  load();
}

function heading(label) {
  const h = document.createElement("h2");
  h.textContent = label;
  return h;
}

async function load() {
  try {
    if (monthState.year === null) {
      // The browser's month is the right one to open on: it is the reader's
      // "now". Which cell a session falls in is the guild's business, and the
      // server has already decided that.
      const today = new Date();
      monthState.year = today.getFullYear();
      monthState.month = today.getMonth() + 1;
    }

    const [me, { campaigns }, { games }, { gameDays }, month] = await Promise.all([
      api("/api/me"),
      api("/api/campaigns"),
      api("/api/games"),
      api("/api/game-days"),
      api(`/api/month/${monthState.year}/${monthState.month}`).catch(() => null),
    ]);

    who.textContent = `signed in as ${me.userId}`;
    main.replaceChildren(heading("Month"));
    if (month) main.append(monthSection(month));
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
