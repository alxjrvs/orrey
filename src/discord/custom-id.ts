/**
 * Component ids are namespaced and versioned so that Hermuz's old posts —
 * whose ids Orrey knows nothing about — fall through to the retired-post
 * handler instead of showing "interaction failed".
 *
 *   o1:attend:in:<sessionId>
 *   ^  ^      ^   ^
 *   |  |      |   target id
 *   |  |      argument
 *   |  action
 *   namespace + schema version
 */
export const NAMESPACE = "o1";

export interface CustomId {
  action: string;
  arg?: string;
  target?: string;
}

export function encodeCustomId({ action, arg, target }: CustomId): string {
  const id = [NAMESPACE, action, arg ?? "", target ?? ""].join(":").replace(/:+$/, "");
  if (id.length > 100) throw new Error(`custom_id too long: ${id}`);
  return id;
}

/** Returns undefined for anything Orrey did not mint — including every Hermuz id. */
export function decodeCustomId(raw: string): CustomId | undefined {
  const [ns, action, arg, target] = raw.split(":");
  if (ns !== NAMESPACE || !action) return undefined;
  return {
    action,
    ...(arg ? { arg } : {}),
    ...(target ? { target } : {}),
  };
}
