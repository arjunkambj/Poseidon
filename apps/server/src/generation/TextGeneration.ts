/**
 * Generated text: commit messages, pull request text and thread titles, each
 * written by one one-shot `generateText` call on a connector that declares
 * `textGeneration`.
 *
 * The service never names a harness. `resolveWriter` picks the instance and
 * model from the settings and the thread, `gitContext` reads the change,
 * `prompts` builds what is sent and `parse` reads what comes back. Every call
 * is bounded by `GENERATION_TIMEOUT`, and interrupting it — a client that
 * cancels, a server shutting down — interrupts the connector's call, which
 * stops its process.
 *
 * `regenerateTitle` is the user asking, so it renames unconditionally through
 * `thread.rename`. `autoTitle` is the server's own idea: it renames only while
 * the title is still the default, checked inside the write, so a rename the
 * user made while it ran always wins.
 */

import { makeCommandId, makeEventId } from "@poseidon/contracts/ids";
import type { ConnectorInstanceId, ProjectId, ThreadId } from "@poseidon/contracts/ids";
import type { ConnectorError } from "@poseidon/connector-sdk/definition";
import { PoseidonRpcError } from "@poseidon/contracts/rpc";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFAULT_THREAD_TITLE } from "../orchestration/decider";
import { OrchestrationEngine } from "../orchestration/Engine";
import { worktreeOf, type ThreadDoc } from "../orchestration/state";
import { resolveWorkspaceRoot } from "../orchestration/workspaceRoot";
import type { PlannedEvent } from "../persistence/EventStore";
import { ReadModelStore } from "../persistence/ReadModels";
import { ConnectorCatalog, SettingsStore } from "../rpc/services";
import { ConnectorRegistryService } from "../settings/ConnectorManager";
import { UnrunnableConnectors } from "../settings/connectorRouting";
import { commitContext, pullRequestBase, pullRequestContext, styleContext } from "./gitContext";
import { parseCommitMessage, parsePullRequest, parseTitle } from "./parse";
import {
  commitPrompt,
  findPullRequestTemplate,
  pullRequestPrompt,
  SUMMARY_CAP,
  capText,
  titlePrompt,
  type GenerationPrompt,
} from "./prompts";
import { resolveWriter, routedPick, type Writer, type WriterDeps } from "./resolveWriter";

/** How long one piece of text may take before it is given up on. */
const GENERATION_TIMEOUT = Duration.seconds(120);

const unavailable = (message: string) => new PoseidonRpcError({ code: "unavailable", message });
const invalid = (message: string) => new PoseidonRpcError({ code: "invalid", message });

/** Only the `notice` key when there is one, so an absent notice is absent on the wire. */
const noticeOf = (writer: Writer) => (writer.notice === undefined ? {} : { notice: writer.notice });

/** A connector's refusal in words a toast can show. */
const connectorFailure = (error: ConnectorError): PoseidonRpcError => {
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return unavailable(
    message.trim() === "" ? `Couldn't write the text (${error._tag}).` : message.trim(),
  );
};

/** What a scope that cannot be resolved answers. */
const unknownProject = (projectId: ProjectId) =>
  new PoseidonRpcError({ code: "not-found", message: `project ${projectId} does not exist` });

/** The thread's user and assistant text, oldest first, as the title prompt reads it. */
const conversationOf = (doc: Pick<ThreadDoc, "items">): string =>
  doc.items
    .flatMap((item) => {
      const text = item.text?.trim() ?? "";
      if (text === "") return [];
      if (item.kind === "user_message") return [`User: ${text}`];
      if (item.kind === "assistant_message") return [`Assistant: ${text}`];
      return [];
    })
    .join("\n\n");

export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    readonly generateCommitMessage: (input: {
      readonly projectId: ProjectId;
      readonly threadId?: ThreadId | undefined;
      readonly paths?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<
      { readonly subject: string; readonly body: string; readonly notice?: string },
      PoseidonRpcError
    >;
    readonly generatePullRequest: (input: {
      readonly projectId: ProjectId;
      readonly threadId?: ThreadId | undefined;
      readonly base?: string | undefined;
    }) => Effect.Effect<
      { readonly title: string; readonly body: string; readonly notice?: string },
      PoseidonRpcError
    >;
    /** A title from the end of the conversation, applied with `thread.rename`. */
    readonly regenerateTitle: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly title: string; readonly notice?: string }, PoseidonRpcError>;
    /**
     * A title from the thread's first message, applied only while the thread
     * still has the default title. Fails like the others; its caller is the
     * reactor, which keeps every failure to the log.
     */
    readonly autoTitle: (
      threadId: ThreadId,
      firstMessage: string,
    ) => Effect.Effect<void, PoseidonRpcError>;
  }
>()("server/generation/TextGeneration") {
  /** Every call answers `unavailable`: for a server graph with no connector behind it. */
  static readonly unavailable = Layer.succeed(
    TextGeneration,
    TextGeneration.of({
      generateCommitMessage: () => Effect.fail(unavailable("Text generation is not available.")),
      generatePullRequest: () => Effect.fail(unavailable("Text generation is not available.")),
      regenerateTitle: () => Effect.fail(unavailable("Text generation is not available.")),
      autoTitle: () => Effect.fail(unavailable("Text generation is not available.")),
    }),
  );

  static readonly layer = Layer.effect(
    TextGeneration,
    Effect.gen(function* () {
      const settings = yield* SettingsStore;
      const registry = yield* ConnectorRegistryService;
      const catalog = yield* ConnectorCatalog;
      const readModels = yield* ReadModelStore;
      const engine = yield* OrchestrationEngine;
      const sql = yield* SqlClient.SqlClient;
      const unrunnable = yield* UnrunnableConnectors;

      const openIds = Effect.map(registry.instances, (all) =>
        all.map((instance) => instance.instanceId),
      );
      const deps: WriterDeps = {
        instance: (instanceId) =>
          registry.instance(instanceId).pipe(Effect.catch(() => Effect.succeed(null))),
        models: (instanceId) => catalog.models(instanceId),
        routed: routedPick(
          sql,
          openIds,
          (instanceId: ConnectorInstanceId) =>
            Effect.map(catalog.models(instanceId), (models) => models.map((model) => model.id)),
          unrunnable === null ? null : Ref.get(unrunnable),
        ),
      };

      const sqlFailure = () =>
        new PoseidonRpcError({ code: "internal", message: "internal error" });

      const liveThread = (threadId: ThreadId) =>
        engine.threadDoc(threadId).pipe(
          Effect.mapError(sqlFailure),
          Effect.map((doc) => (doc === null || doc.deleted ? null : doc)),
        );

      /** The thread when it is a live one of this project, else none. */
      const threadOf = (projectId: ProjectId, threadId: ThreadId | undefined) =>
        threadId === undefined
          ? Effect.succeed(null)
          : Effect.map(liveThread(threadId), (doc) => (doc?.projectId === projectId ? doc : null));

      const rootOf = (projectId: ProjectId, threadId: ThreadId | undefined) =>
        resolveWorkspaceRoot(readModels, projectId, threadId).pipe(
          Effect.mapError(sqlFailure),
          Effect.flatMap((root) =>
            root === null ? Effect.fail(unknownProject(projectId)) : Effect.succeed(root),
          ),
        );

      const writerFor = (thread: ThreadDoc | null) =>
        Effect.flatMap(settings.get, (doc) => resolveWriter(doc, thread, deps));

      /** One call to the writer, bounded by the timeout; the harness's text as it came. */
      const write = (writer: Writer, prompt: GenerationPrompt) =>
        writer.instance
          .generateText({
            prompt: prompt.prompt,
            system: prompt.system,
            model: writer.model,
            jsonSchema: prompt.jsonSchema,
            ...(writer.effort === undefined ? {} : { effort: writer.effort }),
          })
          .pipe(
            Effect.mapError(connectorFailure),
            Effect.timeoutOrElse({
              duration: GENERATION_TIMEOUT,
              orElse: () =>
                Effect.fail(unavailable("Writing took longer than two minutes and was stopped.")),
            }),
          );

      const unusable = () => unavailable("The model's answer had no usable text.");

      /** A title for the thread from `conversation`, and who wrote it. */
      const titleFor = (thread: ThreadDoc, conversation: string) =>
        Effect.gen(function* () {
          const writer = yield* writerFor(thread);
          const title = parseTitle(yield* write(writer, titlePrompt(conversation)));
          if (title === null) {
            return yield* Effect.fail(unusable());
          }
          return { title, writer };
        });

      return TextGeneration.of({
        generateCommitMessage: ({ projectId, threadId, paths }) =>
          Effect.gen(function* () {
            const root = yield* rootOf(projectId, threadId);
            const thread = yield* threadOf(projectId, threadId);
            const change = yield* commitContext(root, paths);
            const style = yield* styleContext(root, (yield* settings.get).git);
            const writer = yield* writerFor(thread);
            const parsed = parseCommitMessage(
              yield* write(writer, commitPrompt({ style, ...change })),
            );
            if (parsed === null) {
              return yield* Effect.fail(unusable());
            }
            return { ...parsed, ...noticeOf(writer) };
          }).pipe(Effect.mapError(asRpcError)),

        generatePullRequest: ({ projectId, threadId, base }) =>
          Effect.gen(function* () {
            const root = yield* rootOf(projectId, threadId);
            const thread = yield* threadOf(projectId, threadId);
            const target = yield* pullRequestBase(
              root,
              base,
              thread === null ? undefined : worktreeOf(thread)?.baseBranch,
            );
            const change = yield* pullRequestContext(root, target);
            const { git } = yield* settings.get;
            const style = yield* styleContext(root, git);
            const template = git.followPrTemplate ? findPullRequestTemplate(root) : null;
            const writer = yield* writerFor(thread);
            const parsed = parsePullRequest(
              yield* write(writer, pullRequestPrompt({ style, template, ...change })),
            );
            if (parsed === null) {
              return yield* Effect.fail(unusable());
            }
            return { ...parsed, ...noticeOf(writer) };
          }).pipe(Effect.mapError(asRpcError)),

        regenerateTitle: (threadId) =>
          Effect.gen(function* () {
            const thread = yield* liveThread(threadId);
            if (thread === null) {
              return yield* Effect.fail(
                new PoseidonRpcError({
                  code: "not-found",
                  message: `thread ${threadId} does not exist`,
                }),
              );
            }
            const conversation = conversationOf(thread);
            if (conversation === "") {
              return yield* Effect.fail(invalid("The thread has no messages to name it from yet."));
            }
            const { title, writer } = yield* titleFor(thread, conversation);
            const receipt = yield* engine
              .dispatch({
                commandId: makeCommandId(),
                createdAt: new Date().toISOString(),
                type: "thread.rename",
                threadId,
                title,
              })
              .pipe(Effect.mapError(sqlFailure));
            if (receipt.status === "rejected") {
              return yield* Effect.fail(
                new PoseidonRpcError({
                  code: "not-found",
                  message: receipt.reason ?? `thread ${threadId} does not exist`,
                }),
              );
            }
            return { title, ...noticeOf(writer) };
          }),

        autoTitle: (threadId, firstMessage) =>
          Effect.gen(function* () {
            const thread = yield* liveThread(threadId);
            if (thread === null || thread.title !== DEFAULT_THREAD_TITLE) {
              return;
            }
            const { title } = yield* titleFor(
              thread,
              `User: ${capText(firstMessage.trim(), SUMMARY_CAP)}`,
            );
            // Checked again inside the write: a rename that landed while the
            // model was writing is the user's, and it stands.
            yield* engine
              .appendThreadEvents(threadId, (doc) =>
                doc.title === DEFAULT_THREAD_TITLE ? [renamedEvent(threadId, title)] : [],
              )
              .pipe(Effect.mapError(sqlFailure));
          }),
      });
    }),
  );
}

/** A classified refusal passes through; an unexpected git failure is `internal`. */
const asRpcError = (error: PoseidonRpcError | { readonly message: string }): PoseidonRpcError =>
  error instanceof PoseidonRpcError
    ? error
    : new PoseidonRpcError({ code: "internal", message: error.message });

/** The server's own rename, recorded as the system's rather than the user's. */
const renamedEvent = (threadId: ThreadId, title: string): PlannedEvent =>
  ({
    eventId: makeEventId(),
    streamKind: "thread",
    streamId: threadId,
    occurredAt: new Date().toISOString(),
    actor: "system",
    type: "thread.renamed",
    payload: { title },
  }) as PlannedEvent;
