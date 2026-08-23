// Development and test builds resolve the workspace package here. Rebuild the package and restart
// the server after changing runner internals; the workspace export resolves through dist. The
// server build replaces this compiled shim with the package's built distribution, so published
// server installs do not need a separate paperclip-runner npm bootstrap.
// Keep runtime behavior in the package; this file is only the server build boundary. Native
// driver, adapter, and generated protocol-action changes must be compiled before restarting this
// development boundary; this prevents both stale workspace-package and adapter runtime exports.
export * from "@paperclipai/paperclip-runner";
