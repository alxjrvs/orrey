export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  /** The one write Orrey is allowed to make to an existing message. */
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const MessageFlags = { EPHEMERAL: 1 << 6, IS_COMPONENTS_V2: 1 << 15 } as const;

export interface InteractionUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: InteractionUser; roles: string[]; nick?: string | null };
  user?: InteractionUser;
  message?: { id: string; channel_id: string };
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: { name: string; value: string | number | boolean; focused?: boolean }[];
  };
}

export function actorOf(interaction: Interaction): InteractionUser | undefined {
  return interaction.member?.user ?? interaction.user;
}
