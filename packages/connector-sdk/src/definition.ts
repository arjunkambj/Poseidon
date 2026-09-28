/**
 * What a connector is, from the server's point of view.
 *
 * A connector is the only thing in Poseidon that knows a particular coding
 * harness exists. It owns its own configuration schema, it knows how to find
 * and probe its binary, and it turns whatever that binary does into the
 * `RuntimeEvent` vocabulary in `@poseidon/contracts/runtime`. Nothing above this
 * boundary — the orchestration engine, the projections, the renderer — is
 * allowed to know which harness is running.
 *
 * The type parameter `Config` is the connector's own settings document. It is
 * invariant (it appears as both an argument and a result), so a heterogeneous
 * list of connectors cannot be typed directly; `eraseConnectorDefinition`
 * exists for exactly that and validates `unknown` configuration through the
 * connector's own schema on the way in.
 */

import type { InteractionMode, RuntimeMode } from "@poseidon/contracts/enums";
import type { ApprovalRequest, ConnectorCapabilities } from "@poseidon/contracts/runtime";
import type {
  ConnectorInstanceId,
  ConnectorKind,
  ProjectId,
  ThreadId,
  TurnId,
} from "@poseidon/contracts/ids";
import type {
  Attachment,
  Mention,
  ThreadSettings,
  TurnReference,
} from "@poseidon/contracts/orchestration";
import type {
  ConnectorConfigField,
  ConnectorMetadata,
  ConnectorProbe as WireConnectorProbe,
  ModelOption,
} from "@poseidon/contracts/connectors";
import { settingsFormFields } from "@poseidon/contracts/settings";
import type { UnknownRecord } from "@poseidon/contracts/base";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Clock from "effect/Clock";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import type { ConnectorExtensions } from "./extensions";
import type { SessionPlugin } from "./plugins";
import type { SessionHandle } from "./sessionHandle";

// ── Errors ─────────────────────────────────────────────────────

/** The connector's binary could not be found, run, or interrogated. */
export class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
  readonly kind: ConnectorKind;
  readonly message: string;
}> {}

/** A session could not be started: the process refused to start, or died at once. */
export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly kind: ConnectorKind;
  readonly instanceId: ConnectorInstanceId;
  readonly message: string;
}> {}

/**
 * A turn was sent while one was already running on a handle whose harness
 * cannot be steered mid-turn. The caller's recourse is to queue the message,
 * which is what `thread.turn.start { queued: true }` is for.
 */
export class TurnInProgress extends Data.TaggedError("TurnInProgress")<{
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | null;
}> {}

/**
 * A message could not be delivered into a running turn: the turn named is not
 * the one running, or the handle's harness has no way to take a message
 * mid-turn. The caller's recourse is the queue, so the message is never lost.
 */
export class NotSteerable extends Data.TaggedError("NotSteerable")<{
  readonly threadId: ThreadId;
  readonly reason: string;
}> {}

/** The handle was used after `close()`, or after the harness process went away. */
export class SessionClosed extends Data.TaggedError("SessionClosed")<{
  readonly threadId: ThreadId;
}> {}

/**
 * No definition is registered for a kind, or no live instance for an id. The
 * registry routes by instance id, so this is what a thread bound to a connector
 * that has since been removed from settings fails with.
 */
export class ConnectorNotFound extends Data.TaggedError("ConnectorNotFound")<{
  readonly instanceId: ConnectorInstanceId | null;
  readonly kind: ConnectorKind | null;
}> {}

/** Everything a connector is allowed to fail with. */
export type ConnectorError =
  | ProbeFailed
  | SpawnFailed
  | TurnInProgress
  | NotSteerable
  | SessionClosed
  | ConnectorNotFound;

// ── Probe ──────────────────────────────────────────────────────

/** Whether the harness has usable credentials. `unknown` means the probe could not tell. */
export type ConnectorAuthState = "present" | "absent" | "unknown";

/**
 * The full result of a probe. It is a superset of the wire `ConnectorProbe`
 * that the connectors page renders: the server keeps `models` to seed the model
 * picker without a second round trip, and `warnings` to surface a too-old
 * binary without failing the probe outright. `toWireProbe` narrows it.
 *
 * `installed` is whether the harness resolved at all — true once a binary (or
 * whatever the connector runs) was found, even if it then refused. The wire's
 * `authenticated` is derived from `auth`, so a connector states credentials
 * once. `loginCommand` and `installCommand` are the commands this harness's own
 * output or docs name for signing in and installing; a connector leaves one
 * out rather than guess it, and the renderer shows whichever it is given.
 */
export interface ConnectorProbe extends Omit<WireConnectorProbe, "authenticated"> {
  readonly installed: boolean;
  readonly auth: ConnectorAuthState;
  readonly account?: string;
  readonly loginCommand?: string;
  readonly installCommand?: string;
  readonly models: ReadonlyArray<ModelOption>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Drops the server-only fields, leaving the shape `ConnectorSummary.probe` carries.
 * `auth`, `account` and the model count cross the wire — the connectors page
 * renders them; `models` and `warnings` stay server-side. `authenticated` is
 * `auth` as a boolean, left out when the probe could not tell.
 */
export const toWireProbe = (probe: ConnectorProbe): WireConnectorProbe => ({
  status: probe.status,
  probedAt: probe.probedAt,
  installed: probe.installed,
  auth: probe.auth,
  ...(probe.auth === "unknown" ? {} : { authenticated: probe.auth === "present" }),
  modelCount: probe.models.length,
  ...(probe.binaryPath === undefined ? {} : { binaryPath: probe.binaryPath }),
  ...(probe.version === undefined ? {} : { version: probe.version }),
  ...(probe.account === undefined ? {} : { account: probe.account }),
  ...(probe.loginCommand === undefined ? {} : { loginCommand: probe.loginCommand }),
  ...(probe.installCommand === undefined ? {} : { installCommand: probe.installCommand }),
  ...(probe.helpUrl === undefined ? {} : { helpUrl: probe.helpUrl }),
  ...(probe.message === undefined ? {} : { message: probe.message }),
});

// ── Services handed to a connector ─────────────────────────────

/** A loopback endpoint the server runs for one thread, with its per-session bearer. */
export interface ConnectorEndpoint {
  readonly url: string;
  readonly bearer: string;
}

/** What the permission engine answers for one tool call. */
export type PermissionDecision = "allow" | "prompt" | "deny";

/**
 * `decide` gets the thread's live modes along with the request: the ladder's
 * outcome depends on `runtimeMode`/`interactionMode`, and the server scopes
 * rules by `threadId` — a per-instance `services` object cannot know which
 * thread asked.
 */
export interface ConnectorPermissions {
  readonly decide: (input: {
    readonly request: ApprovalRequest;
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: InteractionMode;
  }) => Effect.Effect<PermissionDecision>;
}

export type ConnectorLogLevel = "debug" | "info" | "warn" | "error";

/**
 * The connector's log sink. Deliberately not Effect's `Logger`: a connector
 * logs on behalf of a session, and the server wants those lines annotated with
 * the thread they came from rather than merged into the process log.
 */
export interface ConnectorLogger {
  readonly log: (
    level: ConnectorLogLevel,
    message: string,
    data?: UnknownRecord,
  ) => Effect.Effect<void>;
}

/**
 * Everything the server lends a connector. The two endpoints are our own
 * loopback servers — the MCP server we expose to the harness, and the hook
 * bridge the approval flow runs through — handed out per thread so a bearer
 * never outlives the session it was minted for.
 */
export interface ConnectorServices {
  readonly mcpEndpoint: (threadId: ThreadId) => Effect.Effect<ConnectorEndpoint>;
  readonly hookEndpoint: (threadId: ThreadId) => Effect.Effect<ConnectorEndpoint>;
  /**
   * Registers the function that answers hook posts for a thread's session.
   * Optional: a services implementation without a hook bridge (tests, fakes)
   * simply leaves it out and the connector skips registration.
   */
  readonly registerHookHandler?: (
    threadId: ThreadId,
    handler: (body: unknown) => Effect.Effect<unknown>,
  ) => Effect.Effect<void>;
  readonly unregisterHookHandler?: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * The Poseidon plugins enabled for a thread's session, read when the
   * session starts, so switching a plugin affects new sessions only. Optional:
   * a services implementation without a plugin registry (tests, fakes) leaves
   * it out, and a connector that ignores it simply loads no plugins.
   */
  readonly sessionPlugins?: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<SessionPlugin>>;
  readonly permissions: ConnectorPermissions;
  readonly attachmentsDir: string;
  readonly logger: ConnectorLogger;
  readonly clock: Clock.Clock;
}

// ── Session inputs ─────────────────────────────────────────────

/** One user turn, as the composer produced it. */
export interface TurnInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: ReadonlyArray<Mention>;
  /**
   * The skills and plugins the user picked from the composer. Each connector
   * decides how a reference reaches its harness in the prompt. Optional, so a
   * caller with nothing to reference may leave it out; absent means none.
   */
  readonly references?: ReadonlyArray<TurnReference>;
}

/** Everything needed to start a fresh session for a thread. */
export interface StartSessionInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /**
   * The thread's settings. Its `connectorInstanceId`, when present, only says
   * how the server routed the thread here; a connector has nothing to do with it.
   */
  readonly settings: ThreadSettings;
}

/**
 * Resuming adds the opaque `sessionRef` the connector emitted on
 * `session.started` and the server persisted. A connector that cannot make
 * sense of the ref any more starts fresh and says so with `session.warning`.
 */
export interface ResumeSessionInput extends StartSessionInput {
  readonly sessionRef: unknown;
}

// ── Instance and definition ────────────────────────────────────

/**
 * One configured connector, live. Instances are per configuration, not per
 * thread: a thread gets a `SessionHandle` from an instance, and the registry
 * routes to the instance by id so two differently configured instances of the
 * same kind never collide.
 */
export interface ConnectorInstance {
  readonly instanceId: ConnectorInstanceId;
  readonly kind: ConnectorKind;
  readonly capabilities: ConnectorCapabilities;
  readonly startSession: (
    input: StartSessionInput,
  ) => Effect.Effect<SessionHandle, ConnectorError, Scope.Scope>;
  readonly resumeSession: (
    input: ResumeSessionInput,
  ) => Effect.Effect<SessionHandle, ConnectorError, Scope.Scope>;
  readonly listModels: () => Effect.Effect<ReadonlyArray<ModelOption>, ConnectorError>;
  /**
   * The harness configuration this instance manages for the Customize page —
   * skills, MCP servers. Absent for a harness that keeps none (`extensions.ts`).
   */
  readonly extensions?: ConnectorExtensions;
}

export interface CreateInstanceInput<Config> {
  readonly instanceId: ConnectorInstanceId;
  readonly config: Config;
  readonly services: ConnectorServices;
}

/**
 * A connector's config schema. It has to be a struct: its fields, through
 * their `settingsForm` annotations, are the form the connectors page renders
 * for an instance, so the renderer needs no connector-specific markup.
 */
export type ConnectorConfigSchema<Config> = Schema.Codec<Config, unknown> & {
  readonly fields: Schema.Struct.Fields;
};

/**
 * A connector, as its package exports it. `metadata` is how it presents itself
 * — name, icon key, accent, docs link — so no layer above the connector has to
 * know any of it.
 */
export interface ConnectorDefinition<Config> {
  readonly kind: ConnectorKind;
  readonly metadata: ConnectorMetadata;
  readonly configSchema: ConnectorConfigSchema<Config>;
  readonly defaultConfig: () => Config;
  readonly probe: (config: Config) => Effect.Effect<ConnectorProbe, ProbeFailed>;
  readonly createInstance: (
    input: CreateInstanceInput<Config>,
  ) => Effect.Effect<ConnectorInstance, ConnectorError, Scope.Scope>;
}

/**
 * A definition with its configuration type erased, which is the only way a
 * list of connectors can be held together. Configuration arrives from the
 * settings document as `unknown` anyway, so erasing is not a loss: it moves the
 * validation to the boundary where the untyped value actually enters.
 */
export interface AnyConnectorDefinition {
  readonly kind: ConnectorKind;
  readonly metadata: ConnectorMetadata;
  /** The config schema's form, read once when the definition is erased. */
  readonly configFields: ReadonlyArray<ConnectorConfigField>;
  readonly defaultConfig: () => unknown;
  readonly probe: (config: unknown) => Effect.Effect<ConnectorProbe, ProbeFailed>;
  readonly createInstance: (
    input: CreateInstanceInput<unknown>,
  ) => Effect.Effect<ConnectorInstance, ConnectorError, Scope.Scope>;
}

/**
 * Erases `Config`, decoding the incoming value through the connector's own
 * schema first. A configuration that does not fit fails as `ProbeFailed` or
 * `SpawnFailed` for the operation that needed it, because that is what the
 * connectors page has to show the user either way.
 */
export const eraseConnectorDefinition = <Config>(
  definition: ConnectorDefinition<Config>,
): AnyConnectorDefinition => {
  const decode = Schema.decodeUnknownEffect(definition.configSchema);
  return {
    kind: definition.kind,
    metadata: definition.metadata,
    configFields: settingsFormFields(definition.configSchema),
    defaultConfig: () => definition.defaultConfig(),
    probe: (config) =>
      decode(config).pipe(
        Effect.mapError(
          (error) => new ProbeFailed({ kind: definition.kind, message: error.message }),
        ),
        Effect.flatMap(definition.probe),
      ),
    createInstance: (input) =>
      decode(input.config).pipe(
        Effect.mapError(
          (error): ConnectorError =>
            new SpawnFailed({
              kind: definition.kind,
              instanceId: input.instanceId,
              message: error.message,
            }),
        ),
        Effect.flatMap((config) => definition.createInstance({ ...input, config })),
      ),
  };
};
