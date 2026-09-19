import { nodeTokenDir } from "../paths";
import { HookAuth } from "./auth";
import { hookService } from "./service";

/**
 * Mints `<dataDir>/node-tokens/<nodeId>` without needing the hook service.
 *
 * The terminal domain calls this when it creates an agent terminal, and it is
 * the one statement of the hook domain that runs outside it. It does not have
 * to be handed a service, because the token is *derived*: the instance secret
 * is a file, and the same data directory always produces the same token. The
 * running service is preferred all the same, so a core that is already holding
 * the secret does not read it off disk again.
 *
 * Contract §5, item 5: the token itself never travels in the environment. Any
 * process of the same user can read another process' environ, so the PTY is
 * told only where the endpoint file is.
 */
export function issueNodeToken(dataDir: string, nodeId: string): string {
  const service = hookService();
  if (service !== undefined && service.dataDir === dataDir) {
    return service.issueNodeToken(nodeId);
  }
  return HookAuth.load(dataDir).writeNodeToken(nodeTokenDir(dataDir), nodeId);
}
