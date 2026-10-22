import type { ProjectsListResult } from "@openclaw/gateway-protocol";
import type { ControlUiHost, ControlUiTextReferenceProvider } from "openclaw/plugin-sdk/control-ui";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { sessionGitHubRepository } from "./session-pull-request-presentation.ts";
import { githubTextReferenceSnapshot } from "./text-reference-grammar.ts";
import {
  projectGitHubRepositories,
  type MarkdownGitHubRepositoryAliases,
} from "./text-reference-repositories.ts";

/** Alias facts are an observed read projection, not another PR store or RPC owner. */
export function createGitHubTextReferenceProvider(
  host: ControlUiHost,
  runtime: RepositoryBrowserRuntime,
): ControlUiTextReferenceProvider {
  const reads = runtime;
  if (host.connection.readScopeKey === undefined) {
    throw new Error("GitHub text references require the current host's scoped read services.");
  }
  const observers = new Set<() => void>();
  let repositories: readonly MarkdownGitHubRepositoryAliases[] = [];
  let aliasesReady = false;
  let generation = 0;
  let observedScope: string | undefined;
  let stops: (() => void)[] = [];
  const notify = () => observers.forEach((changed) => changed());
  const refresh = () => {
    const attempt = ++generation;
    const connection = host.connection;
    observedScope = connection.readScopeKey;
    repositories = [];
    aliasesReady = false;
    notify();
    if (!connection.connected || !connection.canRead) {
      return;
    }
    void host
      .request<ProjectsListResult>("projects.list", {})
      .then((result) => {
        if (
          attempt !== generation ||
          !observers.size ||
          host.signal.aborted ||
          host.connection.readScopeKey !== connection.readScopeKey
        ) {
          return;
        }
        repositories = projectGitHubRepositories(result.projects);
        aliasesReady = true;
        notify();
      })
      .catch(() => {
        // Failed/retired reads leave names unresolved, never bound to an old repository.
      });
  };
  return {
    id: "github-shorthand",
    readerId: "github",
    // A name cannot fall back to the checkout until current aliases settle.
    snapshot: (target) =>
      githubTextReferenceSnapshot(
        aliasesReady ? sessionGitHubRepository(reads.read(target)) : undefined,
        repositories,
      ),
    observe(target, changed) {
      let live = true;
      observers.add(changed);
      const stopRead = reads.observe(target, changed);
      if (observers.size === 1) {
        stops = [
          host.subscribe(() => {
            if (host.connection.readScopeKey !== observedScope) {
              refresh();
            }
          }),
          host.onEvent("config.changed", refresh),
        ];
        refresh();
      }
      const stop = () => {
        if (!live) {
          return;
        }
        live = false;
        target.signal.removeEventListener("abort", stop);
        observers.delete(changed);
        stopRead();
        if (!observers.size) {
          generation++;
          repositories = [];
          aliasesReady = false;
          stops.forEach((dispose) => dispose());
          stops = [];
        }
      };
      target.signal.addEventListener("abort", stop, { once: true });
      if (target.signal.aborted) {
        stop();
      }
      return stop;
    },
  };
}
