type CommandCall = {
  argv: string[];
  input?: string;
  hooksPath?: string;
  authorizationTarget?: string;
  credentialHelperDisabled?: boolean;
};
/** External GitHub effects only; native authority and SQLite remain in the calling harness. */
export function createPublicationCommandFixture({
  commands,
  commandCalls,
  replies,
  syntheticIndex,
  branch,
  newHead,
  baseHead,
  workspaceTree,
  result,
}: {
  commands: string[][];
  commandCalls: CommandCall[];
  replies: Record<string, [string?, number?]>;
  syntheticIndex: string;
  branch: string;
  newHead: string;
  baseHead: string;
  workspaceTree: string;
  result: (
    stdout?: string,
    code?: number,
  ) => { stdout: Buffer; stderr: Buffer; code: number; signal: null; killed: boolean };
}) {
  let remotePublished = false;
  return async (argv: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => {
    commands.push(argv);
    commandCalls.push({
      argv,
      input: options?.input,
      hooksPath:
        options?.env?.GIT_CONFIG_KEY_0 === "core.hooksPath"
          ? options.env.GIT_CONFIG_VALUE_0
          : undefined,
      authorizationTarget: options?.env?.GIT_CONFIG_KEY_2,
      credentialHelperDisabled:
        options?.env?.GIT_CONFIG_KEY_1 === "credential.helper" &&
        options.env.GIT_CONFIG_VALUE_1 === "",
    });
    const command = argv.join(" ");
    if (command === "gh auth token --hostname github.com") {
      return result("synthetic-publication-credential\n");
    }
    if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/matching-refs/heads/"))) {
      return result(
        JSON.stringify(
          remotePublished ? [{ ref: `refs/heads/${branch}`, object: { sha: newHead } }] : [],
        ),
      );
    }
    if (replies[command]) {
      return result(...replies[command]);
    }

    if (
      command.startsWith(
        "gh api --hostname github.com repos/openclaw/openclaw --jq {fork, default_branch, parent:",
      )
    ) {
      return result('{"fork":false,"default_branch":"main"}\n');
    }
    const baseRefPrefix = "gh api --hostname github.com repos/openclaw/openclaw/git/ref/heads/";
    if (command.startsWith(baseRefPrefix)) {
      const requestedBranch = command.slice(baseRefPrefix.length).split(" --jq", 1)[0];
      return result(JSON.stringify({ ref: `refs/heads/${requestedBranch}`, sha: baseHead }));
    }

    if (argv.includes("--includes") && argv.includes("--get-regexp")) {
      return result("", 1);
    }
    if (command.startsWith("git ls-tree -r -z --full-tree ")) {
      return result();
    }
    if (argv.includes("rev-parse") && argv.includes("--git-path") && argv.at(-1) === "index") {
      return result(syntheticIndex);
    }

    if (
      argv[0] === "git" &&
      argv[1] === "config" &&
      (argv.includes("--global") || argv.includes("--system")) &&
      argv.includes("core.attributesFile")
    ) {
      return result("", 1);
    }
    if (command.endsWith("write-tree")) {
      return result(`${workspaceTree}\n`);
    }

    if (command.startsWith("git commit-tree ")) {
      return result(`${newHead}\n`);
    }

    if (
      command.startsWith(
        "git -c credential.helper= -c credential.helper=!gh auth git-credential ls-remote",
      )
    ) {
      return result(remotePublished ? `${newHead}\trefs/heads/${branch}\n` : "");
    }
    if (argv.includes("push")) {
      remotePublished = true;
      return result();
    }
    if (command.includes(" repos/openclaw/openclaw/pulls ") && command.includes("state=all")) {
      return result("[]\n");
    }
    if (
      command ===
      "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
    ) {
      return result('{"html_url":"https://github.com/openclaw/openclaw/pull/125200"}\n');
    }
    return result();
  };
}
