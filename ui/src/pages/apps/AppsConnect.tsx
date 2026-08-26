import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";

export {
  AccessStep,
  OAuthConnectStateScreen,
  type OAuthConnectPhase,
} from "@/features/connections/ConnectionSetupFlow";

/** Full-page host for the shared connection setup implementation. */
export function AppsConnect({ byoOnly = false }: { byoOnly?: boolean } = {}) {
  return <ConnectionSetupFlow byoOnly={byoOnly} host="page" />;
}
