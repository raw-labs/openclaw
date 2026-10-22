import type {
  WorkerTunnelHandle,
  WorkerWorkspaceSyncRequest,
} from "./worker-environments/tunnel-contract.js";

class CheckoutTransfer {
  readonly #dispatch: (credential: RepositoryCheckoutCredential) => Promise<void>;
  #used = false;
  constructor(dispatch: (credential: RepositoryCheckoutCredential) => Promise<void>) {
    this.#dispatch = dispatch;
    Object.setPrototypeOf(this, null);
  }
  static async execute(transfer: CheckoutTransfer, credential: RepositoryCheckoutCredential) {
    if (!(#dispatch in transfer) || transfer.#used) {
      throw new Error("Repository checkout transfer is no longer available.");
    }
    transfer.#used = true;
    await transfer.#dispatch(credential);
  }
}
export type RepositoryCheckoutTransfer = CheckoutTransfer;
type RepositoryCheckoutCredential = {
  token?: string;
  assertCurrent: () => void;
  start: <T>(run: () => Promise<T>) => Promise<T>;
};
/** Host-only task binding; plugins cannot replace the accepted source or tunnel. */
export function createRepositoryCheckoutTransfer(
  tunnel: Pick<WorkerTunnelHandle, "syncWorkspace">,
  request: WorkerWorkspaceSyncRequest,
  assertCurrent: () => void,
) {
  let result: Awaited<ReturnType<WorkerTunnelHandle["syncWorkspace"]>> | undefined;
  const transfer = new CheckoutTransfer(async (credential) => {
    const assertLive = () => {
      assertCurrent();
      credential.assertCurrent();
    };
    assertLive();
    result = await credential.start(async () => {
      assertLive();
      const source = request.source;
      if (source.kind !== "repository") {
        throw new Error("Repository checkout requires a repository source.");
      }
      return await tunnel.syncWorkspace({
        ...request,
        source: { ...source, ...(credential.token ? { gitToken: credential.token } : {}) },
        authorize: assertLive,
      });
    });
    assertLive();
  });
  return {
    transfer,
    result() {
      if (!result) {
        throw new Error("Repository source did not dispatch its checkout transfer.");
      }
      return result;
    },
  };
}
/** The credential is consumed only by the task-bound transport and is never returned. */
export async function performRepositoryCheckout(
  transfer: RepositoryCheckoutTransfer,
  credential: RepositoryCheckoutCredential,
): Promise<void> {
  await CheckoutTransfer.execute(transfer, credential);
}
