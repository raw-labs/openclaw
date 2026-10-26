type WorkerCredential = {
  token: string;
  login: string;
  remoteUrl?: string;
  gitAuthor?: { name?: string; email?: string };
  expiresAtMs?: number;
};

/** One-use delivery into an already admitted worker launch or credential refresh. */
export class RepositoryWorkerIdentityTransfer {
  #used = false;
  #receive: (credential: WorkerCredential, assertCurrent: () => void) => Promise<void>;
  constructor(receive: (credential: WorkerCredential, assertCurrent: () => void) => Promise<void>) {
    this.#receive = receive;
  }
  async perform(credential: WorkerCredential, assertCurrent: () => void) {
    if (this.#used) {
      throw new Error("Worker identity transfer was already consumed.");
    }
    this.#used = true;
    assertCurrent();
    await this.#receive(credential, assertCurrent);
    assertCurrent();
  }
}

export async function performRepositoryWorkerIdentity(
  transfer: RepositoryWorkerIdentityTransfer,
  credential: WorkerCredential,
  assertCurrent: () => void,
) {
  await transfer.perform(credential, assertCurrent);
}
