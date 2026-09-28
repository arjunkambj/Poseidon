import { makeThreadId } from "@poseidon/contracts/ids";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ConnectorLogger } from "./definition";
import { loadSessionPlugins, type SessionPlugin } from "./plugins";

const threadId = makeThreadId();

const browser: SessionPlugin = {
  name: "browser",
  root: "/home/builtin-plugins/browser",
  builtin: true,
  skills: [{ name: "browser", path: "/home/builtin-plugins/browser/skills/browser" }],
  skillsDirs: ["/home/builtin-plugins/browser/skills"],
  mcpServers: [],
};

const recordingLogger = () => {
  const lines: Array<{ level: string; message: string }> = [];
  const logger: ConnectorLogger = {
    log: (level, message) => Effect.sync(() => void lines.push({ level, message })),
  };
  return { lines, logger };
};

describe("loadSessionPlugins", () => {
  it.effect("answers none when the host lends no registry", () =>
    Effect.gen(function* () {
      const { logger } = recordingLogger();
      expect(yield* loadSessionPlugins({ logger }, threadId)).toEqual([]);
    }),
  );

  it.effect("hands on the registry's plugins for the thread", () =>
    Effect.gen(function* () {
      const { logger } = recordingLogger();
      const asked: Array<string> = [];
      const plugins = yield* loadSessionPlugins(
        {
          logger,
          sessionPlugins: (id) => Effect.sync(() => (asked.push(id), [browser])),
        },
        threadId,
      );
      expect(plugins).toEqual([browser]);
      expect(asked).toEqual([threadId]);
    }),
  );

  it.effect("starts without plugins, with a warning, when the registry dies", () =>
    Effect.gen(function* () {
      const { lines, logger } = recordingLogger();
      const plugins = yield* loadSessionPlugins(
        { logger, sessionPlugins: () => Effect.die(new Error("disk gone")) },
        threadId,
      );
      expect(plugins).toEqual([]);
      expect(lines).toEqual([
        { level: "warn", message: "could not load the session's plugins; starting without them" },
      ]);
    }),
  );
});
