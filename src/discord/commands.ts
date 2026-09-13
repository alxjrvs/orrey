/**
 * The whole command surface. Four commands, all read-or-initiate, all ephemeral.
 * Administration lives in the console — that is what keeps this list at four.
 *
 * Registering this set with a bulk overwrite is also what makes Hermuz's
 * commands (/task, /meal, …) cease to exist.
 */

const CHAT_INPUT = 1;
const STRING = 3;

export const commands = [
  {
    name: "upcoming",
    description: "Everything on the calendar, for you, right now.",
    type: CHAT_INPUT,
  },
  {
    name: "reschedule",
    description: "Suggest another day for an upcoming session or game day.",
    type: CHAT_INPUT,
    options: [
      {
        name: "event",
        description: "Which event?",
        type: STRING,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "whos-in",
    description: "Who is in, out and unheard-from — authoritative, not a snapshot.",
    type: CHAT_INPUT,
    options: [
      {
        name: "event",
        description: "Which event? Defaults to the next one you are on the roster for.",
        type: STRING,
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: "console",
    description: "A login link for the Orrey console.",
    type: CHAT_INPUT,
  },
] as const;
