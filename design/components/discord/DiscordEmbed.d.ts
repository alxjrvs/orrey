import * as React from 'react';

/**
 * Orrey's post body in Discord. Every embed carries an as-of line, because posts are snapshots.
 */
export interface EmbedField { name: React.ReactNode; value: React.ReactNode; inline?: boolean }
export interface DiscordEmbedProps extends React.HTMLAttributes<HTMLDivElement> {
  /** left accent bar — the campaign's identity colour */
  color?: string;
  title?: React.ReactNode;
  /** renders the title as a link */
  url?: boolean;
  description?: React.ReactNode;
  fields?: EmbedField[];
  /** required on anything with a tally: "as of 19:02" */
  asOf?: React.ReactNode;
  footer?: React.ReactNode;
}
export declare function DiscordEmbed(props: DiscordEmbedProps): JSX.Element;
