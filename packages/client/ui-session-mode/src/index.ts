/**
 * Web new-session mode picker plugin, node half.
 *
 * Deliberately empty: the mode picker and its model seat are pure host-UI
 * capabilities and register only through the client half (`src/client`). There
 * is no server/agent surface — `session.create` already accepts and validates
 * `mode` at the host gate (task 3), and the external-session registry answers
 * the provider/model catalog. Keeping the node half empty avoids claiming any
 * global agent-visible surface.
 */

/** Host plugin body — the mode picker is client-only. */
export function apply(): void {}
